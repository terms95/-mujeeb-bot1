import crypto from 'node:crypto';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import type { AutoReplyRule, CachedAiReply } from '../src/types/facebook.ts';
import type { StoreData } from './store.ts';
import { normalizeArabicText, renderReplyTemplate } from './replyEngine.ts';

const AI_MODEL = 'gemini-4-hydrogen';

let cachedClient: GoogleGenAI | null = null;
const postImageCache = new Map<string, { mimeType: string; data: string; cachedAt: number }>();

async function fetchImagePart(
  imageUrl?: string
): Promise<{ inlineData: { mimeType: string; data: string } } | null> {
  if (!imageUrl || !/^https?:\/\//i.test(imageUrl)) return null;

  const existing = postImageCache.get(imageUrl);
  if (existing && Date.now() - existing.cachedAt < 15 * 60 * 1000) {
    return { inlineData: { mimeType: existing.mimeType, data: existing.data } };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(imageUrl, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return null;

    const contentType = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!contentType.startsWith('image/')) return null;

    const arrayBuf = await res.arrayBuffer();
    if (arrayBuf.byteLength === 0 || arrayBuf.byteLength > 4 * 1024 * 1024) {
      return null;
    }

    const base64 = Buffer.from(arrayBuf).toString('base64');
    if (postImageCache.size >= 30) {
      const oldestKey = postImageCache.keys().next().value;
      if (oldestKey) postImageCache.delete(oldestKey);
    }
    postImageCache.set(imageUrl, { mimeType: contentType, data: base64, cachedAt: Date.now() });
    return { inlineData: { mimeType: contentType, data: base64 } };
  } catch {
    return null;
  }
}

function getAiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    return null;
  }
  if (!cachedClient) {
    cachedClient = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  }
  return cachedClient;
}

export function isAiConfigured(): boolean {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  return Boolean(apiKey && apiKey !== 'MY_GEMINI_API_KEY');
}

function tokenizeArabic(text: string): string[] {
  const normalized = normalizeArabicText(text);
  if (!normalized) return [];
  const rawTokens = normalized.split(' ').filter(Boolean);
  const meaningful = rawTokens.filter((t) => t.length >= 2);
  return Array.from(new Set(meaningful.length > 0 ? meaningful : rawTokens));
}

function replaceFirstNameWithPlaceholder(
  reply: string,
  commenterName: string,
  pageName: string
): string {
  const firstName = commenterName.trim().split(/\s+/)[0] || '';
  let templatized = reply;
  if (firstName && firstName.length >= 2) {
    templatized = templatized.split(firstName).join('{name}');
  }
  if (pageName && pageName.length >= 2) {
    templatized = templatized.split(pageName).join('{page}');
  }
  return templatized;
}

export function findBestCachedAiReply(
  commentText: string,
  ruleId: string,
  pageId: string,
  postId: string | undefined,
  postMessage: string | undefined,
  cache: CachedAiReply[]
): CachedAiReply | null {
  if (cache.length === 0) return null;

  const hasSpecificPost = Boolean(postId && postId !== 'all' && postId !== 'unknown');
  const postNorm = postMessage ? normalizeArabicText(postMessage.slice(0, 120)) : '';

  // Strictly scope cached replies to the SAME post so riddle/topic answers never leak across posts
  const eligible = cache.filter((entry) => {
    if (hasSpecificPost) {
      if (entry.postId) {
        return entry.postId === postId;
      }
      if (postNorm && entry.postSnippet) {
        return normalizeArabicText(entry.postSnippet) === postNorm;
      }
      return false;
    }
    return entry.pageId === pageId;
  });

  if (eligible.length === 0) return null;

  const incomingNorm = normalizeArabicText(commentText);
  const incomingTokens = tokenizeArabic(commentText);
  const incomingSet = new Set(incomingTokens);

  let bestEntry: CachedAiReply | null = null;
  let bestScore = -1;

  for (const entry of eligible) {
    let score = 0;

    if (normalizeArabicText(entry.commentText) === incomingNorm && incomingNorm.length > 0) {
      score += 120;
    }

    if (incomingSet.size > 0 && entry.tokens.length > 0) {
      let overlap = 0;
      for (const tok of entry.tokens) {
        if (incomingSet.has(tok)) overlap += 1;
      }
      const unionSize = new Set([...incomingTokens, ...entry.tokens]).size;
      const jaccard = unionSize > 0 ? overlap / unionSize : 0;
      score += jaccard * 60 + overlap * 8;
    }

    if (entry.ruleId === ruleId) score += 25;
    if (entry.pageId === pageId) score += 10;

    // Slight preference for fresher / less overused replies when scores tie
    score += Math.max(0, 5 - Math.min(entry.useCount, 5)) * 0.2;

    if (score > bestScore) {
      bestScore = score;
      bestEntry = entry;
    }
  }

  return bestEntry;
}

