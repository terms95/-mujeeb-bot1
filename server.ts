import 'dotenv/config';
import crypto from 'node:crypto';
import path from 'node:path';
import express from 'express';
import type { Request, Response } from 'express';
import { createServer as createViteServer } from 'vite';
import type {
  AutoReplyRule,
  AutoSweepStatus,
  BackfillJobStatus,
  BackfillOptions,
  BackfillPreviewItem,
  BackfillResult,
  FacebookPost,
  LiveReplyProgressItem,
  MatchMode,
  ReplyLogEntry,
  SyncSummary,
} from './src/types/facebook.ts';
import {
  getLiveExecutionSnapshot,
  getNextAllowedReplyTimestamp,
  matchCommentAgainstRules,
  processIncomingComment,
  renderReplyTemplate,
} from './server/replyEngine.ts';
import { isAiConfigured } from './server/aiEngine.ts';
import { readStore, sanitizePage, writeStore } from './server/store.ts';
import type { StoredFacebookPage } from './server/store.ts';

const GRAPH_VERSION = 'v21.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;
const PORT = Number(process.env.PORT) || 3000;

const oauthStates = new Map<string, number>();

function normalizeSpintaxBraces(text: string): string {
  const trimmed = text.trim();
  if (!trimmed || !trimmed.includes('|')) return trimmed;
  let openCount = 0;
  let closeCount = 0;
  for (const ch of trimmed) {
    if (ch === '{') openCount += 1;
    else if (ch === '}') closeCount += 1;
  }
  if (openCount === closeCount + 1) {
    return `${trimmed}}`;
  }
  return trimmed;
}

function getAppUrl(req?: Request): string {
  const envUrl = process.env.APP_URL?.trim();
  if (envUrl && envUrl !== 'MY_APP_URL') {
    return envUrl.replace(/\/+$/, '');
  }
  if (req) {
    const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'http';
    const host = (req.headers['x-forwarded-host'] as string) || req.get('host') || `localhost:${PORT}`;
    return `${proto}://${host}`.replace(/\/+$/, '');
  }
  return `http://localhost:${PORT}`;
}

function getOAuthCredentials(): { appId: string; appSecret: string } | null {
  const appId = process.env.FACEBOOK_APP_ID?.trim() || '';
  const appSecret = process.env.FACEBOOK_APP_SECRET?.trim() || '';
  if (!appId || !appSecret) return null;
  return { appId, appSecret };
}

async function subscribePageWebhook(pageId: string, pageAccessToken: string): Promise<boolean> {
  try {
    const url = `${GRAPH_BASE}/${pageId}/subscribed_apps?subscribed_fields=feed&access_token=${encodeURIComponent(
      pageAccessToken
    )}`;
    const res = await fetch(url, { method: 'POST' });
    const data = (await res.json()) as { success?: boolean };
    return Boolean(res.ok && data.success);
  } catch {
    return false;
  }
}

async function syncLivePageComments(page: StoredFacebookPage): Promise<SyncSummary> {
  const summary: SyncSummary = {
    scannedComments: 0,
    repliedCount: 0,
    skippedCount: 0,
    failedCount: 0,
  };

  if (page.mode !== 'live' || !page.accessToken) {
    return summary;
  }
  if (activeBackfillPages.has(page.id)) {
    return summary;
  }

  const postsUrl = `${GRAPH_BASE}/${page.id}/posts?fields=id,message,story,created_time,full_picture,attachments{title,description,media{image{src}}},comments.order(reverse_chronological).limit(50){id,message,from,created_time,comments.limit(25){id,from}}&limit=25&access_token=${encodeURIComponent(
    page.accessToken
  )}`;

  const res = await fetch(postsUrl, { signal: AbortSignal.timeout(15000) });
  const json = (await res.json().catch(() => ({}))) as {
    data?: Array<
      GraphPostNode & {
        comments?: {
          data?: GraphCommentNode[];
        };
      }
    >;
    error?: { message?: string };
  };

  if (!res.ok) {
    throw new Error(json.error?.message || 'تعذر جلب المنشورات والتعليقات من فيسبوك');
  }

  if (!readStore().autoReplyEnabled) {
    return summary;
  }
  const posts = json.data || [];

  const MAX_SYNC_ACTIONS_PER_PASS = 100;
  const candidateQueue: QueuedBackfillComment[] = [];
  const latestInitialStore = readStore();
  const seenCommentIds = new Set<string>();

  for (const post of posts) {
    const postCtx = extractPostContext(post);
    cachePostContext(post.id, postCtx);

    const comments = [...(post.comments?.data || [])].reverse();
    for (const comment of comments) {
      if (candidateQueue.length >= MAX_SYNC_ACTIONS_PER_PASS) break;
      if (
        !comment.id ||
        !comment.message ||
        seenCommentIds.has(comment.id) ||
        latestInitialStore.repliedCommentIds.includes(comment.id) ||
        latestInitialStore.skippedCommentIds.includes(comment.id)
      ) {
        continue;
      }
      seenCommentIds.add(comment.id);
      if (comment.from?.id === page.id) {
        continue;
      }
      const alreadyRepliedOnFb = (comment.comments?.data || []).some(
        (reply) => reply.from?.id === page.id
      );
      if (alreadyRepliedOnFb) {
        latestInitialStore.repliedCommentIds.push(comment.id);
        writeStore(latestInitialStore);
        continue;
      }

      const matched = matchCommentAgainstRules(
        comment.message,
        page.id,
        post.id,
        latestInitialStore.rules
      );
      if (!matched) {
        summary.scannedComments += 1;
        const skippedLog = await processIncomingComment({
          page,
          postId: post.id,
          postMessage: postCtx.postMessage,
          postImageUrl: postCtx.postImageUrl,
          commentId: comment.id,
          commenterId: comment.from?.id,
          commenterName: comment.from?.name || 'مستخدم فيسبوك',
          commentText: comment.message,
          commentCreatedTime: comment.created_time,
          source: 'sync',
        });
        if (skippedLog?.status === 'skipped') summary.skippedCount += 1;
        continue;
      }

      candidateQueue.push({
        postId: post.id,
        postMessage: postCtx.postMessage,
        postImageUrl: postCtx.postImageUrl,
        commentId: comment.id,
        commenterId: comment.from?.id,
        commenterName: comment.from?.name || 'مستخدم فيسبوك',
        commentText: comment.message,
        createdTime: comment.created_time || new Date().toISOString(),
      });
    }
    if (candidateQueue.length >= MAX_SYNC_ACTIONS_PER_PASS) break;
  }

  let registeredSyncSweep = false;
  let syncSweep: PageSweepState | null = null;
  if (candidateQueue.length > 0 && !activePageSweeps.has(page.id)) {
    syncSweep = {
      pageId: page.id,
      pageName: page.name,
      scanning: false,
      totalQueued: candidateQueue.length,
      processedCount: 0,
      repliedCount: 0,
      failedCount: 0,
      cancelled: false,
    };
    activePageSweeps.set(page.id, syncSweep);
    registeredSyncSweep = true;
  }

  try {
    for (const item of candidateQueue) {
      if (activeBackfillPages.has(page.id)) break;
      const latestStore = readStore();
      if (!latestStore.autoReplyEnabled || syncSweep?.cancelled) {
        break;
      }

      if (syncSweep) {
        syncSweep.currentCommenter = item.commenterName;
        syncSweep.currentCommentText = item.commentText;
        const delaySec = Math.min(Math.max(Number(latestStore.autoReplyDelaySeconds) || 15, 1), 300);
        const nextMs = getNextAllowedReplyTimestamp(page.id, delaySec * 1000);
        syncSweep.nextReplyAt = nextMs > Date.now() ? new Date(nextMs).toISOString() : undefined;
      }

      summary.scannedComments += 1;
      const log = await processIncomingComment({
        page,
        postId: item.postId,
        postMessage: item.postMessage,
        postImageUrl: item.postImageUrl,
        commentId: item.commentId,
        commenterId: item.commenterId,
        commenterName: item.commenterName,
        commentText: item.commentText,
        commentCreatedTime: item.createdTime,
        source: 'sync',
        shouldAbort: () =>
          activeBackfillPages.has(page.id) ||
          Boolean(syncSweep?.cancelled) ||
          !readStore().autoReplyEnabled,
        onWaitScheduled: (scheduledAtMs) => {
          if (syncSweep) {
            syncSweep.nextReplyAt = new Date(scheduledAtMs).toISOString();
          }
        },
        onPhaseChange: (phase) => {
          if (syncSweep && phase === 'sending') {
            syncSweep.nextReplyAt = undefined;
          }
        },
      });

      if (syncSweep) {
        syncSweep.nextReplyAt = undefined;
      }

      if (log) {
        if (log.status === 'replied' || log.status === 'failed' || log.status === 'skipped') {
          recordLiveReplyProgress(log, item.postMessage?.slice(0, 80));
        }
        if (log.status === 'replied') summary.repliedCount += 1;
        else if (log.status === 'skipped') summary.skippedCount += 1;
        else if (log.status === 'failed') summary.failedCount += 1;

        if (syncSweep) {
          syncSweep.processedCount += 1;
          if (log.status === 'replied') syncSweep.repliedCount += 1;
          else if (log.status === 'failed') syncSweep.failedCount += 1;
        }

        if (log.fatalError) {
          break;
        }
      } else if (syncSweep) {
        if (!readStore().autoReplyEnabled || activeBackfillPages.has(page.id)) break;
        syncSweep.totalQueued = Math.max(0, syncSweep.totalQueued - 1);
      }
    }
  } finally {
    if (registeredSyncSweep && syncSweep) {
      activePageSweeps.delete(page.id);
      const hasOtherRunning =
        activePageSweeps.size > 0 ||
        Array.from(backfillJobs.values()).some((j) => j.status === 'running');
      if (hasOtherRunning) {
        completedPageSweeps.set(page.id, {
          ...syncSweep,
          scanning: false,
          nextReplyAt: undefined,
          currentCommenter: undefined,
          currentCommentText: undefined,
        });
      } else {
        completedPageSweeps.clear();
      }
    }
  }

  const freshStore = readStore();
  const pageIdx = freshStore.pages.findIndex((p) => p.id === page.id);
  if (pageIdx !== -1) {
    freshStore.pages[pageIdx].lastSyncedAt = new Date().toISOString();
    writeStore(freshStore);
  }

  return summary;
}

let pollingBusy = false;

async function syncAllLivePages(forceAllLive = false): Promise<
  SyncSummary & { pagesScanned: number }
