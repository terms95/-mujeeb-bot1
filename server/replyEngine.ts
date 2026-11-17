import crypto from 'node:crypto';
import type { AutoReplyRule, ReplyLogEntry } from '../src/types/facebook.ts';
import type { RotationState, StoreData, StoredFacebookPage } from './store.ts';
import { readStore, writeStore } from './store.ts';
import { generateAiOrCachedReply } from './aiEngine.ts';

const GRAPH_VERSION = 'v21.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

export function normalizeArabicText(input: string): string {
  return input
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670]/g, '') // remove tashkeel
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function matchCommentAgainstRules(
  commentText: string,
  pageId: string,
  postId: string,
  rules: AutoReplyRule[]
): AutoReplyRule | null {
  const normalizedComment = normalizeArabicText(commentText);

  const candidates = rules
    .filter((rule) => {
      if (!rule.enabled) return false;
      if (rule.pageId !== 'all' && rule.pageId !== pageId) return false;
      if (rule.postId !== 'all' && rule.postId !== postId) return false;
      return true;
    })
    .sort((a, b) => {
      // Specific post rules take precedence over all-posts rules
      const aSpecificPost = a.postId !== 'all' ? 1 : 0;
      const bSpecificPost = b.postId !== 'all' ? 1 : 0;
      if (aSpecificPost !== bSpecificPost) return bSpecificPost - aSpecificPost;
      // Specific page rules take precedence over all-pages rules
      const aSpecificPage = a.pageId !== 'all' ? 1 : 0;
      const bSpecificPage = b.pageId !== 'all' ? 1 : 0;
      if (aSpecificPage !== bSpecificPage) return bSpecificPage - aSpecificPage;
      // Higher priority first
      if (b.priority !== a.priority) return b.priority - a.priority;
      // Most recently updated rule wins on equal priority & specificity
      const timeDiff =
        new Date(b.updatedAt || b.createdAt || 0).getTime() -
        new Date(a.updatedAt || a.createdAt || 0).getTime();
      if (timeDiff !== 0) return timeDiff;
      return (b.replyType === 'ai' ? 1 : 0) - (a.replyType === 'ai' ? 1 : 0);
    });

  for (const rule of candidates) {
    // Check negative keywords first
    const excluded = rule.excludeKeywords.some((kw) => {
      const normalizedKw = normalizeArabicText(kw);
      return normalizedKw.length > 0 && normalizedComment.includes(normalizedKw);
    });
    if (excluded) continue;

    if (rule.matchMode === 'any') {
      return rule;
    }

    const validKeywords = rule.keywords
      .map((kw) => normalizeArabicText(kw))
      .filter((kw) => kw.length > 0);

    if (validKeywords.length === 0) continue;

    if (rule.matchMode === 'exact') {
      if (validKeywords.some((kw) => normalizedComment === kw)) {
        return rule;
      }
    } else {
      // contains
      if (validKeywords.some((kw) => normalizedComment.includes(kw))) {
        return rule;
      }
    }
  }

  return null;
}

function pickNonRepeatingRandom(
  key: string,
  rawOptions: string[],
  history?: Record<string, RotationState>
): string {
  const uniqueOptions = Array.from(
    new Set(rawOptions.map((opt) => opt.trim()).filter((opt) => opt.length > 0))
  );
  if (uniqueOptions.length === 0) return '';
  if (uniqueOptions.length === 1) return uniqueOptions[0];

  if (!history) {
    return uniqueOptions[Math.floor(Math.random() * uniqueOptions.length)];
  }

  const state = history[key];
  let pool = Array.isArray(state?.remaining)
    ? state.remaining.filter((opt) => uniqueOptions.includes(opt))
    : [];

  if (pool.length === 0) {
    // Refill with all options except lastPicked so consecutive cycles never repeat back-to-back
    const withoutLast = state?.lastPicked
      ? uniqueOptions.filter((opt) => opt !== state.lastPicked)
      : uniqueOptions;
    pool = withoutLast.length > 0 ? withoutLast : [...uniqueOptions];
  }

  const chosenIndex = Math.floor(Math.random() * pool.length);
  const chosen = pool[chosenIndex];
  history[key] = {
    remaining: pool.filter((_, idx) => idx !== chosenIndex),
    lastPicked: chosen,
  };

  return chosen;
}