export interface AiReplyResolution {
  publicReplyText: string;
  privateReplyText: string;
  replySource: 'ai' | 'ai-cache' | 'fallback';
  note?: string;
}

function parseAiJsonPayload(
  rawText: string,
  wantPrivateReply: boolean
): { publicReply: string; privateReply: string } | null {
  const cleaned = rawText
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  if (!cleaned) return null;

  const tryParse = (candidate: string): { publicReply: string; privateReply: string } | null => {
    try {
      const parsed = JSON.parse(candidate) as { publicReply?: unknown; privateReply?: unknown };
      if (parsed && typeof parsed === 'object') {
        const pub = typeof parsed.publicReply === 'string' ? parsed.publicReply.trim() : '';
        const priv =
          wantPrivateReply && typeof parsed.privateReply === 'string'
            ? parsed.privateReply.trim()
            : '';
        if (pub || priv) {
          return { publicReply: pub, privateReply: priv };
        }
      }
    } catch {
      // ignore parse failure
    }
    return null;
  };

  const direct = tryParse(cleaned);
  if (direct) return direct;

  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const sliced = tryParse(cleaned.slice(firstBrace, lastBrace + 1));
    if (sliced) return sliced;
  }

  // If the model returned clean plain Arabic text instead of JSON, use it directly
  if (!cleaned.startsWith('{') && cleaned.length >= 2) {
    return { publicReply: cleaned.slice(0, 600), privateReply: '' };
  }

  return null;
}

function isQuotaOrAuthError(errMsg: string): boolean {
  return /429|resource_exhausted|quota|rate limit|too many requests|403|permission_denied|401|api_key|api key/i.test(
    errMsg
  );
}

