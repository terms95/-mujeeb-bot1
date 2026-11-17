import type {
  AiStatusSummary,
  AutoReplyRule,
  AutoSweepStatus,
  BackfillJobStatus,
  BackfillOptions,
  BackfillResult,
  CachedAiReply,
  ConnectTokenResponse,
  FacebookPage,
  FacebookPost,
  IntegrationConfig,
  ReplyLogEntry,
  SyncSummary,
} from '../types/facebook';

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      ...(options?.headers || {}),
    },
    ...options,
  });

  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    throw new Error(data.error || `تعذر إتمام الطلب (${res.status})`);
  }
  return data;
}

export const api = {
  getConfig: () => request<IntegrationConfig>('/api/config'),

  getAutoSweepStatus: () =>
    request<{
      autoReplyEnabled: boolean;
      autoReplyDelaySeconds: number;
      totalRepliesSent: number;
      totalFailedReplies: number;
      aiStatus: AiStatusSummary;
      autoSweep: AutoSweepStatus;
    }>('/api/auto-sweep/status'),

  setAutoReplyEnabled: (enabled: boolean) =>
    request<{ autoReplyEnabled: boolean }>('/api/config/auto-reply', {
      method: 'PUT',
      body: JSON.stringify({ enabled }),
    }),

  updateAutoReplyDelay: (delaySeconds: number) =>
    request<{ autoReplyDelaySeconds: number }>('/api/config/reply-delay', {
      method: 'PUT',
      body: JSON.stringify({ delaySeconds }),
    }),

  getAiCache: () => request<{ cache: CachedAiReply[] }>('/api/ai/cache'),

  clearAiCache: () =>
    request<{ ok: boolean }>('/api/ai/cache', {
      method: 'DELETE',
    }),

  resetAiCooldown: () =>
    request<{ ok: boolean }>('/api/ai/reset-cooldown', {
      method: 'POST',
    }),

  updateWebhookToken: (token: string) =>
    request<{ webhookVerifyToken: string }>('/api/config/webhook-token', {
      method: 'PUT',
      body: JSON.stringify({ token }),
    }),

  getFacebookAuthUrl: () => request<{ url: string }>('/api/auth/facebook/url'),

  getPages: () => request<{ pages: FacebookPage[] }>('/api/pages'),

  connectPageToken: (accessToken: string) =>
    request<ConnectTokenResponse>('/api/pages/connect-token', {
      method: 'POST',
      body: JSON.stringify({ accessToken }),
    }),

  refreshUserPages: () =>
    request<ConnectTokenResponse>('/api/pages/refresh-user-pages', {
      method: 'POST',
    }),

  disconnectUserConnection: () =>
    request<{ ok: boolean }>('/api/pages/user-connection', {
      method: 'DELETE',
    }),

  createSandboxPage: (name: string, category?: string) =>
    request<{ page: FacebookPage }>('/api/pages/sandbox', {
      method: 'POST',
      body: JSON.stringify({ name, category }),
    }),

  updatePage: (id: string, payload: { autoPolling?: boolean }) =>
    request<{ page: FacebookPage }>(`/api/pages/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),

  deletePage: (id: string) =>
    request<{ ok: boolean }>(`/api/pages/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),

  getPagePosts: (id: string) =>
    request<{ posts: FacebookPost[] }>(`/api/pages/${encodeURIComponent(id)}/posts`),

  syncPageComments: (id: string) =>
    request<{ summary: SyncSummary }>(`/api/pages/${encodeURIComponent(id)}/sync`, {
      method: 'POST',
    }),

  enableAllAutoReply: () =>
    request<{
      autoReplyEnabled: boolean;
      enabledPagesCount: number;
      pages: FacebookPage[];
      summary: SyncSummary & { pagesScanned: number };
    }>('/api/pages/enable-all-auto-reply', {
      method: 'POST',
    }),

  syncAllPages: () =>
    request<{
      summary: SyncSummary & { pagesScanned: number };
      pages: FacebookPage[];
    }>('/api/pages/sync-all', {
      method: 'POST',
    }),

  backfillPageComments: (id: string, options: BackfillOptions) =>
    request<BackfillResult>(`/api/pages/${encodeURIComponent(id)}/backfill`, {
      method: 'POST',
      body: JSON.stringify(options),
    }),

  getActiveBackfillJob: (pageId: string) =>
    request<{ job: BackfillJobStatus | null }>(
      `/api/pages/${encodeURIComponent(pageId)}/backfill/active`
    ),

  getBackfillJob: (jobId: string) =>
    request<{ job: BackfillJobStatus }>(`/api/backfill/jobs/${encodeURIComponent(jobId)}`),

  cancelBackfillJob: (jobId: string) =>
    request<{ job: BackfillJobStatus }>(`/api/backfill/jobs/${encodeURIComponent(jobId)}/cancel`, {
      method: 'POST',
    }),

  getRules: () => request<{ rules: AutoReplyRule[] }>('/api/rules'),

  createRule: (payload: Partial<AutoReplyRule>) =>
    request<{ rule: AutoReplyRule }>('/api/rules', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  updateRule: (id: string, payload: Partial<AutoReplyRule>) =>
    request<{ rule: AutoReplyRule }>(`/api/rules/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),

  deleteRule: (id: string) =>
    request<{ ok: boolean }>(`/api/rules/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),

  getLogs: (params?: { pageId?: string; status?: string; search?: string }) => {
    const query = new URLSearchParams();
    if (params?.pageId && params.pageId !== 'all') query.set('pageId', params.pageId);
    if (params?.status && params.status !== 'all') query.set('status', params.status);
    if (params?.search) query.set('search', params.search);
    const qs = query.toString();
    return request<{ logs: ReplyLogEntry[] }>(`/api/logs${qs ? `?${qs}` : ''}`);
  },

  clearLogs: () =>
    request<{ ok: boolean }>('/api/logs', {
      method: 'DELETE',
    }),

  simulateComment: (payload: {
    pageId?: string;
    postId?: string;
    commenterName: string;
    commentText: string;
  }) =>
    request<{ result: ReplyLogEntry }>('/api/tester/simulate', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  exportCloudStore: () => request<CloudStoreSnapshot>('/api/cloud/export'),

  hydrateCloudStore: (payload: Partial<CloudStoreSnapshot> & { mergeLocal?: boolean }) =>
    request<{
      ok: boolean;
      hydratedPages: number;
      hydratedRules: number;
      autoReplyDelaySeconds: number;
      autoReplyEnabled: boolean;
    }>('/api/cloud/hydrate', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
};

export interface StoredPageRecord extends FacebookPage {
  accessToken?: string;
}

export interface CloudStoreSnapshot {
  settings: {
    autoReplyEnabled: boolean;
    autoReplyDelaySeconds: number;
    webhookVerifyToken: string;
  };
  userConnection: {
    userId: string;
    userName: string;
    accessToken: string;
    connectedAt: string;
  } | null;
  pages: StoredPageRecord[];
  rules: AutoReplyRule[];
  runtimeState: {
    repliedCommentIds: string[];
    totalAiGenerated: number;
    totalCacheServed: number;
  };
}
