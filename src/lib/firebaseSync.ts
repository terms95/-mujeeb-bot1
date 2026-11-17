import type { User } from 'firebase/auth';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import type { AutoReplyRule, MatchMode, ReplyType } from '../types/facebook';
import { auth, db } from './firebase';
import { api, type CloudStoreSnapshot, type StoredPageRecord } from './api';

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

function sanitizeId(raw: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 128);
  return cleaned || 'default_id';
}

function clampString(val: string | undefined, maxLen: number): string {
  return (val || '').slice(0, maxLen);
}

function sanitizeStringList(list: string[] | undefined, maxItems: number, maxLen: number): string[] {
  if (!Array.isArray(list)) return [];
  return list
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim().slice(0, maxLen))
    .slice(0, maxItems);
}

function buildSettingsPayload(uid: string, settings: CloudStoreSnapshot['settings']) {
  return {
    ownerId: uid,
    autoReplyEnabled: Boolean(settings.autoReplyEnabled),
    autoReplyDelaySeconds: Math.min(
      Math.max(Math.round(Number(settings.autoReplyDelaySeconds) || 15), 1),
      300
    ),
    webhookVerifyToken: clampString(settings.webhookVerifyToken.trim() || 'mujeeb_verify_2026', 200),
  };
}

function buildConnectionPayload(
  uid: string,
  conn: NonNullable<CloudStoreSnapshot['userConnection']>
) {
  return {
    ownerId: uid,
    userId: clampString(conn.userId, 128) || 'fb_user',
    userName: clampString(conn.userName, 200) || 'مستخدم فيسبوك',
    accessToken: clampString(conn.accessToken, 2048),
    connectedAt: clampString(conn.connectedAt || new Date().toISOString(), 64),
  };
}

function buildPagePayload(uid: string, page: StoredPageRecord) {
  const safeId = sanitizeId(page.id);
  const payload: Record<string, unknown> = {
    ownerId: uid,
    id: safeId,
    name: clampString(page.name, 200) || 'صفحة فيسبوك',
    mode: page.mode === 'sandbox' ? 'sandbox' : 'live',
    autoPolling: Boolean(page.autoPolling),
    webhookSubscribed: Boolean(page.webhookSubscribed),
    connectedAt: clampString(page.connectedAt || new Date().toISOString(), 64),
  };
  if (page.category) payload.category = clampString(page.category, 200);
  if (page.pictureUrl) payload.pictureUrl = clampString(page.pictureUrl, 1024);
  if (typeof page.fanCount === 'number' && Number.isFinite(page.fanCount) && page.fanCount >= 0) {
    payload.fanCount = Math.round(page.fanCount);
  }
  if (page.accessToken) payload.accessToken = clampString(page.accessToken, 2048);
  if (page.lastSyncedAt) payload.lastSyncedAt = clampString(page.lastSyncedAt, 64);
  return { safeId, payload };
}

function buildRulePayload(uid: string, rule: AutoReplyRule) {
  const safeId = sanitizeId(rule.id);
  const matchMode: MatchMode =
    rule.matchMode === 'exact' || rule.matchMode === 'any' ? rule.matchMode : 'contains';
  const replyType: ReplyType = rule.replyType === 'ai' ? 'ai' : 'template';
  const payload: Record<string, unknown> = {
    ownerId: uid,
    id: safeId,
    pageId: clampString(rule.pageId || 'all', 128),
    postId: clampString(rule.postId || 'all', 128),
    name: clampString(rule.name, 200) || 'قاعدة رد',
    enabled: Boolean(rule.enabled),
    matchMode,
    keywords: sanitizeStringList(rule.keywords, 50, 200),
    excludeKeywords: sanitizeStringList(rule.excludeKeywords, 50, 200),
    replyType,
    aiPrompt: clampString(rule.aiPrompt, 4000),
    publicReplies: sanitizeStringList(rule.publicReplies, 20, 10000),
    likeComment: Boolean(rule.likeComment),
    sendPrivateReply: Boolean(rule.sendPrivateReply),
    privateReplyText: clampString(rule.privateReplyText, 2000),
    priority: Math.min(Math.max(Math.round(Number(rule.priority) || 10), 0), 10000),
    triggeredCount: Math.max(0, Math.round(Number(rule.triggeredCount) || 0)),
    createdAtIso: clampString(rule.createdAt || new Date().toISOString(), 64),
    updatedAtIso: clampString(rule.updatedAt || new Date().toISOString(), 64),
  };
  if (rule.postPreview) payload.postPreview = clampString(rule.postPreview, 300);
  return { safeId, payload };
}

