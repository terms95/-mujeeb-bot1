import { useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  FileText,
  FlaskConical,
  History,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import type { FacebookPage, FacebookPost, IntegrationConfig } from '../types/facebook';
import { api } from '../lib/api';
import { BackfillModal } from './BackfillModal';

interface PagesViewProps {
  pages: FacebookPage[];
  config: IntegrationConfig | null;
  onConnectPage: () => void;
  onCreateRuleForPost: (pageId: string, post?: FacebookPost) => void;
  onRefresh: () => void;
  onNotify: (type: 'success' | 'error', text: string) => void;
}

export function PagesView({
  pages,
  config,
  onConnectPage,
  onCreateRuleForPost,
  onRefresh,
  onNotify,
}: PagesViewProps) {
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [refreshingAll, setRefreshingAll] = useState(false);
  const [enablingAll, setEnablingAll] = useState(false);
  const [expandedPageId, setExpandedPageId] = useState<string | null>(null);
  const [postsByPage, setPostsByPage] = useState<Record<string, FacebookPost[]>>({});
  const [loadingPostsId, setLoadingPostsId] = useState<string | null>(null);
  const [backfillTarget, setBackfillTarget] = useState<{
    page: FacebookPage;
    post?: FacebookPost | null;
  } | null>(null);

  const handleSync = async (page: FacebookPage) => {
    setSyncingId(page.id);
    try {
      const { summary } = await api.syncPageComments(page.id);
      onNotify(
        'success',
        `تم فحص ${summary.scannedComments} تعليق جديد في "${page.name}": تم الرد على ${summary.repliedCount}، متجاهل ${summary.skippedCount}`
      );
      onRefresh();
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'تعذر مزامنة التعليقات');
    } finally {
      setSyncingId(null);
    }
  };

  const handleToggleAutoPolling = async (page: FacebookPage) => {
    try {
      await api.updatePage(page.id, { autoPolling: !page.autoPolling });
      onNotify(
        'success',
        !page.autoPolling
          ? `تم تفعيل المراقبة الدورية لصفحة "${page.name}"`
          : `تم إيقاف المراقبة الدورية لصفحة "${page.name}"`
      );
      onRefresh();
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'تعذر تحديث إعداد الصفحة');
    }
  };

  const handleTogglePosts = async (page: FacebookPage) => {
    if (expandedPageId === page.id) {
      setExpandedPageId(null);
      return;
    }
    setExpandedPageId(page.id);
    setLoadingPostsId(page.id);
    try {
      const { posts } = await api.getPagePosts(page.id);
      setPostsByPage((prev) => ({ ...prev, [page.id]: posts }));
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'تعذر جلب المنشورات');
    } finally {
      setLoadingPostsId(null);
    }
  };

  const handleDisconnect = async (page: FacebookPage) => {
    try {
      await api.deletePage(page.id);
      onNotify('success', `تم إلغاء ربط صفحة "${page.name}"`);
      onRefresh();
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'تعذر حذف الصفحة');
    }
  };

  const handleRefreshAllFromUser = async () => {
    setRefreshingAll(true);
    try {
      const res = await api.refreshUserPages();
      onNotify('success', `تم تحديث ومزامنة ${res.connectedCount} صفحة من حسابك`);
      onRefresh();
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'تعذر تحديث قائمة الصفحات');
    } finally {
      setRefreshingAll(false);
    }
  };

  const handleEnableAllPages = async () => {
    setEnablingAll(true);
    try {
      const res = await api.enableAllAutoReply();
      onNotify(
        'success',
        `تم تفعيل الرد التلقائي على ${res.enabledPagesCount} صفحة؛ بدأ الرد على جميع التعليقات القديمة والجديدة وفق الفاصل المحدد`
      );
      onRefresh();
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'تعذر تفعيل جميع الصفحات');
    } finally {
      setEnablingAll(false);
    }
  };

  return (
    <div className="space-y-5">
      {config && !config.autoReplyEnabled && (
        <div className="flex items-center gap-2.5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-xs font-medium text-red-700">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>
            الرد التلقائي متوقف حالياً من زر التشغيل الرئيسي — لن يتم إرسال أي ردود عند الفحص أو المراقبة حتى تعيد تشغيله.
          </span>
        </div>
      )}

      <div className="flex flex-col justify-between gap-3 rounded-xl border border-slate-200 bg-white p-5 sm:flex-row sm:items-center">
        <div>
          <h2 className="text-base font-semibold text-slate-900">صفحات فيسبوك المتصلة</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            {config?.userConnection?.connected
              ? `مرتبط بحساب: ${config.userConnection.userName} · يتم جلب وإدارة جميع الصفحات تلقائياً`
              : 'إدارة الصفحات المفعّل عليها الرد التلقائي وجلب المنشورات وفحص التعليقات الجديدة'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 shrink-0">
          {pages.some((p) => p.mode === 'live') && (
            <button
              type="button"
              onClick={handleEnableAllPages}
              disabled={enablingAll}
              className="inline-flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3.5 py-2 text-xs font-semibold text-blue-700 whitespace-nowrap shrink-0 transition-colors hover:bg-blue-100 disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${enablingAll ? 'animate-spin' : ''}`} />
              <span>{enablingAll ? 'جاري التفعيل والفحص...' : 'تشغيل وفحص جميع الصفحات'}</span>
            </button>
          )}
          {config?.userConnection?.connected && (
            <button
              type="button"
              onClick={handleRefreshAllFromUser}
              disabled={refreshingAll}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-medium text-slate-700 whitespace-nowrap shrink-0 transition-colors hover:bg-slate-50 disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${refreshingAll ? 'animate-spin' : ''}`} />
              <span>{refreshingAll ? 'جاري التحديث...' : 'تحديث كل الصفحات'}</span>
            </button>
          )}
          <button
            type="button"
            onClick={onConnectPage}
            className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white whitespace-nowrap shrink-0 transition-colors hover:bg-blue-700"
          >
            <Plus className="h-4 w-4" />
            <span>ربط الحساب / صفحة</span>
          </button>
        </div>
      </div>

      {pages.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white px-6 py-14 text-center">
          <p className="text-base font-semibold text-slate-900">لم تقم بربط أي صفحة فيسبوك بعد</p>
          <p className="mx-auto mt-1.5 max-w-md text-sm text-slate-500">
            يمكنك ربط صفحتك الحقيقية عبر توكن الصفحة أو حساب فيسبوك، أو إنشاء صفحة تجريبية لاختبار القواعد فوراً.
          </p>
          <button
            type="button"
            onClick={onConnectPage}
            className="mt-5 inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            <Plus className="h-4 w-4" />
            <span>ربط صفحة فيسبوك</span>
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          {pages.map((page) => {
            const posts = postsByPage[page.id] || [];
            const isExpanded = expandedPageId === page.id;

            return (
              <section
                key={page.id}
                className="overflow-hidden rounded-xl border border-slate-200 bg-white"
              >
                <div className="flex flex-col justify-between gap-4 p-6 lg:flex-row lg:items-center">
                  <div className="flex items-center gap-4">
                    {page.pictureUrl ? (
                      <img
                        src={page.pictureUrl}
                        alt={page.name}
                        referrerPolicy="no-referrer"
                        className="h-12 w-12 rounded-lg border border-slate-200 object-cover"
                      />
                    ) : (
                      <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-slate-100 text-base font-semibold text-slate-700">
                        {page.name.slice(0, 1)}
                      </div>
                    )}

                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-base font-semibold text-slate-900">{page.name}</h3>
                        <span aria-hidden="true" className="text-slate-300">
                          ·
                        </span>
                        {page.mode === 'live' ? (
                          <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700">
                            <CheckCircle2 className="h-3.5 w-3.5" />
                            <span>ربط مباشر</span>
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-700">
                            <FlaskConical className="h-3.5 w-3.5" />
                            <span>صفحة تجريبية</span>
                          </span>
                        )}
                      </div>

                      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                        <span dir="ltr" className="font-mono tabular-nums">
                          {page.id}
                        </span>
                        {page.category && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span>{page.category}</span>
                          </>
                        )}
                        {typeof page.fanCount === 'number' && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="tabular-nums">
                              {page.fanCount.toLocaleString('ar-EG')} متابع
                            </span>
                          </>
                        )}
                        {page.lastSyncedAt && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="tabular-nums">
                              آخر فحص:{' '}
                              {new Date(page.lastSyncedAt).toLocaleTimeString('ar-EG', {
                                hour: '2-digit',
                                minute: '2-digit',
                              })}
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 shrink-0">
                    {page.mode === 'live' && (
                      <>
                        <button
                          type="button"
                          onClick={() => handleToggleAutoPolling(page)}
                          className={`rounded-lg border px-3 py-1.5 text-xs font-medium whitespace-nowrap transition-colors ${
                            page.autoPolling
                              ? 'border-emerald-200 bg-emerald-50 text-emerald-800 hover:bg-emerald-100'
                              : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
                          }`}
                        >
                          {page.autoPolling ? 'المراقبة التلقائية: مفعّلة' : 'المراقبة التلقائية: متوقفة'}
                        </button>

                        <button
                          type="button"
                          onClick={() => handleSync(page)}
                          disabled={syncingId === page.id}
                          className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white whitespace-nowrap transition-colors hover:bg-blue-700 disabled:opacity-50"
                        >
                          <RefreshCw
                            className={`h-3.5 w-3.5 ${syncingId === page.id ? 'animate-spin' : ''}`}
                          />
                          <span>
                            {syncingId === page.id ? 'جاري الفحص...' : 'فحص التعليقات والرد الآن'}
                          </span>
                        </button>

                        <button
                          type="button"
                          onClick={() => setBackfillTarget({ page, post: null })}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 whitespace-nowrap hover:bg-slate-50"
                        >
                          <History className="h-3.5 w-3.5" />
                          <span>التعليقات القديمة</span>
                        </button>
                      </>
                    )}

                    <button
                      type="button"
                      onClick={() => handleTogglePosts(page)}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 whitespace-nowrap hover:bg-slate-50"
                    >
                      <FileText className="h-3.5 w-3.5" />
                      <span>{isExpanded ? 'إخفاء المنشورات' : 'منشورات الصفحة'}</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => onCreateRuleForPost(page.id)}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 whitespace-nowrap hover:bg-slate-50"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      <span>إضافة قاعدة</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => handleDisconnect(page)}
                      aria-label="إلغاء ربط الصفحة"
                      className="rounded-lg border border-slate-200 bg-white p-1.5 text-slate-400 transition-colors hover:border-red-200 hover:bg-red-50 hover:text-red-600"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>

                {isExpanded && (
                  <div className="border-t border-slate-200 bg-slate-50/70 px-6 py-4">
                    <div className="mb-3 flex items-center justify-between">
                      <h4 className="text-xs font-semibold text-slate-700">
                        أحدث منشورات الصفحة
                      </h4>
                      <span className="text-xs text-slate-500">
                        اختر منشوراً لإنشاء قاعدة رد مخصصة له
                      </span>
                    </div>

                    {loadingPostsId === page.id ? (
                      <p className="py-4 text-xs text-slate-500">جاري جلب المنشورات...</p>
                    ) : posts.length === 0 ? (
                      <p className="py-4 text-xs text-slate-500">لا توجد منشورات متاحة للعرض.</p>
                    ) : (
                      <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">
                        {posts.map((post) => (
                          <li
                            key={post.id}
                            className="flex flex-col justify-between gap-3 px-4 py-3 sm:flex-row sm:items-center"
                          >
                            <div className="min-w-0 space-y-1">
                              <p className="line-clamp-2 text-sm text-slate-800">{post.message}</p>
                              <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                                <span className="tabular-nums">
                                  {new Date(post.createdTime).toLocaleDateString('ar-EG')}
                                </span>
                                {typeof post.commentsCount === 'number' && (
                                  <>
                                    <span aria-hidden="true">·</span>
                                    <span className="tabular-nums">{post.commentsCount} تعليق</span>
                                  </>
                                )}
                                {post.permalinkUrl && (
                                  <>
                                    <span aria-hidden="true">·</span>
                                    <a
                                      href={post.permalinkUrl}
                                      target="_blank"
                                      rel="noreferrer"
                                      className="inline-flex items-center gap-1 text-blue-600 hover:underline"
                                    >
                                      <span>فتح في فيسبوك</span>
                                      <ExternalLink className="h-3 w-3" />
                                    </a>
                                  </>
                                )}
                              </div>
                            </div>

                            <div className="flex items-center gap-2 shrink-0">
                              {page.mode === 'live' && (
                                <button
                                  type="button"
                                  onClick={() => setBackfillTarget({ page, post })}
                                  className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 whitespace-nowrap hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700"
                                >
                                  رد على التعليقات القديمة
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => onCreateRuleForPost(page.id, post)}
                                className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 whitespace-nowrap shrink-0 hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700"
                              >
                                تخصيص رد للمنشور
                              </button>
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}

      <BackfillModal
        open={Boolean(backfillTarget)}
        page={backfillTarget?.page || null}
        presetPost={backfillTarget?.post || null}
        defaultDelaySeconds={config?.autoReplyDelaySeconds}
        onClose={() => setBackfillTarget(null)}
        onCompleted={(msg) => {
          onNotify('success', msg);
          onRefresh();
        }}
      />
    </div>
  );
}