export function resolveSpintax(
  text: string,
  ruleId: string,
  scope: 'public' | 'private',
  history?: Record<string, RotationState>
): string {
  let result = text;
  const spintaxPattern = /\{([^{}]*\|[^{}]*)\}/g;

  for (let pass = 0; pass < 10; pass += 1) {
    if (!spintaxPattern.test(result)) break;
    spintaxPattern.lastIndex = 0;

    result = result.replace(spintaxPattern, (_match, inner: string) => {
      const options = inner.split('|');
      const key = `${ruleId}:${scope}:${inner}`;
      return pickNonRepeatingRandom(key, options, history);
    });
  }

  // Fallback for unclosed Spintax block (e.g. missing trailing "}" or truncated entry)
  const unclosedTrailingPattern = /\{([^{}]*\|[^{}]*)$/;
  if (unclosedTrailingPattern.test(result)) {
    result = result.replace(unclosedTrailingPattern, (_match, inner: string) => {
      const options = inner.split('|');
      const key = `${ruleId}:${scope}:${inner}`;
      return pickNonRepeatingRandom(key, options, history);
    });
  }

  // Fallback for missing opening brace before "|" and "}"
  const unclosedLeadingPattern = /^([^{}]*\|[^{}]*)\}/;
  if (unclosedLeadingPattern.test(result)) {
    result = result.replace(unclosedLeadingPattern, (_match, inner: string) => {
      const options = inner.split('|');
      const key = `${ruleId}:${scope}:${inner}`;
      return pickNonRepeatingRandom(key, options, history);
    });
  }

  return result;
}