function buildRuntimePayload(uid: string, runtime: CloudStoreSnapshot['runtimeState']) {
  return {
    ownerId: uid,
    repliedCommentIds: sanitizeStringList(runtime.repliedCommentIds, 500, 128),
    totalAiGenerated: Math.max(0, Math.round(Number(runtime.totalAiGenerated) || 0)),
    totalCacheServed: Math.max(0, Math.round(Number(runtime.totalCacheServed) || 0)),
  };
}

async function upsertDocStrict(
  path: string,
  payload: Record<string, unknown>,
  immutableKeys: string[] = ['ownerId']
): Promise<void> {
  const ref = doc(db, path);
  let exists = false;
  try {
    const snap = await getDoc(ref);
    exists = snap.exists();
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, path);
  }

  if (!exists) {
    try {
      await setDoc(ref, {
        ...payload,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, path);
    }
  } else {
    const updateData: Record<string, unknown> = { ...payload, updatedAt: serverTimestamp() };
    for (const k of immutableKeys) {
      delete updateData[k];
    }
    try {
      await updateDoc(ref, updateData);
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, path);
    }
  }
}

let lastUploadedFingerprint = '';
let lastUploadedUid = '';

function computeSnapshotFingerprint(snap: CloudStoreSnapshot): string {
  return JSON.stringify({
    settings: snap.settings,
    userConnection: snap.userConnection || null,
    pages: snap.pages,
    rules: snap.rules,
    runtimeState: {
      repliedCount: snap.runtimeState.repliedCommentIds.length,
      lastReplied: snap.runtimeState.repliedCommentIds.slice(-3),
      totalAiGenerated: snap.runtimeState.totalAiGenerated,
      totalCacheServed: snap.runtimeState.totalCacheServed,
    },
  });
}