> {
  const total: SyncSummary & { pagesScanned: number } = {
    scannedComments: 0,
    repliedCount: 0,
    skippedCount: 0,
    failedCount: 0,
    pagesScanned: 0,
  };

  if (pollingBusy) {
    return total;
  }

  pollingBusy = true;
  try {
    const store = readStore();
    if (!store.autoReplyEnabled) return total;
    const livePages = store.pages.filter(
      (p) => p.mode === 'live' && Boolean(p.accessToken) && (forceAllLive || p.autoPolling)
    );
    for (const page of livePages) {
      if (!readStore().autoReplyEnabled) break;
      try {
        const res = await syncLivePageComments(page);
        total.pagesScanned += 1;
        total.scannedComments += res.scannedComments;
        total.repliedCount += res.repliedCount;
        total.skippedCount += res.skippedCount;
        total.failedCount += res.failedCount;
      } catch {
        // Continue scanning remaining pages on transient Graph API error
      }
    }
  } finally {
    pollingBusy = false;
  }

  return total;
}

interface GraphCommentNode {
  id: string;
  message?: string;
  created_time?: string;
  from?: { id?: string; name?: string };
  comments?: {
    data?: Array<{
      id: string;
      from?: { id?: string };
    }>;
  };
}

interface GraphPostAttachment {
  title?: string;
  description?: string;
  media?: {
    image?: {
      src?: string;
    };
  };
}

interface GraphPostNode {
  id: string;
  message?: string;
  story?: string;
  created_time?: string;
  full_picture?: string;
  attachments?: {
    data?: GraphPostAttachment[];
  };
}

interface PostContextData {
  postMessage?: string;
  postImageUrl?: string;
}

const POST_CONTEXT_FIELDS =
  'id,message,story,created_time,full_picture,attachments{title,description,media{image{src}}}';
const postContextCache = new Map<string, PostContextData & { cachedAt: number }>();

function extractPostContext(post: GraphPostNode): PostContextData {
  const parts: string[] = [];
  const seen = new Set<string>();
  const pushUnique = (raw?: string) => {
    const clean = raw?.trim();
    if (!clean || seen.has(clean)) return;
    seen.add(clean);
    parts.push(clean);
  };

  pushUnique(post.message);
  pushUnique(post.story);
  for (const att of post.attachments?.data || []) {
    pushUnique(att.title);
    pushUnique(att.description);
  }

  const postImageUrl =
    post.full_picture ||
    post.attachments?.data?.find((a) => Boolean(a.media?.image?.src))?.media?.image?.src;

  return {
    postMessage: parts.length > 0 ? parts.join('\n') : undefined,
    postImageUrl,
  };
}

function cachePostContext(postId: string, ctx: PostContextData): void {
  if (!postId || postId === 'unknown' || postId === 'all') return;
  if (!ctx.postMessage && !ctx.postImageUrl) return;
  if (postContextCache.size >= 150) {
    const oldestKey = postContextCache.keys().next().value;
    if (oldestKey) postContextCache.delete(oldestKey);
  }
  postContextCache.set(postId, { ...ctx, cachedAt: Date.now() });
}