function sanitizeTemplateValue(value: string): string {
  return value.replace(/[{|}]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function renderReplyTemplate(
  template: string,
  commenterName: string,
  pageName: string,
  options?: {
    ruleId: string;
    scope: 'public' | 'private';
    history?: Record<string, RotationState>;
  }
): string {
  const safeFullName = sanitizeTemplateValue(commenterName) || 'صديقنا';
  const firstName = safeFullName.split(/\s+/)[0] || 'صديقنا';
  const safePageName = sanitizeTemplateValue(pageName) || pageName;

  const withVars = template
    .replace(/\{name\}/gi, firstName)
    .replace(/\{full_name\}/gi, safeFullName)
    .replace(/\{page\}/gi, safePageName);

  if (!options) {
    return resolveSpintax(withVars, 'preview', 'public');
  }

  return resolveSpintax(withVars, options.ruleId, options.scope, options.history);
}

function pickPublicReply(
  rule: AutoReplyRule,
  history?: Record<string, RotationState>
): string {
  const options = rule.publicReplies.map((r) => r.trim()).filter(Boolean);
  if (options.length === 0) return '';
  return pickNonRepeatingRandom(`${rule.id}:public_variations`, options, history);
}

const DEFAULT_LIVE_REPLY_DELAY_MS = 15000;
const lastReplyCompletedAtByPage = new Map<string, number>();
let lastGlobalReplyCompletedAt = 0;
let timestampsSeeded = false;
let globalLiveReplyQueue: Promise<unknown> = Promise.resolve();
let queuedLiveReplies = 0;

export interface LiveExecutionSnapshot {
  busy: boolean;
  phase: 'idle' | 'waiting' | 'sending';
  pageId?: string;
  pageName?: string;
  commenterName?: string;
  commentText?: string;
  waitUntilMs?: number;
  queuedCount: number;
}

let activeExecution: Omit<LiveExecutionSnapshot, 'queuedCount'> = {
  busy: false,
  phase: 'idle',
};

export function getLiveExecutionSnapshot(): LiveExecutionSnapshot {
  return {
    ...activeExecution,
    queuedCount: queuedLiveReplies,
  };
}

function ensurePageTimestampsSeeded(): void {
  if (timestampsSeeded) return;
  timestampsSeeded = true;
  try {
    const store = readStore();
    for (const log of store.logs) {
      if (log.source !== 'tester' && (log.status === 'replied' || log.status === 'failed')) {
        const ms = new Date(log.createdAt).getTime();
        if (!Number.isNaN(ms)) {
          const prev = lastReplyCompletedAtByPage.get(log.pageId) ?? 0;
          if (ms > prev) lastReplyCompletedAtByPage.set(log.pageId, ms);
          if (ms > lastGlobalReplyCompletedAt) lastGlobalReplyCompletedAt = ms;
        }
      }
    }
  } catch {
    // ignore seed errors
  }
}

export function getNextAllowedReplyTimestamp(pageId: string, minDelayMs: number): number {
  ensurePageTimestampsSeeded();
  const lastAt = Math.max(lastGlobalReplyCompletedAt, lastReplyCompletedAtByPage.get(pageId) ?? 0);
  if (!lastAt) return Date.now();
  const target = lastAt + Math.max(1000, minDelayMs);
  return Math.max(Date.now(), target);
}

function runSerializedLiveReply<T>(task: () => Promise<T>): Promise<T> {
  queuedLiveReplies += 1;
  const current = globalLiveReplyQueue
    .catch(() => undefined)
    .then(task)
    .finally(() => {
      queuedLiveReplies = Math.max(0, queuedLiveReplies - 1);
    });
  globalLiveReplyQueue = current.then(
    () => undefined,
    () => undefined
  );
  return current;
}

async function waitForReplyWindow(
  anchorAtMs: number,
  getDelayMs: () => number,
  shouldAbort?: () => boolean,
  onWaitScheduled?: (nextAtMs: number) => void
): Promise<boolean> {
  if (anchorAtMs <= 0) return !(shouldAbort?.() || !readStore().autoReplyEnabled);

  let lastNotifiedTarget = 0;
  while (true) {
    if (shouldAbort?.() || !readStore().autoReplyEnabled) {
      return false;
    }
    const requiredDelayMs = Math.max(1000, getDelayMs());
    const targetMs = anchorAtMs + requiredDelayMs;
    const remaining = targetMs - Date.now();
    if (remaining <= 0) {
      return true;
    }
    if (activeExecution.busy) {
      activeExecution.phase = 'waiting';
      activeExecution.waitUntilMs = targetMs;
    }
    if (Math.abs(targetMs - lastNotifiedTarget) >= 500) {
      lastNotifiedTarget = targetMs;
      onWaitScheduled?.(targetMs);
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(remaining, 250)));
  }
}

export interface IncomingCommentInput {
  page: StoredFacebookPage;
  postId: string;
  postMessage?: string;
  postImageUrl?: string;
  commentId: string;
  commenterId?: string;
  commenterName: string;
  commentText: string;
  commentCreatedTime?: string;
  source: 'webhook' | 'sync' | 'tester';
  store?: StoreData;
  minDelayMs?: number;
  shouldAbort?: () => boolean;
  onWaitScheduled?: (nextAtMs: number) => void;
  onPhaseChange?: (phase: 'waiting' | 'sending') => void;
}

export async function graphPost(
  endpoint: string,
  accessToken: string,
  body: Record<string, unknown>
): Promise<{
  ok: boolean;
  data?: Record<string, unknown>;
  error?: string;
  errorCode?: number;
  fatal?: boolean;
  deletedObject?: boolean;
}> {
  const url = `${GRAPH_BASE}${endpoint}?access_token=${encodeURIComponent(accessToken)}`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      const errObj = json.error as { message?: string; code?: number } | undefined;
      const msg = errObj?.message || `HTTP ${response.status}`;
      const code = typeof errObj?.code === 'number' ? errObj.code : undefined;
      const fatal =
        code === 190 ||
        code === 368 ||
        code === 4 ||
        code === 17 ||
        code === 32 ||
        code === 613 ||
        /session has expired|error validating access token|temporarily blocked|spam|rate limit/i.test(
          msg
        );
      const deletedObject =
        code === 100 && /does not exist|unsupported post request/i.test(msg);
      return { ok: false, error: msg, errorCode: code, fatal, deletedObject };
    }
    return { ok: true, data: json };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'تعذر الاتصال بخوادم فيسبوك (انتهت المهلة)';
    return { ok: false, error: msg };
  }
}