export async function pushSnapshotToCloud(user: User, force = false): Promise<boolean> {
  if (!user.emailVerified) return false;
  const uid = sanitizeId(user.uid);
  const snapshot = await api.exportCloudStore();
  const fp = computeSnapshotFingerprint(snapshot);

  if (!force && lastUploadedUid === uid && lastUploadedFingerprint === fp) {
    return false;
  }

  // 1. Settings
  await upsertDocStrict(
    `users/${uid}/settings/main`,
    buildSettingsPayload(uid, snapshot.settings),
    ['ownerId']
  );

  // 2. User Connection
  const connPath = `users/${uid}/connections/facebook`;
  if (snapshot.userConnection && snapshot.userConnection.accessToken) {
    await upsertDocStrict(
      connPath,
      buildConnectionPayload(uid, snapshot.userConnection),
      ['ownerId']
    );
  } else {
    try {
      const existingConn = await getDoc(doc(db, connPath));
      if (existingConn.exists()) {
        await deleteDoc(doc(db, connPath));
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, connPath);
    }
  }

  // 3. Pages (upsert current & delete removed)
  const pagesColPath = `users/${uid}/pages`;
  let existingPageIds: string[] = [];
  try {
    const q = query(collection(db, pagesColPath), where('ownerId', '==', uid));
    const pageDocs = await getDocs(q);
    existingPageIds = pageDocs.docs.map((d) => d.id);
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, pagesColPath);
  }

  const currentPageIds = new Set<string>();
  for (const page of snapshot.pages) {
    const { safeId, payload } = buildPagePayload(uid, page);
    currentPageIds.add(safeId);
    await upsertDocStrict(`${pagesColPath}/${safeId}`, payload, ['ownerId', 'id']);
  }
  for (const oldId of existingPageIds) {
    if (!currentPageIds.has(oldId)) {
      const delPath = `${pagesColPath}/${oldId}`;
      try {
        await deleteDoc(doc(db, delPath));
      } catch (err) {
        handleFirestoreError(err, OperationType.DELETE, delPath);
      }
    }
  }

  // 4. Rules (upsert current & delete removed)
  const rulesColPath = `users/${uid}/rules`;
  let existingRuleIds: string[] = [];
  try {
    const q = query(collection(db, rulesColPath), where('ownerId', '==', uid));
    const ruleDocs = await getDocs(q);
    existingRuleIds = ruleDocs.docs.map((d) => d.id);
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, rulesColPath);
  }

  const currentRuleIds = new Set<string>();
  for (const rule of snapshot.rules) {
    const { safeId, payload } = buildRulePayload(uid, rule);
    currentRuleIds.add(safeId);
    await upsertDocStrict(`${rulesColPath}/${safeId}`, payload, ['ownerId', 'id']);
  }
  for (const oldId of existingRuleIds) {
    if (!currentRuleIds.has(oldId)) {
      const delPath = `${rulesColPath}/${oldId}`;
      try {
        await deleteDoc(doc(db, delPath));
      } catch (err) {
        handleFirestoreError(err, OperationType.DELETE, delPath);
      }
    }
  }

  // 5. Runtime state
  await upsertDocStrict(
    `users/${uid}/state/runtime`,
    buildRuntimePayload(uid, snapshot.runtimeState),
    ['ownerId']
  );

  lastUploadedUid = uid;
  lastUploadedFingerprint = fp;
  return true;
}

