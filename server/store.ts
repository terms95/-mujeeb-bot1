import fs from 'node:fs';
import path from 'node:path';
import type {
  AutoReplyRule,
  CachedAiReply,
  FacebookPage,
  ReplyLogEntry,
} from '../src/types/facebook.ts';

export interface StoredFacebookPage extends FacebookPage {
  accessToken?: string;
}

export interface RotationState {
  remaining: string[];
  lastPicked?: string;
}

export interface UserConnectionRecord {
  userId: string;
  userName: string;
  accessToken: string;
  connectedAt: string;
}

export interface AiStatusState {
  cooldownUntil?: string;
  lastError?: string;
  consecutiveQuotaHits: number;
  totalAiGenerated: number;
  totalCacheServed: number;
}

export interface StoreData {
  pages: StoredFacebookPage[];
  rules: AutoReplyRule[];
  logs: ReplyLogEntry[];
  repliedCommentIds: string[];
  skippedCommentIds: string[];
  webhookVerifyToken: string;
  autoReplyEnabled: boolean;
  autoReplyDelaySeconds: number;
  spintaxHistory: Record<string, RotationState>;
  userConnection?: UserConnectionRecord;
  aiReplyCache: CachedAiReply[];
  aiStatus: AiStatusState;
  totalRepliesSent: number;
  totalFailedReplies: number;
}

const DATA_DIR = path.join(process.cwd(), 'data');
const STORE_PATH = path.join(DATA_DIR, 'store.json');

function createInitialAiStatus(): AiStatusState {
  return {
    consecutiveQuotaHits: 0,
    totalAiGenerated: 0,
    totalCacheServed: 0,
  };
}

function createInitialStore(): StoreData {
  return {
    pages: [],
    rules: [],
    logs: [],
    repliedCommentIds: [],
    skippedCommentIds: [],
    webhookVerifyToken: process.env.FACEBOOK_WEBHOOK_VERIFY_TOKEN || 'mujeeb_verify_2026',
    autoReplyEnabled: true,
    autoReplyDelaySeconds: 15,
    spintaxHistory: {},
    aiReplyCache: [],
    aiStatus: createInitialAiStatus(),
    totalRepliesSent: 0,
    totalFailedReplies: 0,
  };
}

export function readStore(): StoreData {
  try {
    if (!fs.existsSync(STORE_PATH)) {
      return createInitialStore();
    }
    const raw = fs.readFileSync(STORE_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Partial<StoreData>;
    const logs = Array.isArray(parsed.logs) ? parsed.logs : [];
    const rules = Array.isArray(parsed.rules) ? parsed.rules : [];
    const logReplied = logs.filter((l) => l.status === 'replied' && l.source !== 'tester').length;
    const logFailed = logs.filter((l) => l.status === 'failed' && l.source !== 'tester').length;
    const rulesTriggered = rules.reduce((acc, r) => acc + (Number(r.triggeredCount) || 0), 0);

    return {
      pages: Array.isArray(parsed.pages) ? parsed.pages : [],
      rules,
      logs,
      repliedCommentIds: Array.isArray(parsed.repliedCommentIds) ? parsed.repliedCommentIds : [],
      skippedCommentIds: Array.isArray(parsed.skippedCommentIds) ? parsed.skippedCommentIds : [],
      webhookVerifyToken:
        typeof parsed.webhookVerifyToken === 'string' && parsed.webhookVerifyToken.trim()
          ? parsed.webhookVerifyToken
          : process.env.FACEBOOK_WEBHOOK_VERIFY_TOKEN || 'mujeeb_verify_2026',
      autoReplyEnabled: typeof parsed.autoReplyEnabled === 'boolean' ? parsed.autoReplyEnabled : true,
      autoReplyDelaySeconds:
        typeof parsed.autoReplyDelaySeconds === 'number' &&
        Number.isFinite(parsed.autoReplyDelaySeconds)
          ? Math.min(Math.max(Math.round(parsed.autoReplyDelaySeconds), 1), 300)
          : 15,
      spintaxHistory:
        parsed.spintaxHistory && typeof parsed.spintaxHistory === 'object'
          ? parsed.spintaxHistory
          : {},
      userConnection:
        parsed.userConnection && typeof parsed.userConnection.accessToken === 'string'
          ? parsed.userConnection
          : undefined,
      aiReplyCache: Array.isArray(parsed.aiReplyCache) ? parsed.aiReplyCache : [],
      aiStatus:
        parsed.aiStatus && typeof parsed.aiStatus === 'object'
          ? {
              cooldownUntil: parsed.aiStatus.cooldownUntil,
              lastError: parsed.aiStatus.lastError,
              consecutiveQuotaHits: Number(parsed.aiStatus.consecutiveQuotaHits) || 0,
              totalAiGenerated: Number(parsed.aiStatus.totalAiGenerated) || 0,
              totalCacheServed: Number(parsed.aiStatus.totalCacheServed) || 0,
            }
          : createInitialAiStatus(),
      totalRepliesSent:
        typeof parsed.totalRepliesSent === 'number' && Number.isFinite(parsed.totalRepliesSent)
          ? Math.max(parsed.totalRepliesSent, logReplied)
          : Math.max(logReplied, rulesTriggered),
      totalFailedReplies:
        typeof parsed.totalFailedReplies === 'number' && Number.isFinite(parsed.totalFailedReplies)
          ? Math.max(parsed.totalFailedReplies, logFailed)
          : logFailed,
    };
  } catch {
    return createInitialStore();
  }
}

export function writeStore(data: StoreData): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  const trimmed: StoreData = {
    ...data,
    logs: data.logs.slice(0, 1000),
    repliedCommentIds: data.repliedCommentIds.slice(-5000),
    skippedCommentIds: (data.skippedCommentIds || []).slice(-5000),
    aiReplyCache: data.aiReplyCache.slice(0, 500),
  };
  const tempPath = `${STORE_PATH}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(trimmed, null, 2), 'utf8');
  fs.renameSync(tempPath, STORE_PATH);
}

export function sanitizePage(page: StoredFacebookPage): FacebookPage {
  const { accessToken: _ignored, ...safePage } = page;
  return safePage;
}