export async function processIncomingComment(
  input: IncomingCommentInput
): Promise<ReplyLogEntry | null> {
  const store = input.store ?? readStore();
  const { page, postId, commentId, commenterId, commenterName, commentText, source } = input;

  // Ignore replies made by the page itself to prevent infinite loops
  if (commenterId && commenterId === page.id) {
    return null;
  }

  // Deduplicate live webhook/sync comments
  if (source !== 'tester' && store.repliedCommentIds.includes(commentId)) {
    return null;
  }

  const matchedRule = matchCommentAgainstRules(commentText, page.id, postId, store.rules);
  const now = new Date().toISOString();

  if (!matchedRule) {
    const skippedEntry: ReplyLogEntry = {
      id: `log_${crypto.randomUUID().slice(0, 8)}`,
      pageId: page.id,
      pageName: page.name,
      postId,
      commentId,
      commenterName,
      commentText,
      likedComment: false,
      source,
      status: 'skipped',
      errorMessage: 'لم يتطابق التعليق مع أي قاعدة مفعّلة',
      createdAt: now,
    };

    if (source !== 'tester' && !store.skippedCommentIds.includes(commentId)) {
      store.skippedCommentIds.push(commentId);
    }
    store.logs.unshift(skippedEntry);
    if (!input.store) writeStore(store);
    return skippedEntry;
  }

  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  const isOlderThanSevenDays = Boolean(
    input.commentCreatedTime &&
      Date.now() - new Date(input.commentCreatedTime).getTime() > sevenDaysMs
  );

  const buildReplyTexts = async (
    activeRule: AutoReplyRule,
    targetStore: StoreData
  ): Promise<{
    publicReplyText: string;
    privateReplyText: string;
    replySource: 'rule' | 'ai' | 'ai-cache' | 'fallback';
  }> => {
    if (activeRule.replyType === 'ai') {
      const aiRes = await generateAiOrCachedReply({
        rule: activeRule,
        pageId: page.id,
        pageName: page.name,
        postId,
        postMessage: input.postMessage,
        postImageUrl: input.postImageUrl,
        commenterName,
        commentText,
        wantPrivateReply: Boolean(activeRule.sendPrivateReply && !isOlderThanSevenDays),
        store: targetStore,
      });
      return {
        publicReplyText: aiRes.publicReplyText,
        privateReplyText: aiRes.privateReplyText,
        replySource: aiRes.replySource,
      };
    }

    const rawPublicReply = pickPublicReply(activeRule, targetStore.spintaxHistory);
    const publicText = rawPublicReply
      ? renderReplyTemplate(rawPublicReply, commenterName, page.name, {
          ruleId: activeRule.id,
          scope: 'public',
          history: targetStore.spintaxHistory,
        })
      : '';

    const privateText =
      activeRule.sendPrivateReply && activeRule.privateReplyText.trim() && !isOlderThanSevenDays
        ? renderReplyTemplate(activeRule.privateReplyText.trim(), commenterName, page.name, {
            ruleId: activeRule.id,
            scope: 'private',
            history: targetStore.spintaxHistory,
          })
        : '';

    return {
      publicReplyText: publicText,
      privateReplyText: privateText,
      replySource: 'rule',
    };
  };

  let effectiveRule = matchedRule;
  let publicReplyText = '';
  let privateReplyText = '';
  let replySource: 'rule' | 'ai' | 'ai-cache' | 'fallback' = 'rule';

  let status: 'replied' | 'failed' = 'replied';
  let errorMessage: string | undefined;
  let fatalError = false;
  let deletedObject = false;
  let liked = false;
  let abortedBeforeSend = false;
  let updatedStoreFromSend: StoreData | null = null;

  if (page.mode === 'live' && page.accessToken && source !== 'tester') {
    ensurePageTimestampsSeeded();
    const sendResult = await runSerializedLiveReply(async () => {
      if (input.shouldAbort?.() || !readStore().autoReplyEnabled) {
        return { aborted: true as const };
      }

      if (readStore().repliedCommentIds.includes(commentId)) {
        return { aborted: true as const };
      }

      activeExecution = {
        busy: true,
        phase: 'waiting',
        pageId: page.id,
        pageName: page.name,
        commenterName,
        commentText,
      };

      try {
        const lastAt = Math.max(
          lastGlobalReplyCompletedAt,
          lastReplyCompletedAtByPage.get(page.id) ?? 0
        );
        if (lastAt > 0) {
          input.onPhaseChange?.('waiting');
          const ok = await waitForReplyWindow(
            lastAt,
            () => {
              const configuredMs = Math.max(
                1000,
                (readStore().autoReplyDelaySeconds || DEFAULT_LIVE_REPLY_DELAY_MS / 1000) * 1000
              );
              return input.minDelayMs ? Math.max(1000, input.minDelayMs) : configuredMs;
            },
            input.shouldAbort,
            input.onWaitScheduled
          );
          if (!ok) {
            return { aborted: true as const };
          }
        }

        activeExecution.phase = 'sending';
        activeExecution.waitUntilMs = undefined;
        input.onPhaseChange?.('sending');

        // Generate AI / template reply AFTER waiting so rate-limits & rule edits stay fresh
        const freshStore = readStore();
        const latestRule =
          matchCommentAgainstRules(commentText, page.id, postId, freshStore.rules) || matchedRule;
        const generated = await buildReplyTexts(latestRule, freshStore);

        const errors: string[] = [];
        let commentLiked = false;
        let hitFatal = false;
        let hitDeletedObject = false;

        try {
          if (generated.publicReplyText) {
            const res = await graphPost(`/${commentId}/comments`, page.accessToken!, {
              message: generated.publicReplyText,
            });
            if (!res.ok) {
              errors.push(`الرد العام: ${res.error}`);
              if (res.fatal) hitFatal = true;
              if (res.deletedObject) hitDeletedObject = true;
            }
          }

          if (latestRule.likeComment && !hitFatal && !hitDeletedObject) {
            const likeRes = await graphPost(`/${commentId}/likes`, page.accessToken!, {});
            if (likeRes.ok) commentLiked = true;
          }

          if (generated.privateReplyText && !hitFatal && !hitDeletedObject) {
            const dmRes = await graphPost(`/${page.id}/messages`, page.accessToken!, {
              recipient: { comment_id: commentId },
              message: { text: generated.privateReplyText },
            });
            if (!dmRes.ok) {
              errors.push(`الرسالة الخاصة: ${dmRes.error}`);
              if (dmRes.fatal) hitFatal = true;
            }
          }
        } finally {
          const doneAt = Date.now();
          lastGlobalReplyCompletedAt = doneAt;
          lastReplyCompletedAtByPage.set(page.id, doneAt);
        }

        return {
          aborted: false as const,
          errors,
          liked: commentLiked,
          fatal: hitFatal,
          deletedObject: hitDeletedObject,
          generated,
          latestRule,
          freshStore,
        };
      } finally {
        activeExecution = {
          busy: false,
          phase: 'idle',
        };
      }
    });

    if (sendResult.aborted) {
      abortedBeforeSend = true;
    } else {
      liked = sendResult.liked;
      fatalError = sendResult.fatal;
      deletedObject = sendResult.deletedObject;
      publicReplyText = sendResult.generated.publicReplyText;
      privateReplyText = sendResult.generated.privateReplyText;
      replySource = sendResult.generated.replySource;
      effectiveRule = sendResult.latestRule;
      updatedStoreFromSend = sendResult.freshStore;

      const errors = sendResult.errors;
      if (errors.length > 0 && !publicReplyText && !privateReplyText) {
        status = 'failed';
        errorMessage = errors.join(' | ');
      } else if (errors.length > 0) {
        if (
          (publicReplyText && errors.some((e) => e.startsWith('الرد العام'))) ||
          (!publicReplyText && privateReplyText)
        ) {
          status = 'failed';
        }
        errorMessage = errors.join(' | ');
      }
    }
  } else {
    // Sandbox or tester mode preview
    const generated = await buildReplyTexts(matchedRule, store);
    publicReplyText = generated.publicReplyText;
    privateReplyText = generated.privateReplyText;
    replySource = generated.replySource;
    liked = matchedRule.likeComment;
  }

  if (abortedBeforeSend) {
    return null;
  }

  const completedAt = new Date().toISOString();

  const logEntry: ReplyLogEntry = {
    id: `log_${crypto.randomUUID().slice(0, 8)}`,
    pageId: page.id,
    pageName: page.name,
    postId,
    commentId,
    commenterName,
    commentText,
    matchedRuleId: effectiveRule.id,
    matchedRuleName: effectiveRule.name,
    publicReplySent: publicReplyText || undefined,
    privateReplySent: privateReplyText || undefined,
    likedComment: liked,
    replySource,
    source,
    status,
    errorMessage,
    fatalError: fatalError || undefined,
    createdAt: completedAt,
  };

  // Re-read fresh store before persisting so concurrent edits/toggles are never clobbered
  const persistStore = input.store ?? readStore();
  if (status === 'replied') {
    const ruleIndex = persistStore.rules.findIndex((r) => r.id === effectiveRule.id);
    if (ruleIndex !== -1) {
      persistStore.rules[ruleIndex].triggeredCount += 1;
      persistStore.rules[ruleIndex].updatedAt = completedAt;
    }
    if (source !== 'tester') {
      persistStore.totalRepliesSent = (persistStore.totalRepliesSent || 0) + 1;
    }
  } else if (status === 'failed' && source !== 'tester') {
    persistStore.totalFailedReplies = (persistStore.totalFailedReplies || 0) + 1;
  }

  if (!input.store) {
    const sourceStore = updatedStoreFromSend || store;
    persistStore.spintaxHistory = {
      ...persistStore.spintaxHistory,
      ...sourceStore.spintaxHistory,
    };
    if (effectiveRule.replyType === 'ai') {
      persistStore.aiReplyCache = sourceStore.aiReplyCache;
      persistStore.aiStatus = sourceStore.aiStatus;
    }
  }

  if (source !== 'tester') {
    if (status === 'replied') {
      if (!persistStore.repliedCommentIds.includes(commentId)) {
        persistStore.repliedCommentIds.push(commentId);
      }
      persistStore.skippedCommentIds = persistStore.skippedCommentIds.filter(
        (id) => id !== commentId
      );
    } else if (deletedObject) {
      // Do not keep retrying deleted/non-existent Facebook comments every 20s
      if (!persistStore.skippedCommentIds.includes(commentId)) {
        persistStore.skippedCommentIds.push(commentId);
      }
    }
  }
  persistStore.logs.unshift(logEntry);
  if (!input.store) writeStore(persistStore);

  return logEntry;
}