export async function syncWithCloudOnAuth(user: User): Promise<{
  restoredFromCloud: boolean;
  pagesCount: number;
  rulesCount: number;
  delaySeconds: number;
}> {
  if (!user.emailVerified) {
    return { restoredFromCloud: false, pagesCount: 0, rulesCount: 0, delaySeconds: 15 };
  }
  const uid = sanitizeId(user.uid);

  const settingsPath = `users/${uid}/settings/main`;
  const connPath = `users/${uid}/connections/facebook`;
  const pagesColPath = `users/${uid}/pages`;
  const rulesColPath = `users/${uid}/rules`;
  const runtimePath = `users/${uid}/state/runtime`;

  let settingsSnap;
  let connSnap;
  let pagesSnap;
  let rulesSnap;
  let runtimeSnap;

  try {
    settingsSnap = await getDoc(doc(db, settingsPath));
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, settingsPath);
  }
  try {
    connSnap = await getDoc(doc(db, connPath));
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, connPath);
  }
  try {
    pagesSnap = await getDocs(query(collection(db, pagesColPath), where('ownerId', '==', uid)));
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, pagesColPath);
  }
  try {
    rulesSnap = await getDocs(query(collection(db, rulesColPath), where('ownerId', '==', uid)));
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, rulesColPath);
  }
  try {
    runtimeSnap = await getDoc(doc(db, runtimePath));
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, runtimePath);
  }

  const cloudPages: StoredPageRecord[] = pagesSnap.docs.map((d) => {
    const data = d.data();
    return {
      id: String(data.id || d.id),
      name: String(data.name || ''),
      category: typeof data.category === 'string' ? data.category : undefined,
      pictureUrl: typeof data.pictureUrl === 'string' ? data.pictureUrl : undefined,
      fanCount: typeof data.fanCount === 'number' ? data.fanCount : undefined,
      mode: data.mode === 'sandbox' ? 'sandbox' : 'live',
      autoPolling: Boolean(data.autoPolling),
      webhookSubscribed: Boolean(data.webhookSubscribed),
      accessToken: typeof data.accessToken === 'string' ? data.accessToken : undefined,
      connectedAt: String(data.connectedAt || new Date().toISOString()),
      lastSyncedAt: typeof data.lastSyncedAt === 'string' ? data.lastSyncedAt : undefined,
    };
  });

  const cloudRules: AutoReplyRule[] = rulesSnap.docs.map((d) => {
    const data = d.data();
    return {
      id: String(data.id || d.id),
      pageId: String(data.pageId || 'all'),
      postId: String(data.postId || 'all'),
      postPreview: typeof data.postPreview === 'string' ? data.postPreview : undefined,
      name: String(data.name || ''),
      enabled: Boolean(data.enabled),
      matchMode:
        data.matchMode === 'exact' || data.matchMode === 'any' ? data.matchMode : 'contains',
      keywords: Array.isArray(data.keywords) ? data.keywords.map(String) : [],
      excludeKeywords: Array.isArray(data.excludeKeywords) ? data.excludeKeywords.map(String) : [],
      replyType: data.replyType === 'ai' ? 'ai' : 'template',
      aiPrompt: String(data.aiPrompt || ''),
      publicReplies: Array.isArray(data.publicReplies) ? data.publicReplies.map(String) : [],
      likeComment: Boolean(data.likeComment),
      sendPrivateReply: Boolean(data.sendPrivateReply),
      privateReplyText: String(data.privateReplyText || ''),
      priority: Number(data.priority) || 10,
      triggeredCount: Number(data.triggeredCount) || 0,
      createdAt: String(data.createdAtIso || new Date().toISOString()),
      updatedAt: String(data.updatedAtIso || new Date().toISOString()),
    };
  });

  const hasCloudData =
    settingsSnap.exists() ||
    connSnap.exists() ||
    cloudPages.length > 0 ||
    cloudRules.length > 0;

  if (hasCloudData) {
    const settingsData = settingsSnap.exists() ? settingsSnap.data() : undefined;
    const connData = connSnap.exists() ? connSnap.data() : undefined;
    const runtimeData = runtimeSnap.exists() ? runtimeSnap.data() : undefined;

    const hydrated = await api.hydrateCloudStore({
      settings: settingsData
        ? {
            autoReplyEnabled: Boolean(settingsData.autoReplyEnabled),
            autoReplyDelaySeconds: Number(settingsData.autoReplyDelaySeconds) || 15,
            webhookVerifyToken: String(settingsData.webhookVerifyToken || 'mujeeb_verify_2026'),
          }
        : undefined,
      userConnection: connData
        ? {
            userId: String(connData.userId || ''),
            userName: String(connData.userName || ''),
            accessToken: String(connData.accessToken || ''),
            connectedAt: String(connData.connectedAt || new Date().toISOString()),
          }
        : undefined,
      pages: cloudPages,
      rules: cloudRules,
      runtimeState: runtimeData
        ? {
            repliedCommentIds: Array.isArray(runtimeData.repliedCommentIds)
              ? runtimeData.repliedCommentIds.map(String)
              : [],
            totalAiGenerated: Number(runtimeData.totalAiGenerated) || 0,
            totalCacheServed: Number(runtimeData.totalCacheServed) || 0,
          }
        : undefined,
      mergeLocal: true,
    });

    // If server had any additional local rules/pages not yet in cloud, push the merged snapshot
    await pushSnapshotToCloud(user, true);

    return {
      restoredFromCloud: true,
      pagesCount: hydrated.hydratedPages,
      rulesCount: hydrated.hydratedRules,
      delaySeconds: hydrated.autoReplyDelaySeconds,
    };
  }

  // Cloud is empty for this user — upload existing server state immediately
  await pushSnapshotToCloud(user, true);
  const snap = await api.exportCloudStore();
  return {
    restoredFromCloud: false,
    pagesCount: snap.pages.length,
    rulesCount: snap.rules.length,
    delaySeconds: snap.settings.autoReplyDelaySeconds,
  };
}

export function resetCloudSyncFingerprint(): void {
  lastUploadedFingerprint = '';
  lastUploadedUid = '';
}