export async function generateAiOrCachedReply(params: {
  rule: AutoReplyRule;
  pageId: string;
  pageName: string;
  postId?: string;
  postMessage?: string;
  postImageUrl?: string;
  commenterName: string;
  commentText: string;
  wantPrivateReply: boolean;
  store: StoreData;
}): Promise<AiReplyResolution> {
  const {
    rule,
    pageId,
    pageName,
    postId,
    postMessage,
    postImageUrl,
    commenterName,
    commentText,
    wantPrivateReply,
    store,
  } = params;
  const nowMs = Date.now();
  const cooldownMs = store.aiStatus.cooldownUntil
    ? new Date(store.aiStatus.cooldownUntil).getTime()
    : 0;
  const inCooldown = cooldownMs > nowMs;

  const client = getAiClient();

  if (client && !inCooldown) {
    const systemInstruction = [
      `أنت مسؤول خدمة عملاء وتفاعل محترف لصفحة فيسبوك باسم "${pageName}".`,
      'مهمتك كتابة رد قصير وودود ودقيق باللغة العربية يتناسب تماماً مع هذا المنشور المحدد وتعليق العميل.',
      'قواعد الدقة والالتزام بالمنشور:',
      '1) اعتمد حصراً على محتوى هذا المنشور المحدد (النص والصورة المرفقة إن وجدت) وتعليق العميل، ولا تفترض أو تخلط أي معلومات من منشورات أخرى.',
      '2) إذا كان المنشور لغزاً (رياضياً أو جغرافياً أو ثقافياً أو سؤالاً): حل اللغز بنفسك بدقة من نص أو صورة هذا المنشور أولاً، ثم قيّم تعليق العميل: إذا كانت إجابته صحيحة فهنئه وأكد صحتها، وإذا كانت خاطئة فشجعه بلباقة أو صححها وفق إرشادات القاعدة، وإذا سأل عن الإجابة فاذكر الحل الصحيح لهذا المنشور فقط.',
      '3) استخدم اسم العميل الأول بشكل لطيف عند المناسبة، واجعل الرد مختصراً وطبيعياً دون إطالة.',
      rule.aiPrompt?.trim()
        ? `إرشادات ومعلومات الصفحة والقاعدة:\n${rule.aiPrompt.trim()}`
        : 'أجب بلباقة ودقة واختصار وبما يطابق موضوع المنشور والتعليق.',
      wantPrivateReply
        ? 'قم أيضاً بكتابة رسالة خاصة مختصرة ومفيدة لإرسالها في ماسنجر في حقل privateReply.'
        : 'اترك حقل privateReply نصاً فارغاً "".',
    ].join('\n\n');

    const promptParts = [
      postId ? `معرّف المنشور: ${postId}` : '',
      postMessage?.trim()
        ? `نص هذا المنشور: "${postMessage.trim().slice(0, 1200)}"`
        : 'ملاحظة: هذا المنشور بدون نص تفصيلي، اعتمد على الصورة المرفقة (إن وجدت) ونص التعليق.',
      `اسم المعلّق: ${commenterName}`,
      `تعليق العميل على هذا المنشور: "${commentText}"`,
    ].filter(Boolean);
    const promptText = promptParts.join('\n');
    const imagePart = await fetchImagePart(postImageUrl);
    const contents = imagePart
      ? { parts: [imagePart, { text: promptText }] }
      : promptText;

    let lastErrMsg = '';
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const aiPromise = client.models.generateContent({
          model: AI_MODEL,
          contents,
          config: {
            systemInstruction,
            thinkingConfig: { thinkingLevel: ThinkingLevel.MEDIUM },
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                publicReply: {
                  type: Type.STRING,
                  description: 'الرد العام المختصر والدقيق على تعليق فيسبوك',
                },
                privateReply: {
                  type: Type.STRING,
                  description: 'الرسالة الخاصة في ماسنجر أو نص فارغ إذا لم تُطلب',
                },
              },
              required: ['publicReply', 'privateReply'],
            },
          },
        });

        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        const response = await Promise.race([
          aiPromise,
          new Promise<never>((_, reject) => {
            timeoutId = setTimeout(
              () => reject(new Error('انتهت مهلة استجابة الذكاء الاصطناعي (18ث)')),
              18000
            );
          }),
        ]).finally(() => {
          if (timeoutId) clearTimeout(timeoutId);
        });

        const parsed = parseAiJsonPayload(response.text ?? '', wantPrivateReply);
        if (parsed && (parsed.publicReply || parsed.privateReply)) {
          const generatedPublic = parsed.publicReply;
          const generatedPrivate = parsed.privateReply;

          // AI succeeded -> clear cooldown & increment counter
          store.aiStatus.cooldownUntil = undefined;
          store.aiStatus.lastError = undefined;
          store.aiStatus.consecutiveQuotaHits = 0;
          store.aiStatus.totalAiGenerated += 1;

          // Cache generalized reply template scoped strictly to this postId
          const cachedEntry: CachedAiReply = {
            id: `aic_${crypto.randomUUID().slice(0, 8)}`,
            ruleId: rule.id,
            pageId,
            postId,
            postSnippet: postMessage?.trim() ? postMessage.trim().slice(0, 120) : undefined,
            commentText,
            tokens: tokenizeArabic(commentText),
            publicReply: replaceFirstNameWithPlaceholder(generatedPublic, commenterName, pageName),
            privateReply: generatedPrivate
              ? replaceFirstNameWithPlaceholder(generatedPrivate, commenterName, pageName)
              : undefined,
            useCount: 0,
            createdAt: new Date().toISOString(),
          };

          const existsSame = store.aiReplyCache.some(
            (item) =>
              item.ruleId === rule.id &&
              (item.postId || '') === (postId || '') &&
              normalizeArabicText(item.commentText) === normalizeArabicText(commentText) &&
              item.publicReply === cachedEntry.publicReply
          );
          if (!existsSame) {
            store.aiReplyCache.unshift(cachedEntry);
          }

          return {
            publicReplyText: generatedPublic,
            privateReplyText: generatedPrivate,
            replySource: 'ai',
          };
        }

        lastErrMsg = 'لم يرد نموذج الذكاء الاصطناعي بنص قابل للاستخدام';
      } catch (err) {
        lastErrMsg = err instanceof Error ? err.message : String(err);
        if (isQuotaOrAuthError(lastErrMsg)) {
          break;
        }
      }

      if (attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, 1200));
      }
    }

    if (lastErrMsg) {
      store.aiStatus.lastError = lastErrMsg.slice(0, 180);
      if (isQuotaOrAuthError(lastErrMsg)) {
        const hits = (store.aiStatus.consecutiveQuotaHits || 0) + 1;
        // Progressive cooldown: 20s, 45s, 90s, max 180s (only on rate-limit/quota/auth errors)
        const waitSec = Math.min(20 * Math.pow(2, hits - 1), 180);
        store.aiStatus.consecutiveQuotaHits = hits;
        store.aiStatus.cooldownUntil = new Date(Date.now() + waitSec * 1000).toISOString();
      }
    }
  }

  // Fallback 1: Best-matching cached AI reply ONLY from the exact same post
  const cachedMatch = findBestCachedAiReply(
    commentText,
    rule.id,
    pageId,
    postId,
    postMessage,
    store.aiReplyCache
  );
  if (cachedMatch) {
    cachedMatch.useCount += 1;
    store.aiStatus.totalCacheServed += 1;

    const publicFromCache = cachedMatch.publicReply
      ? renderReplyTemplate(cachedMatch.publicReply, commenterName, pageName, {
          ruleId: rule.id,
          scope: 'public',
          history: store.spintaxHistory,
        })
      : '';
    const privateFromCache =
      wantPrivateReply && cachedMatch.privateReply
        ? renderReplyTemplate(cachedMatch.privateReply, commenterName, pageName, {
            ruleId: rule.id,
            scope: 'private',
            history: store.spintaxHistory,
          })
        : '';

    return {
      publicReplyText: publicFromCache,
      privateReplyText: privateFromCache,
      replySource: 'ai-cache',
      note: inCooldown
        ? 'تم الرد من الذاكرة المخزنة مؤقتاً لحين عودة الذكاء الاصطناعي'
        : 'تم الرد من الذاكرة المخزنة للذكاء الاصطناعي',
    };
  }

  // Fallback 2: Rule's static fallback templates (if configured) or polite default
  const fallbackTemplate =
    rule.publicReplies.map((r) => r.trim()).find(Boolean) ||
    'أهلاً بك {name}، شكراً لتواصلك مع {page}! سيتواصل معك فريقنا بالتفاصيل قريباً.';

  const fallbackPublic = renderReplyTemplate(fallbackTemplate, commenterName, pageName, {
    ruleId: rule.id,
    scope: 'public',
    history: store.spintaxHistory,
  });

  const fallbackPrivate =
    wantPrivateReply && rule.privateReplyText.trim()
      ? renderReplyTemplate(rule.privateReplyText.trim(), commenterName, pageName, {
          ruleId: rule.id,
          scope: 'private',
          history: store.spintaxHistory,
        })
      : '';

  return {
    publicReplyText: fallbackPublic,
    privateReplyText: fallbackPrivate,
    replySource: 'fallback',
    note: 'تم استخدام الرد الاحتياطي لعدم توفر ردود مخزنة بعد',
  };
}
