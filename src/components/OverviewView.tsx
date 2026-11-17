import { useEffect, useState } from 'react';
import {
  AlertCircle,
  ArrowUpLeft,
  CheckCircle2,
  Clock,
  Cloud,
  Database,
  MessageSquareReply,
  Plus,
  Power,
  RefreshCw,
  Slash,
  Sparkles,
} from 'lucide-react';
import type {
  AiStatusSummary,
  AutoReplyRule,
  AutoSweepStatus,
  FacebookPage,
  LiveReplyProgressItem,
  ReplyLogEntry,
} from '../types/facebook';
import { RuleTester } from './RuleTester';

interface OverviewViewProps {
  pages: FacebookPage[];
  rules: AutoReplyRule[];
  logs: ReplyLogEntry[];
  autoReplyEnabled: boolean;
  autoReplyDelaySeconds: number;
  totalRepliesSent?: number;
  totalFailedReplies?: number;
  togglingAutoReply: boolean;
  enablingAllPages: boolean;
  aiStatus?: AiStatusSummary;
  autoSweep?: AutoSweepStatus;
  cloudEmail?: string | null;
  cloudSyncing?: boolean;
  onCloudSignIn?: () => void;
  onUpdateReplyDelay?: (delaySeconds: number) => Promise<void>;
  onToggleAutoReply: () => void;
  onEnableAllAutoReply: () => void;
  onConnectPage: () => void;
  onCreateRule: () => void;
  onNavigate: (tab: 'overview' | 'rules' | 'pages' | 'logs' | 'settings') => void;
  onRefresh: () => void;
}