async function getOrFetchPostContext(
  page: StoredFacebookPage,
  postId: string
): Promise<PostContextData> {
  if (!postId || postId === 'unknown' || postId === 'all') return {};

  const existing = postContextCache.get(postId);
  if (existing && Date.now() - existing.cachedAt < 15 * 60 * 1000) {
    return { postMessage: existing.postMessage, postImageUrl: existing.postImageUrl };
  }

  if (page.mode !== 'live' || !page.accessToken) return {};

  try {
    const url = `${GRAPH_BASE}/${encodeURIComponent(
      postId
    )}?fields=${POST_CONTEXT_FIELDS}&access_token=${encodeURIComponent(page.accessToken)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!res.ok) return {};
    const postJson = (await res.json()) as GraphPostNode;
    if (!postJson?.id) return {};
    const ctx = extractPostContext(postJson);
    cachePostContext(postId, ctx);
    return ctx;
  } catch {
    return {};
  }
}

interface InternalBackfillJob extends BackfillJobStatus {
  cancelled: boolean;
  currentCommentText?: string;
}

interface QueuedBackfillComment {
  postId: string;
  postMessage?: string;
  postImageUrl?: string;
  commentId: string;
  commenterId?: string;
  commenterName: string;
  commentText: string;
  createdTime: string;
}

const backfillJobs = new Map<string, InternalBackfillJob>();
const activeBackfillPages = new Set<string>();

interface PageSweepState {
  pageId: string;
  pageName: string;
  scanning: boolean;
  totalQueued: number;
  processedCount: number;
  repliedCount: number;
  failedCount: number;
  currentCommenter?: string;
  currentCommentText?: string;
  nextReplyAt?: string;
  cancelled: boolean;
}

const activePageSweeps = new Map<string, PageSweepState>();
const completedPageSweeps = new Map<string, PageSweepState>();
const recentLiveReplies: LiveReplyProgressItem[] = [];

function recordLiveReplyProgress(log: ReplyLogEntry, postPreview?: string): void {
  recentLiveReplies.unshift({
    id: log.id,
    pageId: log.pageId,
    pageName: log.pageName,
    postId: log.postId,
    postPreview,
    commenterName: log.commenterName,
    commentText: log.commentText,
    replySent: log.publicReplySent,
    privateReplySent: log.privateReplySent,
    replySource: log.replySource,
    status: log.status,
    errorMessage: log.errorMessage,
    createdAt: log.createdAt,
  });
  if (recentLiveReplies.length > 30) {
    recentLiveReplies.length = 30;
  }
}

function getAutoSweepSummary(delaySeconds: number): AutoSweepStatus {
  const nowMs = Date.now();
  const sweeps = Array.from(activePageSweeps.values());
  const runningJobs = Array.from(backfillJobs.values()).filter((j) => j.status === 'running');
  const liveExec = getLiveExecutionSnapshot();

  if (sweeps.length === 0 && runningJobs.length === 0 && !liveExec.busy) {
    completedPageSweeps.clear();
  }

  const finishedSweeps = Array.from(completedPageSweeps.values()).filter(
    (cs) => !activePageSweeps.has(cs.pageId)
  );

  let totalQueued = 0;
  let processedCount = 0;
  let repliedCount = 0;
  let failedCount = 0;
  let earliestNextMs = Infinity;
  let earliestNextIso: string | undefined;
  let scanning = false;
  const pageIds = new Set<string>();

  for (const s of sweeps) {
    pageIds.add(s.pageId);
    if (s.scanning) scanning = true;
    totalQueued += s.totalQueued;
    processedCount += s.processedCount;
    repliedCount += s.repliedCount;
    failedCount += s.failedCount;
    if (s.nextReplyAt) {
      const ms = new Date(s.nextReplyAt).getTime();
      if (!Number.isNaN(ms) && ms > nowMs && ms < earliestNextMs) {
        earliestNextMs = ms;
        earliestNextIso = s.nextReplyAt;
      }
    }
  }

  for (const fs of finishedSweeps) {
    pageIds.add(fs.pageId);
    totalQueued += fs.totalQueued;
    processedCount += fs.processedCount;
    repliedCount += fs.repliedCount;
    failedCount += fs.failedCount;
  }

  for (const j of runningJobs) {
    pageIds.add(j.pageId);
    totalQueued += j.totalQueued;
    processedCount += j.processedCount;
    repliedCount += j.repliedCount;
    failedCount += j.failedCount;
    if (j.nextReplyAt) {
      const ms = new Date(j.nextReplyAt).getTime();
      if (!Number.isNaN(ms) && ms > nowMs && ms < earliestNextMs) {
        earliestNextMs = ms;
        earliestNextIso = j.nextReplyAt;
      }
    }
  }

  const remainingCount = Math.max(0, totalQueued - processedCount);
  const activeSweep = sweeps.find((s) => s.pageId === liveExec.pageId) ?? sweeps[0];
  const activeJob = runningJobs.find((j) => j.pageId === liveExec.pageId) ?? runningJobs[0];
  const isRunning = sweeps.length > 0 || runningJobs.length > 0 || liveExec.busy;

  let phase: 'idle' | 'waiting' | 'sending' = 'idle';
  let resolvedNextIso = earliestNextIso;
  let resolvedNextInMs: number | undefined;

  if (liveExec.busy) {
    phase = liveExec.phase;
    if (liveExec.phase === 'waiting' && liveExec.waitUntilMs) {
      resolvedNextInMs = Math.max(0, liveExec.waitUntilMs - nowMs);
      resolvedNextIso = new Date(liveExec.waitUntilMs).toISOString();
    } else if (liveExec.phase === 'sending') {
      resolvedNextIso = undefined;
      resolvedNextInMs = undefined;
    }
  } else if (earliestNextIso && Number.isFinite(earliestNextMs)) {
    phase = 'waiting';
    resolvedNextInMs = Math.max(0, earliestNextMs - nowMs);
  } else if (isRunning) {
    phase = scanning ? 'idle' : 'waiting';
  }

  return {
    running: isRunning,
    scanning,
    phase,
    pagesInProgress: pageIds.size || (liveExec.pageId ? 1 : 0),
    totalQueued,
    processedCount,
    remainingCount,
    repliedCount,
    failedCount,
    delaySeconds,
    currentPageName: liveExec.busy
      ? liveExec.pageName
      : activeSweep?.pageName ?? activeJob?.pageName,
    currentCommenter: liveExec.busy
      ? liveExec.commenterName
      : activeSweep?.currentCommenter ?? activeJob?.currentCommenter,
    currentCommentText: liveExec.busy
      ? liveExec.commentText
      : activeSweep?.currentCommentText ?? activeJob?.currentCommentText,
    nextReplyAt: resolvedNextIso,
    nextReplyInMs: resolvedNextInMs,
    serverTime: new Date(nowMs).toISOString(),
    recentItems: recentLiveReplies.slice(0, 20),
  };
}

async function sweepPageAllUnansweredComments(
  page: StoredFacebookPage,
  preRegisteredState?: PageSweepState
): Promise<void> {
  if (page.mode !== 'live' || !page.accessToken) {
    if (preRegisteredState) {
      activePageSweeps.delete(page.id);
      activeBackfillPages.delete(page.id);
    }
    return;
  }
  if (!readStore().autoReplyEnabled) {
    if (preRegisteredState) {
      activePageSweeps.delete(page.id);
      activeBackfillPages.delete(page.id);
    }
    return;
  }
  if (!preRegisteredState && (activeBackfillPages.has(page.id) || activePageSweeps.has(page.id))) {
    return;
  }

  const sweepState: PageSweepState = preRegisteredState ?? {
    pageId: page.id,
    pageName: page.name,
    scanning: true,
    totalQueued: 0,
    processedCount: 0,
    repliedCount: 0,
    failedCount: 0,
    cancelled: false,
  };

  activeBackfillPages.add(page.id);
  activePageSweeps.set(page.id, sweepState);
  completedPageSweeps.delete(page.id);

  try {
    // 1. Collect up to 50 posts on this page (newest posts first) with full text & image metadata
    const posts: GraphPostNode[] = [];
    let nextPostsUrl: string | undefined = `${GRAPH_BASE}/${
      page.id
    }/posts?fields=${POST_CONTEXT_FIELDS}&limit=25&access_token=${encodeURIComponent(
      page.accessToken
    )}`;

    while (nextPostsUrl && posts.length < 50) {
      if (sweepState.cancelled || !readStore().autoReplyEnabled) return;
      try {
        const pRes = await fetch(nextPostsUrl, { signal: AbortSignal.timeout(15000) });
        const pJson = (await pRes.json().catch(() => ({}))) as {
          data?: GraphPostNode[];
          paging?: { next?: string };
        };
        if (!pRes.ok) break;
        for (const p of pJson.data || []) {
          if (posts.length < 50) posts.push(p);
        }
        nextPostsUrl = pJson.paging?.next;
      } catch {
        break;
      }
    }

    // 2. Collect ALL unanswered comments (old and new) matching any enabled rule
    const queue: QueuedBackfillComment[] = [];
    const seenIds = new Set<string>();
    const newlyConfirmedAnsweredOnFb: string[] = [];

    for (const post of posts) {
      if (sweepState.cancelled || !readStore().autoReplyEnabled) return;

      const postCtx = extractPostContext(post);
      cachePostContext(post.id, postCtx);

      let nextCommentsUrl: string | undefined = `${GRAPH_BASE}/${
        post.id
      }/comments?fields=id,message,from,created_time,comments.limit(25){id,from}&filter=toplevel&limit=50&access_token=${encodeURIComponent(
        page.accessToken
      )}`;
      let fetchedForPost = 0;

      while (nextCommentsUrl && fetchedForPost < 250) {
        if (sweepState.cancelled || !readStore().autoReplyEnabled) return;
        let cJson: {
          data?: GraphCommentNode[];
          paging?: { next?: string };
        } = {};
        try {
          const cRes = await fetch(nextCommentsUrl, { signal: AbortSignal.timeout(15000) });
          cJson = (await cRes.json().catch(() => ({}))) as {
            data?: GraphCommentNode[];
            paging?: { next?: string };
          };
          if (!cRes.ok) break;
        } catch {
          break;
        }

        const comments = cJson.data || [];
        fetchedForPost += comments.length;
        const latestStore = readStore();

        for (const comment of comments) {
          if (!comment.id || !comment.message || seenIds.has(comment.id)) continue;
          seenIds.add(comment.id);
          if (comment.from?.id === page.id) continue;

          const answeredOnFb = (comment.comments?.data || []).some(
            (reply) => reply.from?.id === page.id
          );
          if (answeredOnFb) {
            if (!latestStore.repliedCommentIds.includes(comment.id)) {
              newlyConfirmedAnsweredOnFb.push(comment.id);
            }
            continue;
          }

          if (latestStore.repliedCommentIds.includes(comment.id)) {
            continue;
          }

          const matchedRule = matchCommentAgainstRules(
            comment.message,
            page.id,
            post.id,
            latestStore.rules
          );
          if (!matchedRule) continue;

          queue.push({
            postId: post.id,
            postMessage: postCtx.postMessage,
            postImageUrl: postCtx.postImageUrl,
            commentId: comment.id,
            commenterId: comment.from?.id,
            commenterName: comment.from?.name || 'مستخدم فيسبوك',
            commentText: comment.message,
            createdTime: comment.created_time || new Date().toISOString(),
          });
          sweepState.totalQueued = queue.length;
        }

        nextCommentsUrl = cJson.paging?.next;
      }
    }

    if (newlyConfirmedAnsweredOnFb.length > 0) {
      const s = readStore();
      for (const cid of newlyConfirmedAnsweredOnFb) {
        if (!s.repliedCommentIds.includes(cid)) s.repliedCommentIds.push(cid);
      }
      writeStore(s);
    }

    sweepState.scanning = false;
    sweepState.totalQueued = queue.length;

    // Wait briefly for sibling pages launched together to finish scanning so totalQueued is exact before replies start
    while (
      !sweepState.cancelled &&
      readStore().autoReplyEnabled &&
      Array.from(activePageSweeps.values()).some((s) => s.scanning && !s.cancelled)
    ) {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }

    // 3. Process every queued unanswered comment sequentially at the configured manual delay
    for (const item of queue) {
      const latestStore = readStore();
      if (sweepState.cancelled || !latestStore.autoReplyEnabled) break;

      sweepState.currentCommenter = item.commenterName;
      sweepState.currentCommentText = item.commentText;

      const delaySec = Math.min(Math.max(Number(latestStore.autoReplyDelaySeconds) || 15, 1), 300);
      const delayMs = delaySec * 1000;
      const nextMs = getNextAllowedReplyTimestamp(page.id, delayMs);
      sweepState.nextReplyAt = nextMs > Date.now() ? new Date(nextMs).toISOString() : undefined;

      const log = await processIncomingComment({
        page,
        postId: item.postId,
        postMessage: item.postMessage,
        postImageUrl: item.postImageUrl,
        commentId: item.commentId,
        commenterId: item.commenterId,
        commenterName: item.commenterName,
        commentText: item.commentText,
        commentCreatedTime: item.createdTime,
        source: 'sync',
        shouldAbort: () => sweepState.cancelled || !readStore().autoReplyEnabled,
        onWaitScheduled: (scheduledAtMs) => {
          sweepState.nextReplyAt = new Date(scheduledAtMs).toISOString();
        },
        onPhaseChange: (phase) => {
          if (phase === 'sending') {
            sweepState.nextReplyAt = undefined;
          }
        },
      });

      sweepState.nextReplyAt = undefined;
      if (!log) {
        if (sweepState.cancelled || !readStore().autoReplyEnabled) break;
        sweepState.totalQueued = Math.max(0, sweepState.totalQueued - 1);
        continue;
      }

      if (log.status === 'replied' || log.status === 'failed' || log.status === 'skipped') {
        recordLiveReplyProgress(log, item.postMessage?.slice(0, 80));
      }

      if (log.status === 'skipped') {
        sweepState.totalQueued = Math.max(0, sweepState.totalQueued - 1);
      } else {
        sweepState.processedCount += 1;
        if (log.status === 'replied') sweepState.repliedCount += 1;
        else if (log.status === 'failed') sweepState.failedCount += 1;
      }

      if (log.fatalError) {
        break;
      }
    }

    sweepState.currentCommenter = undefined;
    sweepState.currentCommentText = undefined;

    const freshStore = readStore();
    const pageIdx = freshStore.pages.findIndex((p) => p.id === page.id);
    if (pageIdx !== -1) {
      freshStore.pages[pageIdx].lastSyncedAt = new Date().toISOString();
      writeStore(freshStore);
    }
  } catch {
    // Keep server healthy on transient Graph API errors during background sweep
  } finally {
    activePageSweeps.delete(page.id);
    activeBackfillPages.delete(page.id);
    const hasOtherRunning =
      activePageSweeps.size > 0 ||
      Array.from(backfillJobs.values()).some((j) => j.status === 'running');
    if (hasOtherRunning && sweepState.totalQueued > 0) {
      completedPageSweeps.set(page.id, {
        ...sweepState,
        scanning: false,
        nextReplyAt: undefined,
        currentCommenter: undefined,
        currentCommentText: undefined,
      });
    } else if (!hasOtherRunning) {
      completedPageSweeps.clear();
    }
  }
}

function triggerAutoSweepForEnabledPages(forceAllLive = false): number {
  const store = readStore();
  if (!store.autoReplyEnabled) return 0;
  const livePages = store.pages.filter(
    (p) => p.mode === 'live' && Boolean(p.accessToken) && (forceAllLive || p.autoPolling)
  );
  if (activePageSweeps.size === 0) {
    completedPageSweeps.clear();
  }
  const toLaunch: Array<{ page: StoredFacebookPage; state: PageSweepState }> = [];
  for (const page of livePages) {
    if (!activeBackfillPages.has(page.id) && !activePageSweeps.has(page.id)) {
      const state: PageSweepState = {
        pageId: page.id,
        pageName: page.name,
        scanning: true,
        totalQueued: 0,
        processedCount: 0,
        repliedCount: 0,
        failedCount: 0,
        cancelled: false,
      };
      activeBackfillPages.add(page.id);
      activePageSweeps.set(page.id, state);
      toLaunch.push({ page, state });
    }
  }
  for (const { page, state } of toLaunch) {
    void sweepPageAllUnansweredComments(page, state);
  }
  return toLaunch.length;
}

function sanitizeBackfillJob(job: InternalBackfillJob): BackfillJobStatus {
  const { cancelled: _ignored, currentCommentText: _ignoredText, ...publicJob } = job;
  const nowMs = Date.now();
  const nextMs = publicJob.nextReplyAt ? new Date(publicJob.nextReplyAt).getTime() : NaN;
  const nextReplyInMs =
    publicJob.status === 'running' &&
    publicJob.phase !== 'sending' &&
    !Number.isNaN(nextMs) &&
    nextMs > nowMs
      ? nextMs - nowMs
      : undefined;
  return {
    ...publicJob,
    nextReplyInMs,
    serverTime: new Date(nowMs).toISOString(),
  };
}

async function runBackfillJobWorker(
  job: InternalBackfillJob,
  page: StoredFacebookPage,
  queue: QueuedBackfillComment[],
  delayMs: number
): Promise<void> {
  try {
    for (const item of queue) {
      if (job.cancelled || !readStore().autoReplyEnabled) {
        job.status = 'cancelled';
        job.phase = undefined;
        job.nextReplyAt = undefined;
        job.currentCommenter = undefined;
        job.currentCommentText = undefined;
        break;
      }

      job.currentCommenter = item.commenterName;
      job.currentCommentText = item.commentText;
      const nextMs = getNextAllowedReplyTimestamp(page.id, delayMs);
      job.phase = nextMs > Date.now() ? 'waiting' : 'sending';
      job.nextReplyAt = nextMs > Date.now() ? new Date(nextMs).toISOString() : undefined;

      const log = await processIncomingComment({
        page,
        postId: item.postId,
        postMessage: item.postMessage,
        postImageUrl: item.postImageUrl,
        commentId: item.commentId,
        commenterId: item.commenterId,
        commenterName: item.commenterName,
        commentText: item.commentText,
        commentCreatedTime: item.createdTime,
        source: 'sync',
        minDelayMs: delayMs,
        shouldAbort: () => job.cancelled || !readStore().autoReplyEnabled,
        onWaitScheduled: (scheduledAtMs) => {
          job.phase = 'waiting';
          job.nextReplyAt = new Date(scheduledAtMs).toISOString();
        },
        onPhaseChange: (phase) => {
          job.phase = phase;
          if (phase === 'sending') {
            job.nextReplyAt = undefined;
          }
        },
      });

      if (!log) {
        if (job.cancelled || !readStore().autoReplyEnabled) {
          job.status = 'cancelled';
          job.nextReplyAt = undefined;
          job.currentCommenter = undefined;
          job.currentCommentText = undefined;
          break;
        }
        job.processedCount += 1;
        continue;
      }

      if (log.status === 'replied' || log.status === 'failed' || log.status === 'skipped') {
        recordLiveReplyProgress(log, item.postMessage?.slice(0, 80));
      }

      job.processedCount += 1;
      job.lastReplyAt = new Date().toISOString();
      job.nextReplyAt = undefined;
      if (log.status === 'replied') {
        job.repliedCount += 1;
      } else if (log.status === 'failed') {
        job.failedCount += 1;
      }

      if (log.fatalError) {
        job.status = 'failed';
        job.errorMessage =
          log.errorMessage || 'توقف الإرسال تلقائياً لحماية الصفحة بسبب انتهاء الرمز أو قيود فيسبوك';
        job.nextReplyAt = undefined;
        job.currentCommenter = undefined;
        job.currentCommentText = undefined;
        break;
      }
    }

    if (job.status === 'running') {
      job.status = job.cancelled ? 'cancelled' : 'completed';
    }
    job.currentCommenter = undefined;
    job.currentCommentText = undefined;
    job.nextReplyAt = undefined;

    const freshStore = readStore();
    const pageIdx = freshStore.pages.findIndex((p) => p.id === page.id);
    if (pageIdx !== -1) {
      freshStore.pages[pageIdx].lastSyncedAt = new Date().toISOString();
      writeStore(freshStore);
    }
  } catch (err) {
    job.status = 'failed';
    job.errorMessage = err instanceof Error ? err.message : 'تعذر إكمال دفعة الردود';
    job.currentCommenter = undefined;
    job.currentCommentText = undefined;
    job.nextReplyAt = undefined;
  } finally {
    activeBackfillPages.delete(page.id);
  }
}

async function backfillOldUnansweredComments(
  page: StoredFacebookPage,
  options: BackfillOptions
): Promise<BackfillResult> {
  const dryRun = options.dryRun !== false;
  const postsLimit = Math.min(Math.max(Number(options.postsLimit) || 25, 1), 100);
  const maxReplies = Math.min(Math.max(Math.floor(Number(options.maxReplies) || 50), 1), 1000);
  const parsedDelay = Number(options.delaySeconds);
  // Enforce a real minimum interval of 1 second between batch replies to prevent spam bursts
  const delaySeconds =
    Number.isFinite(parsedDelay) && parsedDelay >= 1
      ? Math.min(parsedDelay, 300)
      : 5;
  const delayMs = Math.round(delaySeconds * 1000);
  const sinceDays =
    typeof options.sinceDays === 'number' && options.sinceDays > 0 ? options.sinceDays : null;
  const cutoffMs = sinceDays ? Date.now() - sinceDays * 24 * 60 * 60 * 1000 : null;
  const selectedSet = Array.isArray(options.selectedCommentIds)
    ? new Set(options.selectedCommentIds)
    : null;

  const result: BackfillResult = {
    dryRun,
    scannedPosts: 0,
    scannedComments: 0,
    alreadyAnsweredByPage: 0,
    unmatchedCount: 0,
    matchedUnansweredCount: 0,
    repliedCount: 0,
    failedCount: 0,
    previews: [],
  };

  if (page.mode !== 'live' || !page.accessToken) {
    return result;
  }

  if (!dryRun && activePageSweeps.has(page.id)) {
    const runningSweep = activePageSweeps.get(page.id);
    if (runningSweep) {
      runningSweep.cancelled = true;
      activePageSweeps.delete(page.id);
      activeBackfillPages.delete(page.id);
    }
  }

  if (!dryRun && activeBackfillPages.has(page.id)) {
    const existingJob = Array.from(backfillJobs.values()).find(
      (j) => j.pageId === page.id && j.status === 'running'
    );
    if (existingJob) {
      return {
        ...result,
        job: sanitizeBackfillJob(existingJob),
      };
    }
  }

  if (!dryRun) {
    // Remember the manually specified delay interval for subsequent auto-replies too
    if (Number.isFinite(parsedDelay) && parsedDelay >= 1) {
      const storeToUpdate = readStore();
      if (storeToUpdate.autoReplyDelaySeconds !== delaySeconds) {
        storeToUpdate.autoReplyDelaySeconds = delaySeconds;
        writeStore(storeToUpdate);
      }
    }
    // Immediately reserve the page lock before Graph API scanning so background polling aborts right away
    activeBackfillPages.add(page.id);
  }

  let workerSpawned = false;
  try {
    // 1. Collect target posts (single post or paginated page feed) with full text & image context
    const posts: GraphPostNode[] = [];
    if (options.postId && options.postId !== 'all') {
      const singlePostUrl = `${GRAPH_BASE}/${encodeURIComponent(
        options.postId
      )}?fields=${POST_CONTEXT_FIELDS}&access_token=${encodeURIComponent(page.accessToken)}`;
      const singleRes = await fetch(singlePostUrl, { signal: AbortSignal.timeout(15000) });
      const singleJson = (await singleRes.json()) as GraphPostNode & { error?: { message?: string } };
      if (!singleRes.ok || !singleJson.id) {
        throw new Error(singleJson.error?.message || 'تعذر جلب المنشور المحدد من فيسبوك');
      }
      posts.push(singleJson);
    } else {
      let nextPostsUrl: string | undefined = `${GRAPH_BASE}/${
        page.id
      }/posts?fields=${POST_CONTEXT_FIELDS}&limit=25&access_token=${encodeURIComponent(
        page.accessToken
      )}`;

      while (nextPostsUrl && posts.length < postsLimit) {
        const pRes = await fetch(nextPostsUrl, { signal: AbortSignal.timeout(15000) });
        const pJson = (await pRes.json()) as {
          data?: GraphPostNode[];
          paging?: { next?: string };
          error?: { message?: string };
        };
        if (!pRes.ok) {
          throw new Error(pJson.error?.message || 'تعذر جلب منشورات الصفحة من فيسبوك');
        }
        for (const p of pJson.data || []) {
          if (posts.length < postsLimit) posts.push(p);
        }
        nextPostsUrl = pJson.paging?.next;
      }
    }

  result.scannedPosts = posts.length;

  const store = readStore();
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  const previews: BackfillPreviewItem[] = [];
  const executionQueue: QueuedBackfillComment[] = [];

  // 2. Scan top-level comments on each post with pagination (up to 200 per post)
  for (const post of posts) {
    const postCtx = extractPostContext(post);
    cachePostContext(post.id, postCtx);
    let nextCommentsUrl: string | undefined = `${GRAPH_BASE}/${
      post.id
    }/comments?fields=id,message,from,created_time,comments.limit(10){id,from}&filter=toplevel&limit=50&access_token=${encodeURIComponent(
      page.accessToken
    )}`;
    let fetchedForPost = 0;

    while (nextCommentsUrl && fetchedForPost < 200) {
      const cRes = await fetch(nextCommentsUrl, { signal: AbortSignal.timeout(15000) });
      const cJson = (await cRes.json()) as {
        data?: GraphCommentNode[];
        paging?: { next?: string };
        error?: { message?: string };
      };
      if (!cRes.ok) {
        break;
      }

      const comments = cJson.data || [];
      fetchedForPost += comments.length;

      for (const comment of comments) {
        if (!comment.message || !comment.id) continue;

        if (cutoffMs && comment.created_time) {
          const createdMs = new Date(comment.created_time).getTime();
          if (!Number.isNaN(createdMs) && createdMs < cutoffMs) {
            continue;
          }
        }

        // Ignore comments authored by the page itself
        if (comment.from?.id === page.id) continue;

        result.scannedComments += 1;

        // Check if already answered locally or directly on Facebook
        const answeredOnFb = (comment.comments?.data || []).some(
          (reply) => reply.from?.id === page.id
        );
        if (answeredOnFb || store.repliedCommentIds.includes(comment.id)) {
          result.alreadyAnsweredByPage += 1;
          continue;
        }

        const matchedRule = matchCommentAgainstRules(
          comment.message,
          page.id,
          post.id,
          store.rules
        );

        if (!matchedRule) {
          result.unmatchedCount += 1;
          continue;
        }

        result.matchedUnansweredCount += 1;

        const commenterName = comment.from?.name || 'مستخدم فيسبوك';
        const createdTime = comment.created_time || new Date().toISOString();
        const dmEligible = Date.now() - new Date(createdTime).getTime() <= sevenDaysMs;

        if (dryRun) {
          if (previews.length < 500) {
            const isAiRule = matchedRule.replyType === 'ai';
            const firstPublic = matchedRule.publicReplies.find((r) => r.trim()) || '';
            previews.push({
              commentId: comment.id,
              postId: post.id,
              postPreview: (postCtx.postMessage || 'منشور مصوّر / بدون نص').slice(0, 80),
              commenterName,
              commentText: comment.message,
              createdTime,
              matchedRuleId: matchedRule.id,
              matchedRuleName: matchedRule.name,
              replyType: isAiRule ? 'ai' : 'template',
              suggestedPublicReply: isAiRule
                ? 'سيتم توليد رد مخصص بالذكاء الاصطناعي عند الإرسال'
                : firstPublic
                ? renderReplyTemplate(firstPublic, commenterName, page.name)
                : undefined,
              suggestedPrivateReply:
                dmEligible && matchedRule.sendPrivateReply
                  ? isAiRule
                    ? 'سيتم توليد رسالة خاصة بالذكاء الاصطناعي عند الإرسال'
                    : matchedRule.privateReplyText.trim()
                    ? renderReplyTemplate(matchedRule.privateReplyText.trim(), commenterName, page.name)
                    : undefined
                  : undefined,
              dmEligible,
            });
          }
          continue;
        }

        // Execution mode: collect comments into a serialized server-side batch queue
        if (selectedSet && !selectedSet.has(comment.id)) {
          continue;
        }
        if (executionQueue.length >= maxReplies) {
          continue;
        }
        executionQueue.push({
          postId: post.id,
          postMessage: postCtx.postMessage,
          postImageUrl: postCtx.postImageUrl,
          commentId: comment.id,
          commenterId: comment.from?.id,
          commenterName,
          commentText: comment.message,
          createdTime,
        });
      }

      nextCommentsUrl = cJson.paging?.next;
    }
  }

    if (!dryRun) {
      const jobId = `bf_${crypto.randomUUID().slice(0, 10)}`;
      const job: InternalBackfillJob = {
        jobId,
        pageId: page.id,
        pageName: page.name,
        status: executionQueue.length === 0 ? 'completed' : 'running',
        totalQueued: executionQueue.length,
        processedCount: 0,
        repliedCount: 0,
        failedCount: 0,
        delaySeconds,
        startedAt: new Date().toISOString(),
        cancelled: false,
      };

      // Keep map bounded to latest 30 jobs
      if (backfillJobs.size >= 30) {
        const oldestKey = backfillJobs.keys().next().value;
        if (oldestKey) backfillJobs.delete(oldestKey);
      }
      backfillJobs.set(jobId, job);

      if (executionQueue.length > 0) {
        workerSpawned = true;
        void runBackfillJobWorker(job, page, executionQueue, delayMs);
      }

      result.job = sanitizeBackfillJob(job);
    }

    result.previews = previews;
    return result;
  } finally {
    if (!dryRun && !workerSpawned) {
      activeBackfillPages.delete(page.id);
    }
  }
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // Integration Config
  app.get('/api/config', (req: Request, res: Response) => {
    const store = readStore();
    const appUrl = getAppUrl(req);
    const creds = getOAuthCredentials();
    const cooldownUntilMs = store.aiStatus.cooldownUntil
      ? new Date(store.aiStatus.cooldownUntil).getTime()
      : 0;
    const inCooldown = cooldownUntilMs > Date.now();

    res.json({
      oauthConfigured: Boolean(creds),
      appUrl,
      oauthCallbackUrl: `${appUrl}/auth/callback`,
      webhookUrl: `${appUrl}/api/webhook/facebook`,
      webhookVerifyToken: store.webhookVerifyToken,
      autoReplyEnabled: store.autoReplyEnabled,
      autoReplyDelaySeconds: store.autoReplyDelaySeconds,
      userConnection: store.userConnection
        ? {
            connected: true,
            userName: store.userConnection.userName,
            connectedAt: store.userConnection.connectedAt,
          }
        : { connected: false },
      aiStatus: {
        configured: isAiConfigured(),
        inCooldown,
        cooldownUntil: inCooldown ? store.aiStatus.cooldownUntil : undefined,
        lastError: store.aiStatus.lastError,
        totalAiGenerated: store.aiStatus.totalAiGenerated,
        totalCacheServed: store.aiStatus.totalCacheServed,
        cachedCount: store.aiReplyCache.length,
      },
      autoSweep: getAutoSweepSummary(store.autoReplyDelaySeconds),
      totalRepliesSent: store.totalRepliesSent,
      totalFailedReplies: store.totalFailedReplies,
    });
  });

  app.get('/api/auto-sweep/status', (_req: Request, res: Response) => {
    const store = readStore();
    const cooldownUntilMs = store.aiStatus.cooldownUntil
      ? new Date(store.aiStatus.cooldownUntil).getTime()
      : 0;
    const inCooldown = cooldownUntilMs > Date.now();
    res.json({
      autoReplyEnabled: store.autoReplyEnabled,
      autoReplyDelaySeconds: store.autoReplyDelaySeconds,
      aiStatus: {
        configured: isAiConfigured(),
        inCooldown,
        cooldownUntil: inCooldown ? store.aiStatus.cooldownUntil : undefined,
        lastError: store.aiStatus.lastError,
        totalAiGenerated: store.aiStatus.totalAiGenerated,
        totalCacheServed: store.aiStatus.totalCacheServed,
        cachedCount: store.aiReplyCache.length,
      },
      autoSweep: getAutoSweepSummary(store.autoReplyDelaySeconds),
      totalRepliesSent: store.totalRepliesSent,
      totalFailedReplies: store.totalFailedReplies,
    });
  });

  app.put('/api/config/auto-reply', (req: Request, res: Response) => {
    const { enabled } = req.body as { enabled?: boolean };
    const store = readStore();
    store.autoReplyEnabled = Boolean(enabled);
    if (store.autoReplyEnabled) {
      // Allow previously unmatched comments to be re-checked with current rules
      store.skippedCommentIds = [];
    } else {
      for (const sweep of activePageSweeps.values()) {
        sweep.cancelled = true;
      }
    }
    writeStore(store);
    res.json({ autoReplyEnabled: store.autoReplyEnabled });
    if (store.autoReplyEnabled) {
      triggerAutoSweepForEnabledPages(false);
    }
  });

  app.put('/api/config/reply-delay', (req: Request, res: Response) => {
    const { delaySeconds } = req.body as { delaySeconds?: number };
    const parsed = Number(delaySeconds);
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > 300) {
      res.status(400).json({ error: 'يرجى إدخال فاصل زمني بين ١ و ٣٠٠ ثانية' });
      return;
    }
    const store = readStore();
    store.autoReplyDelaySeconds = Math.round(parsed);
    writeStore(store);
    res.json({ autoReplyDelaySeconds: store.autoReplyDelaySeconds });
  });

  app.get('/api/ai/cache', (_req: Request, res: Response) => {
    const store = readStore();
    res.json({ cache: store.aiReplyCache.slice(0, 100) });
  });

  app.delete('/api/ai/cache', (_req: Request, res: Response) => {
    const store = readStore();
    store.aiReplyCache = [];
    writeStore(store);
    res.json({ ok: true });
  });

  app.post('/api/ai/reset-cooldown', (_req: Request, res: Response) => {
    const store = readStore();
    store.aiStatus.cooldownUntil = undefined;
    store.aiStatus.consecutiveQuotaHits = 0;
    store.aiStatus.lastError = undefined;
    writeStore(store);
    res.json({ ok: true });
  });

  app.put('/api/config/webhook-token', (req: Request, res: Response) => {
    const { token } = req.body as { token?: string };
    if (!token || !token.trim()) {
      res.status(400).json({ error: 'يرجى إدخال رمز تحقق صالح' });
      return;
    }
    const store = readStore();
    store.webhookVerifyToken = token.trim();
    writeStore(store);
    res.json({ webhookVerifyToken: store.webhookVerifyToken });
  });

  // Cloud Persistence Sync Endpoints (Firestore <-> Server Store)
  app.get('/api/cloud/export', (_req: Request, res: Response) => {
    const store = readStore();
    res.json({
      settings: {
        autoReplyEnabled: store.autoReplyEnabled,
        autoReplyDelaySeconds: store.autoReplyDelaySeconds,
        webhookVerifyToken: store.webhookVerifyToken,
      },
      userConnection: store.userConnection || null,
      pages: store.pages,
      rules: store.rules,
      runtimeState: {
        repliedCommentIds: store.repliedCommentIds.slice(-500),
        totalAiGenerated: store.aiStatus.totalAiGenerated,
        totalCacheServed: store.aiStatus.totalCacheServed,
      },
    });
  });

  app.post('/api/cloud/hydrate', (req: Request, res: Response) => {
    const body = (req.body || {}) as {
      settings?: {
        autoReplyEnabled?: boolean;
        autoReplyDelaySeconds?: number;
        webhookVerifyToken?: string;
      };
      userConnection?: StoredFacebookPage extends never ? never : {
        userId: string;
        userName: string;
        accessToken: string;
        connectedAt: string;
      } | null;
      pages?: StoredFacebookPage[];
      rules?: AutoReplyRule[];
      runtimeState?: {
        repliedCommentIds?: string[];
        totalAiGenerated?: number;
        totalCacheServed?: number;
      };
      mergeLocal?: boolean;
    };

    const store = readStore();
    const mergeLocal = body.mergeLocal !== false;

    if (body.settings) {
      if (typeof body.settings.autoReplyEnabled === 'boolean') {
        store.autoReplyEnabled = body.settings.autoReplyEnabled;
      }
      if (
        typeof body.settings.autoReplyDelaySeconds === 'number' &&
        Number.isFinite(body.settings.autoReplyDelaySeconds)
      ) {
        store.autoReplyDelaySeconds = Math.min(
          Math.max(Math.round(body.settings.autoReplyDelaySeconds), 1),
          300
        );
      }
      if (
        typeof body.settings.webhookVerifyToken === 'string' &&
        body.settings.webhookVerifyToken.trim()
      ) {
        store.webhookVerifyToken = body.settings.webhookVerifyToken.trim();
      }
    }

    if (body.userConnection && typeof body.userConnection.accessToken === 'string') {
      store.userConnection = body.userConnection;
    }

    if (Array.isArray(body.pages)) {
      const mergedPages = new Map<string, StoredFacebookPage>();
      if (mergeLocal) {
        for (const p of store.pages) mergedPages.set(p.id, p);
      }
      for (const p of body.pages) {
        if (p && typeof p.id === 'string' && typeof p.name === 'string') {
          mergedPages.set(p.id, p);
        }
      }
      store.pages = Array.from(mergedPages.values());
    }

    if (Array.isArray(body.rules)) {
      const mergedRules = new Map<string, AutoReplyRule>();
      if (mergeLocal) {
        for (const r of store.rules) mergedRules.set(r.id, r);
      }
      for (const r of body.rules) {
        if (r && typeof r.id === 'string' && typeof r.name === 'string') {
          mergedRules.set(r.id, {
            ...r,
            publicReplies: Array.isArray(r.publicReplies)
              ? r.publicReplies.map(normalizeSpintaxBraces).filter(Boolean)
              : [],
            privateReplyText: normalizeSpintaxBraces(r.privateReplyText || ''),
          });
        }
      }
      store.rules = Array.from(mergedRules.values());
    }

    if (body.runtimeState) {
      if (Array.isArray(body.runtimeState.repliedCommentIds)) {
        const idSet = new Set([...store.repliedCommentIds, ...body.runtimeState.repliedCommentIds]);
        store.repliedCommentIds = Array.from(idSet).slice(-5000);
      }
      if (typeof body.runtimeState.totalAiGenerated === 'number') {
        store.aiStatus.totalAiGenerated = Math.max(
          store.aiStatus.totalAiGenerated,
          body.runtimeState.totalAiGenerated
        );
      }
      if (typeof body.runtimeState.totalCacheServed === 'number') {
        store.aiStatus.totalCacheServed = Math.max(
          store.aiStatus.totalCacheServed,
          body.runtimeState.totalCacheServed
        );
      }
    }

    writeStore(store);
    res.json({
      ok: true,
      hydratedPages: store.pages.length,
      hydratedRules: store.rules.length,
      autoReplyDelaySeconds: store.autoReplyDelaySeconds,
      autoReplyEnabled: store.autoReplyEnabled,
    });

    if (store.autoReplyEnabled && store.pages.some((p) => p.mode === 'live' && p.autoPolling)) {
      triggerAutoSweepForEnabledPages(false);
    }
  });

  // Facebook OAuth URL generator
  app.get('/api/auth/facebook/url', (req: Request, res: Response) => {
    const creds = getOAuthCredentials();
    if (!creds) {
      res.status(400).json({
        error:
          'لم يتم ضبط مفاتيح تطبيق ميتا (FACEBOOK_APP_ID و FACEBOOK_APP_SECRET) في إعدادات البيئة بعد. يمكنك الربط مباشرة باستخدام توكن الصفحة أو ضبط المفاتيح أولاً.',
      });
      return;
    }

    const appUrl = getAppUrl(req);
    const redirectUri = `${appUrl}/auth/callback`;
    const state = crypto.randomBytes(16).toString('hex');
    oauthStates.set(state, Date.now());

    // Prune old states (> 15 mins)
    const cutoff = Date.now() - 15 * 60 * 1000;
    for (const [k, ts] of oauthStates.entries()) {
      if (ts < cutoff) oauthStates.delete(k);
    }

    const params = new URLSearchParams({
      client_id: creds.appId,
      redirect_uri: redirectUri,
      state,
      response_type: 'code',
      scope:
        'pages_show_list,pages_read_engagement,pages_manage_engagement,pages_read_user_content,pages_messaging',
    });

    res.json({
      url: `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth?${params.toString()}`,
    });
  });

  // Facebook OAuth Callback
  const handleOAuthCallback = async (req: Request, res: Response) => {
    const { code, state, error_description: errDesc, error: errCode } = req.query as Record<
      string,
      string | undefined
    >;

    if (errCode || !code) {
      res.status(400).send(`
        <html lang="ar" dir="rtl">
          <body style="font-family: sans-serif; padding: 32px; text-align: center;">
            <h2>تعذر إكمال الربط مع فيسبوك</h2>
            <p>${errDesc || errCode || 'لم يتم استلام رمز التفويض'}</p>
            <script>
              if (window.opener) {
                window.opener.postMessage({ type: 'OAUTH_AUTH_ERROR', error: 'oauth_failed' }, '*');
                setTimeout(() => window.close(), 1800);
              }
            </script>
          </body>
        </html>
      `);
      return;
    }

    if (!state || !oauthStates.has(state)) {
      res.status(400).send('Invalid OAuth state');
      return;
    }
    oauthStates.delete(state);

    const creds = getOAuthCredentials();
    if (!creds) {
      res.status(500).send('OAuth credentials missing');
      return;
    }

    try {
      const appUrl = getAppUrl(req);
      const redirectUri = `${appUrl}/auth/callback`;

      const tokenParams = new URLSearchParams({
        client_id: creds.appId,
        redirect_uri: redirectUri,
        client_secret: creds.appSecret,
        code,
      });

      const tokenRes = await fetch(`${GRAPH_BASE}/oauth/access_token?${tokenParams.toString()}`);
      const tokenJson = (await tokenRes.json()) as {
        access_token?: string;
        error?: { message?: string };
      };

      if (!tokenRes.ok || !tokenJson.access_token) {
        throw new Error(tokenJson.error?.message || 'فشل تبادل رمز التفويض');
      }

      // Fetch user's Facebook Pages with their Page Access Tokens
      const accountsRes = await fetch(
        `${GRAPH_BASE}/me/accounts?fields=id,name,category,picture{url},fan_count,access_token&access_token=${encodeURIComponent(
          tokenJson.access_token
        )}`
      );
      const accountsJson = (await accountsRes.json()) as {
        data?: Array<{
          id: string;
          name: string;
          category?: string;
          picture?: { data?: { url?: string } };
          fan_count?: number;
          access_token?: string;
        }>;
        error?: { message?: string };
      };

      if (!accountsRes.ok) {
        throw new Error(accountsJson.error?.message || 'تعذر جلب قائمة الصفحات');
      }

      const store = readStore();
      const fetchedPages = accountsJson.data || [];
      let addedCount = 0;

      for (const p of fetchedPages) {
        if (!p.access_token) continue;
        const subscribed = await subscribePageWebhook(p.id, p.access_token);
        const existingIdx = store.pages.findIndex((ep) => ep.id === p.id);
        const pageObj: StoredFacebookPage = {
          id: p.id,
          name: p.name,
          category: p.category,
          pictureUrl: p.picture?.data?.url,
          fanCount: p.fan_count,
          mode: 'live',
          autoPolling: true,
          webhookSubscribed: subscribed,
          connectedAt: existingIdx !== -1 ? store.pages[existingIdx].connectedAt : new Date().toISOString(),
          accessToken: p.access_token,
        };
        if (existingIdx !== -1) {
          store.pages[existingIdx] = pageObj;
        } else {
          store.pages.unshift(pageObj);
        }
        addedCount += 1;
      }

      writeStore(store);

      res.send(`
        <html lang="ar" dir="rtl">
          <body style="font-family: sans-serif; padding: 32px; text-align: center;">
            <h2>تم ربط ${addedCount} صفحة فيسبوك بنجاح</h2>
            <p>سيتم إغلاق هذه النافذة تلقائياً...</p>
            <script>
              if (window.opener) {
                window.opener.postMessage({ type: 'OAUTH_AUTH_SUCCESS', count: ${addedCount} }, '*');
                window.close();
              } else {
                window.location.href = '/';
              }
            </script>
          </body>
        </html>
      `);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'خطأ غير متوقع';
      res.status(500).send(`
        <html lang="ar" dir="rtl">
          <body style="font-family: sans-serif; padding: 32px; text-align: center;">
            <h2>حدث خطأ أثناء الربط</h2>
            <p>${msg}</p>
          </body>
        </html>
      `);
    }
  };

  app.get(['/auth/callback', '/auth/callback/'], handleOAuthCallback);

  // Pages API
  app.get('/api/pages', (_req: Request, res: Response) => {
    const store = readStore();
    res.json({ pages: store.pages.map(sanitizePage) });
  });

  async function connectPagesViaToken(cleanToken: string) {
    // Try fetching User profile & all managed Pages via /me/accounts
    const meRes = await fetch(
      `${GRAPH_BASE}/me?fields=id,name&access_token=${encodeURIComponent(cleanToken)}`
    );
    const meJson = (await meRes.json()) as {
      id?: string;
      name?: string;
      error?: { message?: string };
    };

    if (!meRes.ok || !meJson.id || !meJson.name) {
      throw new Error(meJson.error?.message || 'رمز الوصول غير صالح أو منتهي الصلاحية');
    }

    const accounts: Array<{
      id: string;
      name: string;
      category?: string;
      picture?: { data?: { url?: string } };
      fan_count?: number;
      access_token?: string;
    }> = [];

    let nextAccountsUrl: string | undefined = `${GRAPH_BASE}/me/accounts?fields=id,name,category,picture{url},fan_count,access_token&limit=100&access_token=${encodeURIComponent(
      cleanToken
    )}`;
    let isSinglePageToken = false;

    while (nextAccountsUrl) {
      const accRes = await fetch(nextAccountsUrl);
      const accJson = (await accRes.json()) as {
        data?: typeof accounts;
        paging?: { next?: string };
        error?: { message?: string };
      };

      if (!accRes.ok) {
        const errMsg = accJson.error?.message || '';
        // If user pasted a single Page Token instead of a User Token, /me/accounts fails on Page node
        if (errMsg.includes('nonexisting field (accounts)') || errMsg.includes('node type (Page)')) {
          isSinglePageToken = true;
          break;
        }
        throw new Error(errMsg || 'تعذر جلب الصفحات من حساب المستخدم');
      }

      accounts.push(...(accJson.data || []));
      nextAccountsUrl = accJson.paging?.next;
    }

    const store = readStore();

    if (isSinglePageToken) {
      const pageRes = await fetch(
        `${GRAPH_BASE}/me?fields=id,name,category,picture{url},fan_count&access_token=${encodeURIComponent(
          cleanToken
        )}`
      );
      const pageJson = (await pageRes.json()) as {
        id?: string;
        name?: string;
        category?: string;
        picture?: { data?: { url?: string } };
        fan_count?: number;
      };
      if (!pageRes.ok || !pageJson.id || !pageJson.name) {
        throw new Error('تعذر قراءة بيانات الصفحة من الرمز');
      }
      const subscribed = await subscribePageWebhook(pageJson.id, cleanToken);
      const existingIdx = store.pages.findIndex((p) => p.id === pageJson.id);
      const pageObj: StoredFacebookPage = {
        id: pageJson.id,
        name: pageJson.name,
        category: pageJson.category,
        pictureUrl: pageJson.picture?.data?.url,
        fanCount: pageJson.fan_count,
        mode: 'live',
        autoPolling: existingIdx !== -1 ? store.pages[existingIdx].autoPolling : true,
        webhookSubscribed: subscribed,
        connectedAt:
          existingIdx !== -1 ? store.pages[existingIdx].connectedAt : new Date().toISOString(),
        accessToken: cleanToken,
      };
      if (existingIdx !== -1) store.pages[existingIdx] = pageObj;
      else store.pages.unshift(pageObj);
      writeStore(store);

      return {
        mode: 'page' as const,
        connectedCount: 1,
        pages: [sanitizePage(pageObj)],
      };
    }

    if (accounts.length === 0) {
      throw new Error(
        'لم يتم العثور على صفحات في هذا الحساب. تأكد من منح صلاحية pages_show_list لرمز المستخدم واختيار الصفحات المطلوبة.'
      );
    }

    const connectedPages: StoredFacebookPage[] = [];
    for (const p of accounts) {
      if (!p.access_token) continue;
      const subscribed = await subscribePageWebhook(p.id, p.access_token);
      const existingIdx = store.pages.findIndex((ep) => ep.id === p.id);
      const pageObj: StoredFacebookPage = {
        id: p.id,
        name: p.name,
        category: p.category,
        pictureUrl: p.picture?.data?.url,
        fanCount: p.fan_count,
        mode: 'live',
        autoPolling: existingIdx !== -1 ? store.pages[existingIdx].autoPolling : true,
        webhookSubscribed: subscribed,
        connectedAt:
          existingIdx !== -1 ? store.pages[existingIdx].connectedAt : new Date().toISOString(),
        accessToken: p.access_token,
      };
      if (existingIdx !== -1) store.pages[existingIdx] = pageObj;
      else store.pages.unshift(pageObj);
      connectedPages.push(pageObj);
    }

    store.userConnection = {
      userId: meJson.id,
      userName: meJson.name,
      accessToken: cleanToken,
      connectedAt: new Date().toISOString(),
    };
    writeStore(store);

    return {
      mode: 'user' as const,
      userName: meJson.name,
      connectedCount: connectedPages.length,
      pages: connectedPages.map(sanitizePage),
    };
  }

  app.post('/api/pages/connect-token', async (req: Request, res: Response) => {
    const { accessToken } = req.body as { accessToken?: string };
    const cleanToken = accessToken?.trim();
    if (!cleanToken) {
      res.status(400).json({ error: 'يرجى إدخال رمز وصول المستخدم (User Access Token)' });
      return;
    }

    try {
      const result = await connectPagesViaToken(cleanToken);
      res.json(result);
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'تعذر التحقق من الرمز وجلب الصفحات',
      });
    }
  });

  app.post('/api/pages/refresh-user-pages', async (_req: Request, res: Response) => {
    const store = readStore();
    if (!store.userConnection?.accessToken) {
      res.status(400).json({ error: 'لا يوجد رمز مستخدم محفوظ لتحديث الصفحات' });
      return;
    }

    try {
      const result = await connectPagesViaToken(store.userConnection.accessToken);
      res.json(result);
    } catch (err) {
      res.status(400).json({
        error:
          err instanceof Error
            ? err.message
            : 'انتهت صلاحية رمز المستخدم أو تعذر تحديث الصفحات، يرجى إعادة ربط الرمز.',
      });
    }
  });

  app.delete('/api/pages/user-connection', (_req: Request, res: Response) => {
    const store = readStore();
    delete store.userConnection;
    writeStore(store);
    res.json({ ok: true });
  });

  app.post('/api/pages/sandbox', (req: Request, res: Response) => {
    const { name, category } = req.body as { name?: string; category?: string };
    const cleanName = name?.trim();
    if (!cleanName) {
      res.status(400).json({ error: 'يرجى إدخال اسم الصفحة التجريبية' });
      return;
    }

    const store = readStore();
    const pageObj: StoredFacebookPage = {
      id: `sandbox_${crypto.randomUUID().slice(0, 8)}`,
      name: cleanName,
      category: category?.trim() || 'صفحة تجريبية لاختبار القواعد',
      mode: 'sandbox',
      autoPolling: false,
      webhookSubscribed: false,
      connectedAt: new Date().toISOString(),
    };
    store.pages.unshift(pageObj);
    writeStore(store);
    res.json({ page: sanitizePage(pageObj) });
  });

  app.post('/api/pages/enable-all-auto-reply', async (_req: Request, res: Response) => {
    const store = readStore();
    store.autoReplyEnabled = true;
    store.skippedCommentIds = [];

    let enabledPagesCount = 0;
    store.pages = store.pages.map((p) => {
      if (p.mode === 'live') {
        enabledPagesCount += 1;
        return { ...p, autoPolling: true };
      }
      return p;
    });

    // Only create/enable a fallback catch-all rule when NO rules are currently enabled
    const hasAnyEnabledRule = store.rules.some((r) => r.enabled);
    if (!hasAnyEnabledRule) {
      const disabledAiRule = store.rules.find((r) => !r.enabled && r.replyType === 'ai');
      const disabledCatchAll = store.rules.find(
        (r) => !r.enabled && r.pageId === 'all' && r.postId === 'all' && r.matchMode === 'any'
      );
      if (disabledAiRule) {
        disabledAiRule.enabled = true;
        disabledAiRule.updatedAt = new Date().toISOString();
      } else if (disabledCatchAll) {
        disabledCatchAll.enabled = true;
        disabledCatchAll.updatedAt = new Date().toISOString();
      } else if (store.rules.length === 0) {
        const now = new Date().toISOString();
        store.rules.unshift({
          id: `rule_${crypto.randomUUID().slice(0, 8)}`,
          pageId: 'all',
          postId: 'all',
          name: 'الرد التلقائي الشامل على جميع الصفحات',
          enabled: true,
          matchMode: 'any',
          keywords: [],
          excludeKeywords: [],
          replyType: isAiConfigured() ? 'ai' : 'template',
          aiPrompt: '',
          publicReplies: [
            '{أهلاً بك {name}، شكراً لتواصلك معنا ❤️|مرحباً {name}، يسعدنا تعليقك على {page} 🌸|نورتنا يا {name}، شكراً لتفاعلك معنا ✨}',
          ],
          likeComment: true,
          sendPrivateReply: false,
          privateReplyText: '',
          priority: 10,
          triggeredCount: 0,
          createdAt: now,
          updatedAt: now,
        });
      }
    }

    writeStore(store);

    triggerAutoSweepForEnabledPages(true);
    const updatedStore = readStore();
    res.json({
      autoReplyEnabled: true,
      enabledPagesCount,
      pages: updatedStore.pages.map(sanitizePage),
      summary: {
        scannedComments: 0,
        repliedCount: 0,
        skippedCount: 0,
        failedCount: 0,
        pagesScanned: enabledPagesCount,
      },
    });
  });

  app.post('/api/pages/sync-all', async (_req: Request, res: Response) => {
    const store = readStore();
    if (!store.autoReplyEnabled) {
      res.status(400).json({
        error: 'الرد التلقائي متوقف حالياً. قم بتشغيله أولاً لإجراء الفحص والرد.',
      });
      return;
    }
    const summary = await syncAllLivePages(false);
    const updatedStore = readStore();
    res.json({
      summary,
      pages: updatedStore.pages.map(sanitizePage),
    });
  });

  app.patch('/api/pages/:id', (req: Request, res: Response) => {
    const { id } = req.params;
    const { autoPolling } = req.body as { autoPolling?: boolean };
    const store = readStore();
    const idx = store.pages.findIndex((p) => p.id === id);
    if (idx === -1) {
      res.status(404).json({ error: 'الصفحة غير موجودة' });
      return;
    }
    if (typeof autoPolling === 'boolean') {
      store.pages[idx].autoPolling = autoPolling;
      if (!autoPolling && activePageSweeps.has(id)) {
        const sweep = activePageSweeps.get(id);
        if (sweep) sweep.cancelled = true;
      }
    }
    writeStore(store);
    res.json({ page: sanitizePage(store.pages[idx]) });
    if (autoPolling && store.autoReplyEnabled && store.pages[idx].mode === 'live') {
      void sweepPageAllUnansweredComments(store.pages[idx]);
    }
  });

  app.delete('/api/pages/:id', (req: Request, res: Response) => {
    const { id } = req.params;
    const store = readStore();
    store.pages = store.pages.filter((p) => p.id !== id);
    writeStore(store);
    res.json({ ok: true });
  });

  app.get('/api/pages/:id/posts', async (req: Request, res: Response) => {
    const { id } = req.params;
    const store = readStore();
    const page = store.pages.find((p) => p.id === id);
    if (!page) {
      res.status(404).json({ error: 'الصفحة غير موجودة' });
      return;
    }

    if (page.mode === 'sandbox' || !page.accessToken) {
      const samplePosts: FacebookPost[] = [
        {
          id: `${page.id}_post_1`,
          message: 'إطلاق التشكيلة الجديدة لهذا الموسم مع توصيل سريع لجميع المدن.',
          createdTime: new Date(Date.now() - 86400000).toISOString(),
          commentsCount: 0,
        },
        {
          id: `${page.id}_post_2`,
          message: 'عرض نهاية الأسبوع: استفسر عن الأسعار والتفاصيل في التعليقات.',
          createdTime: new Date(Date.now() - 259200000).toISOString(),
          commentsCount: 0,
        },
      ];
      res.json({ posts: samplePosts });
      return;
    }

    try {
      const url = `${GRAPH_BASE}/${page.id}/posts?fields=id,message,created_time,permalink_url,comments.summary(true)&limit=15&access_token=${encodeURIComponent(
        page.accessToken
      )}`;
      const fbRes = await fetch(url);
      const fbJson = (await fbRes.json()) as {
        data?: Array<{
          id: string;
          message?: string;
          created_time: string;
          permalink_url?: string;
          comments?: { summary?: { total_count?: number } };
        }>;
        error?: { message?: string };
      };

      if (!fbRes.ok) {
        res.status(400).json({ error: fbJson.error?.message || 'تعذر جلب المنشورات' });
        return;
      }

      const posts: FacebookPost[] = (fbJson.data || []).map((post) => ({
        id: post.id,
        message: post.message || 'منشور بدون نص',
        createdTime: post.created_time,
        permalinkUrl: post.permalink_url,
        commentsCount: post.comments?.summary?.total_count,
      }));

      res.json({ posts });
    } catch {
      res.status(502).json({ error: 'تعذر الاتصال بخوادم فيسبوك' });
    }
  });

  app.post('/api/pages/:id/sync', async (req: Request, res: Response) => {
    const { id } = req.params;
    const store = readStore();
    if (!store.autoReplyEnabled) {
      res.status(400).json({
        error: 'الرد التلقائي متوقف حالياً. قم بتشغيله من زر التشغيل لإجراء الفحص والرد.',
      });
      return;
    }
    const page = store.pages.find((p) => p.id === id);
    if (!page) {
      res.status(404).json({ error: 'الصفحة غير موجودة' });
      return;
    }

    if (page.mode === 'sandbox') {
      res.status(400).json({
        error: 'هذه صفحة تجريبية. لاختبار التعليقات استخدم أداة اختبار القواعد، أو اربط صفحة فيسبوك حقيقية.',
      });
      return;
    }

    try {
      const summary = await syncLivePageComments(page);
      res.json({ summary });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'تعذر مزامنة التعليقات',
      });
    }
  });

  app.post('/api/pages/:id/backfill', async (req: Request, res: Response) => {
    req.setTimeout(0);
    res.setTimeout(0);

    const { id } = req.params;
    const store = readStore();
    const page = store.pages.find((p) => p.id === id);
    if (!page) {
      res.status(404).json({ error: 'الصفحة غير موجودة' });
      return;
    }

    if (page.mode === 'sandbox') {
      res.status(400).json({
        error: 'ميزة التعليقات القديمة متاحة للصفحات المتصلة مباشرة بفيسبوك.',
      });
      return;
    }

    const options = (req.body || {}) as BackfillOptions;
    if (options.dryRun === false && !store.autoReplyEnabled) {
      res.status(400).json({
        error: 'الرد التلقائي متوقف حالياً. قم بتشغيله أولاً لإرسال الدفعة.',
      });
      return;
    }

    try {
      const result = await backfillOldUnansweredComments(page, options);
      res.json(result);
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'تعذر فحص التعليقات القديمة',
      });
    }
  });

  app.get('/api/pages/:id/backfill/active', (req: Request, res: Response) => {
    const { id } = req.params;
    const active = Array.from(backfillJobs.values()).find(
      (j) => j.pageId === id && j.status === 'running'
    );
    res.json({ job: active ? sanitizeBackfillJob(active) : null });
  });

  app.get('/api/backfill/jobs/:jobId', (req: Request, res: Response) => {
    const { jobId } = req.params;
    const job = backfillJobs.get(jobId);
    if (!job) {
      res.status(404).json({ error: 'لم يتم العثور على مهمة الدفعة' });
      return;
    }
    res.json({ job: sanitizeBackfillJob(job) });
  });

  app.post('/api/backfill/jobs/:jobId/cancel', (req: Request, res: Response) => {
    const { jobId } = req.params;
    const job = backfillJobs.get(jobId);
    if (!job) {
      res.status(404).json({ error: 'لم يتم العثور على مهمة الدفعة' });
      return;
    }
    job.cancelled = true;
    if (job.status === 'running') {
      job.status = 'cancelled';
    }
    res.json({ job: sanitizeBackfillJob(job) });
  });

  // Rules API
  app.get('/api/rules', (_req: Request, res: Response) => {
    const store = readStore();
    res.json({ rules: store.rules });
  });

  app.post('/api/rules', (req: Request, res: Response) => {
    const body = req.body as Partial<AutoReplyRule>;
    if (!body.name?.trim()) {
      res.status(400).json({ error: 'اسم القاعدة مطلوب' });
      return;
    }

    const replyType = body.replyType === 'ai' ? 'ai' : 'template';
    const aiPrompt = (body.aiPrompt || '').trim();
    const publicReplies = Array.isArray(body.publicReplies)
      ? body.publicReplies.map((r) => normalizeSpintaxBraces(r)).filter(Boolean)
      : [];
    const privateReplyText = normalizeSpintaxBraces(body.privateReplyText || '');

    if (
      replyType !== 'ai' &&
      publicReplies.length === 0 &&
      !(body.sendPrivateReply && privateReplyText)
    ) {
      res.status(400).json({ error: 'يجب كتابة رد عام واحد على الأقل أو تفعيل رسالة خاصة' });
      return;
    }

    const now = new Date().toISOString();
    const matchMode: MatchMode =
      body.matchMode === 'exact' || body.matchMode === 'any' ? body.matchMode : 'contains';

    const newRule: AutoReplyRule = {
      id: `rule_${crypto.randomUUID().slice(0, 8)}`,
      pageId: body.pageId || 'all',
      postId: body.postId || 'all',
      postPreview: body.postPreview,
      name: body.name.trim(),
      enabled: body.enabled ?? true,
      matchMode,
      keywords: Array.isArray(body.keywords) ? body.keywords.map((k) => k.trim()).filter(Boolean) : [],
      excludeKeywords: Array.isArray(body.excludeKeywords)
        ? body.excludeKeywords.map((k) => k.trim()).filter(Boolean)
        : [],
      replyType,
      aiPrompt,
      publicReplies,
      likeComment: Boolean(body.likeComment),
      sendPrivateReply: Boolean(body.sendPrivateReply),
      privateReplyText,
      priority: Number(body.priority) || 10,
      triggeredCount: 0,
      createdAt: now,
      updatedAt: now,
    };

    const store = readStore();
    store.rules.unshift(newRule);
    store.skippedCommentIds = [];
    writeStore(store);
    res.status(201).json({ rule: newRule });
    if (newRule.enabled && store.autoReplyEnabled) {
      triggerAutoSweepForEnabledPages(false);
    }
  });

  app.patch('/api/rules/:id', (req: Request, res: Response) => {
    const { id } = req.params;
    const body = req.body as Partial<AutoReplyRule>;
    const store = readStore();
    const idx = store.rules.findIndex((r) => r.id === id);
    if (idx === -1) {
      res.status(404).json({ error: 'القاعدة غير موجودة' });
      return;
    }

    const existing = store.rules[idx];
    const updated: AutoReplyRule = {
      ...existing,
      pageId: body.pageId ?? existing.pageId,
      postId: body.postId ?? existing.postId,
      postPreview: body.postPreview !== undefined ? body.postPreview : existing.postPreview,
      name: body.name !== undefined ? body.name.trim() : existing.name,
      enabled: body.enabled !== undefined ? Boolean(body.enabled) : existing.enabled,
      matchMode: body.matchMode ?? existing.matchMode,
      keywords:
        body.keywords !== undefined
          ? body.keywords.map((k) => k.trim()).filter(Boolean)
          : existing.keywords,
      excludeKeywords:
        body.excludeKeywords !== undefined
          ? body.excludeKeywords.map((k) => k.trim()).filter(Boolean)
          : existing.excludeKeywords,
      replyType:
        body.replyType !== undefined
          ? body.replyType === 'ai'
            ? 'ai'
            : 'template'
          : existing.replyType || 'template',
      aiPrompt: body.aiPrompt !== undefined ? body.aiPrompt.trim() : existing.aiPrompt,
      publicReplies:
        body.publicReplies !== undefined
          ? body.publicReplies.map((r) => normalizeSpintaxBraces(r)).filter(Boolean)
          : existing.publicReplies,
      likeComment: body.likeComment !== undefined ? Boolean(body.likeComment) : existing.likeComment,
      sendPrivateReply:
        body.sendPrivateReply !== undefined ? Boolean(body.sendPrivateReply) : existing.sendPrivateReply,
      privateReplyText:
        body.privateReplyText !== undefined
          ? normalizeSpintaxBraces(body.privateReplyText)
          : existing.privateReplyText,
      priority: body.priority !== undefined ? Number(body.priority) : existing.priority,
      updatedAt: new Date().toISOString(),
    };

    store.rules[idx] = updated;
    store.skippedCommentIds = [];
    writeStore(store);
    res.json({ rule: updated });
    if (updated.enabled && store.autoReplyEnabled) {
      triggerAutoSweepForEnabledPages(false);
    }
  });

  app.delete('/api/rules/:id', (req: Request, res: Response) => {
    const { id } = req.params;
    const store = readStore();
    store.rules = store.rules.filter((r) => r.id !== id);
    store.skippedCommentIds = [];
    writeStore(store);
    res.json({ ok: true });
  });

  // Logs API
  app.get('/api/logs', (req: Request, res: Response) => {
    const { pageId, status, search } = req.query as Record<string, string | undefined>;
    const store = readStore();
    let logs = store.logs;

    if (pageId && pageId !== 'all') {
      logs = logs.filter((l) => l.pageId === pageId);
    }
    if (status && status !== 'all') {
      logs = logs.filter((l) => l.status === status);
    }
    if (search && search.trim()) {
      const q = search.trim().toLowerCase();
      logs = logs.filter(
        (l) =>
          l.commentText.toLowerCase().includes(q) ||
          l.commenterName.toLowerCase().includes(q) ||
          (l.matchedRuleName || '').toLowerCase().includes(q) ||
          (l.publicReplySent || '').toLowerCase().includes(q)
      );
    }

    res.json({ logs });
  });

  app.delete('/api/logs', (_req: Request, res: Response) => {
    const store = readStore();
    store.logs = [];
    writeStore(store);
    res.json({ ok: true });
  });

  // Instant Rule Tester / Simulator
  app.post('/api/tester/simulate', async (req: Request, res: Response) => {
    const { pageId, postId, postMessage, postImageUrl, commenterName, commentText } = req.body as {
      pageId?: string;
      postId?: string;
      postMessage?: string;
      postImageUrl?: string;
      commenterName?: string;
      commentText?: string;
    };

    if (!commentText?.trim()) {
      res.status(400).json({ error: 'يرجى كتابة نص التعليق للاختبار' });
      return;
    }

    const store = readStore();
    const targetPage: StoredFacebookPage =
      store.pages.find((p) => p.id === pageId) ||
      store.pages[0] || {
        id: 'test_page',
        name: 'صفحتك التجريبية',
        mode: 'sandbox',
        autoPolling: false,
        webhookSubscribed: false,
        connectedAt: new Date().toISOString(),
      };

    const resolvedPostId = postId || 'all';
    let resolvedPostMessage = postMessage?.trim() || undefined;
    let resolvedPostImageUrl = postImageUrl?.trim() || undefined;
    if (
      !resolvedPostMessage &&
      !resolvedPostImageUrl &&
      resolvedPostId !== 'all' &&
      targetPage.mode === 'live'
    ) {
      const ctx = await getOrFetchPostContext(targetPage, resolvedPostId);
      resolvedPostMessage = ctx.postMessage;
      resolvedPostImageUrl = ctx.postImageUrl;
    }

    const log = await processIncomingComment({
      page: targetPage,
      postId: resolvedPostId,
      postMessage: resolvedPostMessage,
      postImageUrl: resolvedPostImageUrl,
      commentId: `test_${crypto.randomUUID().slice(0, 8)}`,
      commenterName: commenterName?.trim() || 'أحمد محمد',
      commentText: commentText.trim(),
      source: 'tester',
      store,
    });

    writeStore(store);
    res.json({ result: log });
  });

  // Meta Webhook Verification
  app.get(['/api/webhook/facebook', '/api/webhook/facebook/'], (req: Request, res: Response) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    const store = readStore();

    if (mode === 'subscribe' && token === store.webhookVerifyToken) {
      res.type('text/plain').status(200).send(String(challenge || ''));
      return;
    }
    res.sendStatus(403);
  });

  // Meta Webhook Event Receiver
  app.post(['/api/webhook/facebook', '/api/webhook/facebook/'], async (req: Request, res: Response) => {
    const body = req.body as {
      object?: string;
      entry?: Array<{
        id: string;
        changes?: Array<{
          field: string;
          value?: {
            item?: string;
            verb?: string;
            comment_id?: string;
            post_id?: string;
            message?: string;
            from?: { id?: string; name?: string };
          };
        }>;
      }>;
    };

    if (body.object !== 'page') {
      res.sendStatus(404);
      return;
    }

    // Acknowledge Meta webhook promptly
    res.status(200).send('EVENT_RECEIVED');

    const store = readStore();
    if (!store.autoReplyEnabled) {
      return;
    }

    for (const entry of body.entry || []) {
      const page = store.pages.find((p) => p.id === entry.id);
      if (!page) continue;

      for (const change of entry.changes || []) {
        if (!readStore().autoReplyEnabled) {
          return;
        }
        if (
          change.field === 'feed' &&
          change.value?.item === 'comment' &&
          change.value?.verb === 'add' &&
          change.value?.comment_id &&
          change.value?.message
        ) {
          const targetPostId = change.value.post_id || 'unknown';
          const postCtx = await getOrFetchPostContext(page, targetPostId);
          const log = await processIncomingComment({
            page,
            postId: targetPostId,
            postMessage: postCtx.postMessage,
            postImageUrl: postCtx.postImageUrl,
            commentId: change.value.comment_id,
            commenterId: change.value.from?.id,
            commenterName: change.value.from?.name || 'معلق فيسبوك',
            commentText: change.value.message,
            source: 'webhook',
          });
          if (log && (log.status === 'replied' || log.status === 'failed')) {
            recordLiveReplyProgress(log, postCtx.postMessage?.slice(0, 80));
          }
        }
      }
    }
  });

  // Background Auto-Polling for live pages with autoPolling enabled (every 20s)
  setInterval(() => {
    void syncAllLivePages(false);
  }, 20000);

  // Vite dev middleware or production static build
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on http://localhost:${PORT}`);
    setTimeout(() => {
      triggerAutoSweepForEnabledPages(false);
    }, 3000);
  });
}

startServer();
