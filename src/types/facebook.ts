export type MatchMode = 'contains' | 'exact' | 'any';

export type ReplyType = 'template' | 'ai';

export type PageMode = 'live' | 'sandbox';

export interface FacebookPage {
  id: string;
  name: string;
  category?: string;
  pictureUrl?: string;
  fanCount?: number;
  mode: PageMode;
  autoPolling: boolean;
  webhookSubscribed: boolean;
  connectedAt: string;
  lastSyncedAt?: string;
}

export interface FacebookPost {
  id: string;
  message: string;
  createdTime: string;
  permalinkUrl?: string;
  commentsCount?: number;
}

export interface AutoReplyRule {
  id: string;
  pageId: string;
  postId: string;
  postPreview?: string;
  name: string;
  enabled: boolean;
  matchMode: MatchMode;
  keywords: string[];
  excludeKeywords: string[];
  replyType?: ReplyType;
  aiPrompt?: string;
  publicReplies: string[];
  likeComment: boolean;
  sendPrivateReply: boolean;
  privateReplyText: string;
  priority: number;
  triggeredCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ReplyLogEntry {
  id: string;
  pageId: string;
  pageName: string;
  postId: string;
  commentId: string;
  commenterName: string;
  commentText: string;
  matchedRuleId?: string;
  matchedRuleName?: string;
  publicReplySent?: string;
  privateReplySent?: string;
  likedComment: boolean;
  replySource?: 'rule' | 'ai' | 'ai-cache' | 'fallback';
  source: 'webhook' | 'sync' | 'tester';
  status: 'replied' | 'skipped' | 'failed';
  errorMessage?: string;
  fatalError?: boolean;
  createdAt: string;
}

export interface UserConnectionSummary {
  connected: boolean;
  userName?: string;
  connectedAt?: string;
}

export interface CachedAiReply {
  id: string;
  ruleId: string;
  pageId: string;
  postId?: string;
  postSnippet?: string;
  commentText: string;
  tokens: string[];
  publicReply: string;
  privateReply?: string;
  useCount: number;
  createdAt: string;
}

export interface AiStatusSummary {
  configured: boolean;
  inCooldown: boolean;
  cooldownUntil?: string;
  lastError?: string;
  totalAiGenerated: number;
  totalCacheServed: number;
  cachedCount: number;
}

export interface LiveReplyProgressItem {
  id: string;
  pageId: string;
  pageName: string;
  postId: string;
  postPreview?: string;
  commenterName: string;
  commentText: string;
  replySent?: string;
  privateReplySent?: string;
  replySource?: 'rule' | 'ai' | 'ai-cache' | 'fallback';
  status: 'replied' | 'failed' | 'skipped';
  errorMessage?: string;
  createdAt: string;
}

export interface AutoSweepStatus {
  running: boolean;
  scanning: boolean;
  phase?: 'idle' | 'waiting' | 'sending';
  pagesInProgress: number;
  totalQueued: number;
  processedCount: number;
  remainingCount: number;
  repliedCount: number;
  failedCount: number;
  delaySeconds: number;
  currentPageName?: string;
  currentCommenter?: string;
  currentCommentText?: string;
  nextReplyAt?: string;
  nextReplyInMs?: number;
  serverTime?: string;
  recentItems: LiveReplyProgressItem[];
}

export interface IntegrationConfig {
  oauthConfigured: boolean;
  appUrl: string;
  oauthCallbackUrl: string;
  webhookUrl: string;
  webhookVerifyToken: string;
  autoReplyEnabled: boolean;
  autoReplyDelaySeconds: number;
  totalRepliesSent?: number;
  totalFailedReplies?: number;
  userConnection?: UserConnectionSummary;
  aiStatus?: AiStatusSummary;
  autoSweep?: AutoSweepStatus;
}

export interface ConnectTokenResponse {
  mode: 'user' | 'page';
  userName?: string;
  connectedCount: number;
  pages: FacebookPage[];
}

export interface SyncSummary {
  scannedComments: number;
  repliedCount: number;
  skippedCount: number;
  failedCount: number;
}

export interface BackfillOptions {
  postId?: string;
  postsLimit?: number;
  sinceDays?: number | null;
  maxReplies?: number;
  delaySeconds?: number;
  dryRun?: boolean;
  selectedCommentIds?: string[];
}

export interface BackfillPreviewItem {
  commentId: string;
  postId: string;
  postPreview?: string;
  commenterName: string;
  commentText: string;
  createdTime: string;
  matchedRuleId: string;
  matchedRuleName: string;
  replyType?: ReplyType;
  suggestedPublicReply?: string;
  suggestedPrivateReply?: string;
  dmEligible: boolean;
}

export interface BackfillJobStatus {
  jobId: string;
  pageId: string;
  pageName: string;
  status: 'running' | 'completed' | 'cancelled' | 'failed';
  phase?: 'waiting' | 'sending';
  totalQueued: number;
  processedCount: number;
  repliedCount: number;
  failedCount: number;
  delaySeconds: number;
  startedAt: string;
  lastReplyAt?: string;
  nextReplyAt?: string;
  nextReplyInMs?: number;
  serverTime?: string;
  currentCommenter?: string;
  errorMessage?: string;
}

export interface BackfillResult {
  dryRun: boolean;
  scannedPosts: number;
  scannedComments: number;
  alreadyAnsweredByPage: number;
  unmatchedCount: number;
  matchedUnansweredCount: number;
  repliedCount: number;
  failedCount: number;
  previews: BackfillPreviewItem[];
  job?: BackfillJobStatus;
}