export function OverviewView({
  pages,
  rules,
  logs,
  autoReplyEnabled,
  autoReplyDelaySeconds,
  totalRepliesSent,
  totalFailedReplies,
  togglingAutoReply,
  enablingAllPages,
  aiStatus,
  autoSweep,
  cloudEmail,
  cloudSyncing,
  onCloudSignIn,
  onUpdateReplyDelay,
  onToggleAutoReply,
  onEnableAllAutoReply,
  onConnectPage,
  onCreateRule,
  onNavigate,
  onRefresh,
}: OverviewViewProps) {
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [countdownTargetMs, setCountdownTargetMs] = useState<number | null>(null);
  const [delayDraft, setDelayDraft] = useState<string>(String(autoReplyDelaySeconds));
  const [savingDelay, setSavingDelay] = useState(false);

  useEffect(() => {
    setDelayDraft(String(autoReplyDelaySeconds));
  }, [autoReplyDelaySeconds]);

  useEffect(() => {
    if (!autoSweep?.running || autoSweep.phase === 'sending') {
      setCountdownTargetMs(null);
      return;
    }
    const receivedAt = Date.now();
    let computedTarget: number | null = null;
    if (typeof autoSweep.nextReplyInMs === 'number') {
      computedTarget = autoSweep.nextReplyInMs > 0 ? receivedAt + autoSweep.nextReplyInMs : null;
    } else if (autoSweep.nextReplyAt) {
      const nextMs = new Date(autoSweep.nextReplyAt).getTime();
      const serverNow = autoSweep.serverTime ? new Date(autoSweep.serverTime).getTime() : receivedAt;
      const diff = Number.isNaN(nextMs) ? 0 : Math.max(0, nextMs - serverNow);
      computedTarget = diff > 0 ? receivedAt + diff : null;
    }
    setNowMs(receivedAt);
    setCountdownTargetMs((prev) => {
      if (computedTarget === null) return null;
      if (prev === null || Math.abs(computedTarget - prev) > 1200) return computedTarget;
      return prev;
    });
  }, [
    autoSweep?.running,
    autoSweep?.phase,
    autoSweep?.nextReplyInMs,
    autoSweep?.nextReplyAt,
    autoSweep?.serverTime,
  ]);

  useEffect(() => {
    if (!autoSweep?.running && !autoSweep?.scanning) return;
    setNowMs(Date.now());
    const t = setInterval(() => setNowMs(Date.now()), 250);
    return () => clearInterval(t);
  }, [autoSweep?.running, autoSweep?.scanning]);

  const handleQuickSaveDelay = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!onUpdateReplyDelay) return;
    const parsed = Math.round(Number(delayDraft));
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > 300) return;
    setSavingDelay(true);
    try {
      await onUpdateReplyDelay(parsed);
    } finally {
      setSavingDelay(false);
    }
  };

  const activeRulesCount = rules.filter((r) => r.enabled).length;
  const repliedCount = totalRepliesSent ?? logs.filter((l) => l.status === 'replied').length;
  const failedCount = totalFailedReplies ?? logs.filter((l) => l.status === 'failed').length;
  const livePages = pages.filter((p) => p.mode === 'live');
  const pollingPagesCount = livePages.filter((p) => p.autoPolling).length;
  const hasCatchAllRule = rules.some(
    (r) => r.enabled && r.pageId === 'all' && r.postId === 'all' && r.matchMode === 'any'
  );

  const remainingCount = autoSweep?.remainingCount ?? 0;
  const sweepTotal = autoSweep?.totalQueued ?? 0;
  const sweepProcessed = autoSweep?.processedCount ?? 0;
  const sweepProgressPct =
    sweepTotal > 0 ? Math.min(100, Math.round((sweepProcessed / sweepTotal) * 100)) : 0;

  const nextSeconds =
    autoSweep?.running && autoSweep.phase !== 'sending' && countdownTargetMs !== null
      ? Math.max(0, Math.ceil((countdownTargetMs - nowMs) / 1000))
      : null;

  // Merge live progress items with persisted logs (prioritizing newest live items without duplicates)
  const mergedActivity: LiveReplyProgressItem[] = (() => {
    const map = new Map<string, LiveReplyProgressItem>();
    for (const item of autoSweep?.recentItems || []) {
      map.set(item.id, item);
    }
    for (const log of logs.slice(0, 20)) {
      if (!map.has(log.id)) {
        map.set(log.id, {
          id: log.id,
          pageId: log.pageId,
          pageName: log.pageName,
          postId: log.postId,
          commenterName: log.commenterName,
          commentText: log.commentText,
          replySent: log.publicReplySent,
          privateReplySent: log.privateReplySent,
          replySource: log.replySource,
          status: log.status,
          errorMessage: log.errorMessage,
          createdAt: log.createdAt,
        });
      }
    }
    return Array.from(map.values())
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, 10);
  })();

  return (
    <div className="space-y-6">
      {/* Immediate Master Auto-Reply Control Bar */}
      <div
        className={`flex flex-col justify-between gap-4 rounded-xl border p-4 sm:flex-row sm:items-center ${
          autoReplyEnabled
            ? 'border-emerald-200 bg-white'
            : 'border-red-200 bg-red-50/60'
        }`}
      >
        <div className="flex items-start gap-3">
          <div
            className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${
              autoReplyEnabled
                ? 'bg-emerald-50 text-emerald-700'
                : 'bg-red-100 text-red-700'
            }`}
          >
            <Power className="h-4 w-4" />
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-semibold text-slate-900">
                {autoReplyEnabled
                  ? 'نظام الرد التلقائي مُشغّل حالياً'
                  : 'تم إيقاف الرد التلقائي مؤقتاً'}
              </h2>
              {aiStatus && (
                <>
                  <span aria-hidden="true" className="text-slate-300">
                    ·
                  </span>
                  <span className="inline-flex items-center gap-1 text-xs text-slate-600">
                    <Sparkles className="h-3.5 w-3.5 text-blue-600" />
                    <span>
                      {aiStatus.inCooldown
                        ? 'الذكاء الاصطناعي في تهدئة (يعمل عبر الذاكرة المخزنة)'
                        : aiStatus.configured
                        ? `الرد الذكي جاهز (${aiStatus.cachedCount} رد مخزن)`
                        : 'الرد الذكي بانتظار التفعيل'}
                    </span>
                  </span>
                </>
              )}
            </div>
            <p className="mt-0.5 text-xs text-slate-600 tabular-nums">
              {autoReplyEnabled
                ? `يعمل على التعليقات القديمة والجديدة غير المردود عليها على ${pollingPagesCount} من ${livePages.length} صفحات · الفاصل الفعلي المعتمد: ${autoReplyDelaySeconds} ثانية${
                    hasCatchAllRule ? ' · التغطية الشاملة مفعّلة' : ''
                  }`
                : 'لن يتم إرسال أي ردود عامة أو رسائل خاصة للتعليقات الجديدة أو القديمة حتى تضغط زر التشغيل.'}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          {livePages.length > 0 && (
            <button
              type="button"
              onClick={onEnableAllAutoReply}
              disabled={enablingAllPages}
              className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-blue-200 bg-blue-50 px-3.5 py-2 text-xs font-semibold text-blue-700 whitespace-nowrap shrink-0 transition-colors hover:bg-blue-100 disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${enablingAllPages ? 'animate-spin' : ''}`} />
              <span>
                {enablingAllPages ? 'جاري الفحص...' : 'تشغيل وفحص جميع الصفحات الآن'}
              </span>
            </button>
          )}
          <button
            type="button"
            onClick={onToggleAutoReply}
            disabled={togglingAutoReply}
            aria-pressed={autoReplyEnabled}
            className={`inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-xs font-semibold whitespace-nowrap shrink-0 transition-colors ${
              autoReplyEnabled
                ? 'border border-red-200 bg-white text-red-700 hover:bg-red-50'
                : 'bg-emerald-600 text-white hover:bg-emerald-700'
            }`}
          >
            <Power className="h-3.5 w-3.5" />
            <span>{autoReplyEnabled ? 'إيقاف الرد التلقائي فوراً' : 'تشغيل الرد التلقائي فوراً'}</span>
          </button>
        </div>
      </div>

      {/* Inline Manual Reply Delay & Cloud Persistence Strip */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <form
          onSubmit={handleQuickSaveDelay}
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-5 py-3.5 lg:col-span-6"
        >
          <div className="flex items-center gap-2.5">
            <Clock className="h-4 w-4 shrink-0 text-blue-600" />
            <div>
              <p className="text-xs font-semibold text-slate-900">
                الفاصل الزمني الفعلي بين الردود
              </p>
              <p className="text-[11px] text-slate-500 tabular-nums">
                المُعتمد حالياً: {autoReplyDelaySeconds} ثانية بين كل رد وآخر على فيسبوك
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={1}
              max={300}
              step={1}
              aria-label="الفاصل الزمني بالثواني"
              value={delayDraft}
              onChange={(e) => setDelayDraft(e.target.value)}
              className="w-20 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 font-mono text-xs tabular-nums text-slate-900 focus:border-blue-600 focus:outline-none"
            />
            <span className="text-xs text-slate-500">ثانية</span>
            <button
              type="submit"
              disabled={savingDelay}
              className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white whitespace-nowrap transition-colors hover:bg-slate-800 disabled:opacity-50"
            >
              {savingDelay ? 'حفظ...' : 'حفظ الفاصل'}
            </button>
          </div>
        </form>

        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-5 py-3.5 lg:col-span-6">
          <div className="flex items-center gap-2.5 min-w-0">
            <Cloud
              className={`h-4 w-4 shrink-0 ${cloudEmail ? 'text-emerald-600' : 'text-amber-600'}`}
            />
            <div className="min-w-0">
              <p className="text-xs font-semibold text-slate-900">
                {cloudEmail
                  ? 'الحفظ السحابي الدائم مُفعّل (Firestore)'
                  : 'الحفظ السحابي الدائم غير مربوط بعد'}
              </p>
              <p className="truncate text-[11px] text-slate-500">
                {cloudEmail
                  ? `جميع القواعد والإعدادات والفاصل الزمني محفوظة لحساب: ${cloudEmail}`
                  : 'سجّل الدخول بحساب جوجل لحفظ إعداداتك وقواعدك وصفحاتك بشكل دائم'}
              </p>
            </div>
          </div>
          {!cloudEmail && onCloudSignIn && (
            <button
              type="button"
              onClick={onCloudSignIn}
              disabled={cloudSyncing}
              className="rounded-lg bg-blue-600 px-3.5 py-1.5 text-xs font-semibold text-white whitespace-nowrap shrink-0 transition-colors hover:bg-blue-700 disabled:opacity-50"
            >
              {cloudSyncing ? 'جاري الربط...' : 'ربط جوجل للحفظ الدائم'}
            </button>
          )}
        </div>
      </div>

      {/* Live Unanswered Comments Countdown & Execution Monitor */}
      <section className="rounded-xl border border-slate-200 bg-white p-5">
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
          <div className="flex items-center gap-4">
            <div
              className={`flex h-14 w-14 shrink-0 items-center justify-center rounded-xl border ${
                remainingCount > 0 || autoSweep?.scanning
                  ? 'border-blue-200 bg-blue-50 text-blue-700'
                  : 'border-slate-200 bg-slate-50 text-slate-600'
              }`}
            >
              <span className="font-mono text-2xl font-bold tabular-nums">{remainingCount}</span>
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-semibold text-slate-900">
                  عداد التعليقات غير المردود عليها (المتبقي في الدورة الحالية)
                </h3>
                {autoSweep?.scanning && (
                  <span className="inline-flex items-center gap-1 text-xs font-medium text-blue-700">
                    <RefreshCw className="h-3 w-3 animate-spin" />
                    <span>جاري فحص الصفحات وحصر التعليقات...</span>
                  </span>
                )}
              </div>
              <p className="mt-1 text-xs text-slate-600 tabular-nums">
                {autoSweep?.running ? (
                  <>
                    المجدول بالدورة: <span className="font-semibold text-slate-900">{sweepTotal}</span> · تم الرد بالدورة:{' '}
                    <span className="font-semibold text-emerald-700">{autoSweep.repliedCount}</span>
                    {autoSweep.failedCount > 0 ? (
                      <>
                        {' '}· فشل بالدورة:{' '}
                        <span className="font-semibold text-red-600">{autoSweep.failedCount}</span>
                      </>
                    ) : null}
                    {autoSweep.phase === 'sending' || (nextSeconds !== null && nextSeconds <= 0) ? (
                      <>
                        {' '}·{' '}
                        <span className="font-semibold text-blue-700">
                          جاري توليد وإرسال الرد الآن...
                        </span>
                      </>
                    ) : nextSeconds !== null && nextSeconds > 0 ? (
                      <>
                        {' '}· الرد التالي خلال{' '}
                        <span className="font-mono font-semibold text-blue-700">{nextSeconds} ث</span>
                      </>
                    ) : null}
                  </>
                ) : (
                  'يتناقص هذا العداد تلقائياً بمقدار ١ مع كل رد فعلي يتم إرساله للتعليقات القديمة والجديدة.'
                )}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={onRefresh}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              <span>تحديث العداد</span>
            </button>
          </div>
        </div>

        {autoSweep?.running && (
          <div className="mt-4 space-y-3 border-t border-slate-100 pt-4">
            {sweepTotal > 0 && (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs text-slate-600 tabular-nums">
                  <span>
                    نسبة الإنجاز ({sweepProcessed} من {sweepTotal})
                  </span>
                  <span className="font-mono font-semibold text-slate-900">{sweepProgressPct}%</span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
                  <div
                    className="h-full rounded-full bg-blue-600 transition-all duration-300"
                    style={{ width: `${sweepProgressPct}%` }}
                  />
                </div>
              </div>
            )}

            {autoSweep.currentCommentText && (
              <div className="flex items-start gap-2.5 rounded-lg border border-blue-100 bg-blue-50/50 px-3.5 py-2.5 text-xs">
                <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-blue-600" />
                <div className="min-w-0 space-y-0.5">
                  <p className="font-medium text-slate-900">
                    قيد المعالجة الآن:{' '}
                    <span className="text-blue-700">{autoSweep.currentPageName}</span>
                    {autoSweep.currentCommenter ? ` · ${autoSweep.currentCommenter}` : ''}
                  </p>
                  <p className="truncate text-slate-700">&quot;{autoSweep.currentCommentText}&quot;</p>
                </div>
              </div>
            )}
          </div>
        )}
      </section>

      {/* 4-column KPI strip */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <p className="text-xs font-medium text-slate-500">الصفحات المتصلة</p>
          <p className="mt-2 font-mono text-3xl font-semibold tabular-nums text-slate-900">
            {pages.length}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            {pages.filter((p) => p.mode === 'live').length} مباشر ·{' '}
            {pages.filter((p) => p.mode === 'sandbox').length} تجريبي
          </p>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <p className="text-xs font-medium text-slate-500">القواعد المفعّلة</p>
          <p className="mt-2 font-mono text-3xl font-semibold tabular-nums text-slate-900">
            {activeRulesCount}
          </p>
          <p className="mt-1 text-xs text-slate-500">من إجمالي {rules.length} قاعدة</p>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <p className="text-xs font-medium text-slate-500">إجمالي الردود المرسلة</p>
          <p className="mt-2 font-mono text-3xl font-semibold tabular-nums text-emerald-700">
            {repliedCount}
          </p>
          <p className="mt-1 text-xs text-slate-500">إجمالي الردود التراكمي (عامة وخاصة)</p>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <p className="text-xs font-medium text-slate-500">تحتاج مراجعة</p>
          <p className="mt-2 font-mono text-3xl font-semibold tabular-nums text-slate-900">
            {failedCount}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            {failedCount === 0 ? 'جميع الردود تعمل بصورة طبيعية' : 'تحقق من صلاحيات الرمز'}
          </p>
        </div>
      </div>

      {/* Onboarding guide when empty */}
      {(pages.length === 0 || rules.length === 0) && (
        <div className="rounded-xl border border-slate-200 bg-white p-6">
          <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                ابدأ تفعيل الرد التلقائي في خطوتين
              </h2>
              <p className="mt-1 text-sm text-slate-600">
                اربط صفحة فيسبوك الخاصة بك (أو أنشئ صفحة تجريبية)، ثم أضف أول قاعدة للرد على استفسارات العملاء.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-3 shrink-0">
              {pages.length === 0 && (
                <button
                  type="button"
                  onClick={onConnectPage}
                  className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white whitespace-nowrap shrink-0 transition-colors hover:bg-blue-700"
                >
                  <Plus className="h-4 w-4" />
                  <span>ربط صفحة فيسبوك</span>
                </button>
              )}
              <button
                type="button"
                onClick={onCreateRule}
                className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-800 whitespace-nowrap shrink-0 transition-colors hover:bg-slate-50"
              >
                <Plus className="h-4 w-4" />
                <span>إنشاء قاعدة رد</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Main 2-column split */}
      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-12">
        <div className="lg:col-span-7">
          <section className="rounded-xl border border-slate-200 bg-white">
            <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
              <div>
                <h3 className="text-base font-semibold text-slate-900">
                  البث المباشر للردود (الصفحة · التعليق · الرد)
                </h3>
                <p className="mt-0.5 text-xs text-slate-500">
                  يتحدث تلقائياً مع كل تعليق تتم معالجته والرد الفعلي الذي أُرسل
                </p>
              </div>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={onRefresh}
                  aria-label="تحديث"
                  className="rounded-lg p-1.5 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800"
                >
                  <RefreshCw className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => onNavigate('logs')}
                  className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-700 whitespace-nowrap"
                >
                  <span>عرض السجل الكامل</span>
                  <ArrowUpLeft className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>

            {mergedActivity.length === 0 ? (
              <div className="px-6 py-12 text-center">
                <p className="text-sm font-medium text-slate-700">لا توجد ردود مسجلة بعد</p>
                <p className="mt-1 text-xs text-slate-500">
                  اضغط &quot;تشغيل وفحص جميع الصفحات الآن&quot; أو اختبر قاعدة من المُختبِر الفوري.
                </p>
              </div>
            ) : (
              <ul className="divide-y divide-slate-100">
                {mergedActivity.map((item) => (
                  <li key={item.id} className="px-6 py-4">
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0 flex-1 space-y-1.5">
                        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                          <span className="font-semibold text-blue-700">{item.pageName}</span>
                          <span aria-hidden="true">·</span>
                          <span className="font-medium text-slate-900">{item.commenterName}</span>
                          <span aria-hidden="true">·</span>
                          <span className="tabular-nums">
                            {new Date(item.createdAt).toLocaleTimeString('ar-EG', {
                              hour: '2-digit',
                              minute: '2-digit',
                              second: '2-digit',
                            })}
                          </span>
                        </div>

                        <p className="text-sm text-slate-800">
                          <span className="text-xs font-medium text-slate-500">التعليق: </span>
                          &quot;{item.commentText}&quot;
                        </p>

                        {item.replySent && (
                          <p className="flex items-start gap-1.5 rounded-lg bg-emerald-50/70 px-3 py-2 text-xs text-slate-800">
                            <MessageSquareReply className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-700" />
                            <span>
                              <span className="font-semibold text-emerald-800">الرد المُرسل: </span>
                              {item.replySent}
                            </span>
                          </p>
                        )}

                        {item.privateReplySent && (
                          <p className="text-xs text-slate-600">
                            <span className="font-medium text-slate-700">رسالة خاصة: </span>
                            {item.privateReplySent}
                          </p>
                        )}

                        {item.errorMessage && item.status !== 'replied' && (
                          <p className="text-xs text-red-600">{item.errorMessage}</p>
                        )}

                        {item.replySource && item.replySource !== 'rule' && (
                          <p className="inline-flex items-center gap-1 text-xs text-slate-500">
                            {item.replySource === 'ai' ? (
                              <Sparkles className="h-3 w-3 text-blue-600" />
                            ) : (
                              <Database className="h-3 w-3 text-amber-600" />
                            )}
                            <span>
                              {item.replySource === 'ai'
                                ? 'مُولّد بالذكاء الاصطناعي'
                                : item.replySource === 'ai-cache'
                                ? 'من ذاكرة الذكاء الاصطناعي المخزنة'
                                : 'رد احتياطي'}
                            </span>
                          </p>
                        )}
                      </div>

                      <div className="shrink-0">
                        {item.status === 'replied' && (
                          <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700">
                            <CheckCircle2 className="h-3.5 w-3.5" />
                            <span>تم الرد</span>
                          </span>
                        )}
                        {item.status === 'skipped' && (
                          <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-700">
                            <Slash className="h-3.5 w-3.5" />
                            <span>متجاهل</span>
                          </span>
                        )}
                        {item.status === 'failed' && (
                          <span className="inline-flex items-center gap-1 text-xs font-medium text-red-600">
                            <AlertCircle className="h-3.5 w-3.5" />
                            <span>فشل</span>
                          </span>
                        )}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <div className="lg:col-span-5">
          <RuleTester pages={pages} onSimulated={onRefresh} />
        </div>
      </div>
    </div>
  );
}

