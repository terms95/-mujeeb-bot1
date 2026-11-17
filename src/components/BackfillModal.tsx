import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, Clock, History, Search, Send, Sparkles, Square, X } from 'lucide-react';
import type {
  BackfillJobStatus,
  BackfillResult,
  FacebookPage,
  FacebookPost,
} from '../types/facebook';
import { api } from '../lib/api';

interface BackfillModalProps {
  open: boolean;
  page: FacebookPage | null;
  presetPost?: FacebookPost | null;
  defaultDelaySeconds?: number;
  onClose: () => void;
  onCompleted: (message: string) => void;
}

export function BackfillModal({
  open,
  page,
  presetPost,
  defaultDelaySeconds,
  onClose,
  onCompleted,
}: BackfillModalProps) {
  const [sinceDays, setSinceDays] = useState<string>('30');
  const [postsLimit, setPostsLimit] = useState<number>(25);
  const [maxRepliesInput, setMaxRepliesInput] = useState<string>('25');
  const [delaySecondsInput, setDelaySecondsInput] = useState<string>(
    String(defaultDelaySeconds ?? 15)
  );

  const [scanning, setScanning] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [activeJob, setActiveJob] = useState<BackfillJobStatus | null>(null);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [countdownTargetMs, setCountdownTargetMs] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scanResult, setScanResult] = useState<BackfillResult | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const onCompletedRef = useRef(onCompleted);
  const onCloseRef = useRef(onClose);
  const defaultDelayRef = useRef(defaultDelaySeconds);

  useEffect(() => {
    onCompletedRef.current = onCompleted;
  }, [onCompleted]);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    defaultDelayRef.current = defaultDelaySeconds;
  }, [defaultDelaySeconds]);

  useEffect(() => {
    if (!open || !page?.id) return;
    let cancelled = false;
    setError(null);
    setScanResult(null);
    setSelectedIds(new Set());
    setActiveJob(null);
    setCountdownTargetMs(null);
    setExecuting(false);
    setCancelling(false);
    if (typeof defaultDelayRef.current === 'number' && defaultDelayRef.current >= 1) {
      setDelaySecondsInput(String(defaultDelayRef.current));
    }

    void api
      .getActiveBackfillJob(page.id)
      .then((res) => {
        if (!cancelled && res.job && res.job.status === 'running') {
          setActiveJob(res.job);
          setExecuting(true);
        }
      })
      .catch(() => {
        // Ignore reattach errors when opening modal
      });

    return () => {
      cancelled = true;
    };
  }, [open, page?.id, presetPost?.id]);

  useEffect(() => {
    if (!activeJob || activeJob.status !== 'running' || activeJob.phase === 'sending') {
      setCountdownTargetMs(null);
      return;
    }
    const receivedAt = Date.now();
    let computedTarget: number | null = null;
    if (typeof activeJob.nextReplyInMs === 'number') {
      computedTarget = activeJob.nextReplyInMs > 0 ? receivedAt + activeJob.nextReplyInMs : null;
    } else if (activeJob.nextReplyAt) {
      const nextMs = new Date(activeJob.nextReplyAt).getTime();
      const serverNow = activeJob.serverTime ? new Date(activeJob.serverTime).getTime() : receivedAt;
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
    activeJob?.status,
    activeJob?.phase,
    activeJob?.nextReplyInMs,
    activeJob?.nextReplyAt,
    activeJob?.serverTime,
  ]);

  const activeJobId = activeJob?.jobId;
  const activeJobStatus = activeJob?.status;

  useEffect(() => {
    if (!open || !activeJobId || activeJobStatus !== 'running') return;
    let disposed = false;
    setNowMs(Date.now());
    const tick = setInterval(() => setNowMs(Date.now()), 250);
    const poll = setInterval(async () => {
      try {
        const res = await api.getBackfillJob(activeJobId);
        if (disposed) return;
        setActiveJob(res.job);
        if (res.job.status === 'completed' || res.job.status === 'cancelled') {
          setExecuting(false);
          onCompletedRef.current(
            res.job.status === 'cancelled'
              ? `تم إيقاف الدفعة: أُرسل ${res.job.repliedCount} رد في "${res.job.pageName}"`
              : `تم إرسال ${res.job.repliedCount} رد قديم بفاصل فعلي ${res.job.delaySeconds} ثانية في "${res.job.pageName}"${
                  res.job.failedCount > 0 ? ` (فشل ${res.job.failedCount})` : ''
                }`
          );
          onCloseRef.current();
        } else if (res.job.status === 'failed') {
          setExecuting(false);
          setError(res.job.errorMessage || 'تعذر إكمال دفعة الردود');
        }
      } catch {
        // Keep polling on transient network hiccup
      }
    }, 800);

    return () => {
      disposed = true;
      clearInterval(tick);
      clearInterval(poll);
    };
  }, [open, activeJobId, activeJobStatus]);

  if (!open || !page) return null;

  const parsedSinceDays = sinceDays === 'all' ? null : Number(sinceDays);
  const parsedMaxReplies = Math.min(Math.max(Math.floor(Number(maxRepliesInput) || 25), 1), 1000);
  const parsedDelaySeconds = Math.min(
    Math.max(Number(delaySecondsInput) || defaultDelaySeconds || 15, 1),
    300
  );

  const handleScan = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setScanning(true);
    try {
      if (parsedDelaySeconds !== defaultDelaySeconds) {
        await api.updateAutoReplyDelay(parsedDelaySeconds);
      }
      const res = await api.backfillPageComments(page.id, {
        postId: presetPost?.id || 'all',
        postsLimit,
        sinceDays: parsedSinceDays,
        maxReplies: parsedMaxReplies,
        delaySeconds: parsedDelaySeconds,
        dryRun: true,
      });
      setScanResult(res);
      setSelectedIds(new Set(res.previews.slice(0, parsedMaxReplies).map((p) => p.commentId)));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذر فحص التعليقات القديمة');
    } finally {
      setScanning(false);
    }
  };

  const applyBatchLimitSelection = (limitVal: string) => {
    setMaxRepliesInput(limitVal);
    const limit = Math.min(Math.max(Math.floor(Number(limitVal) || 1), 1), 1000);
    if (scanResult) {
      setSelectedIds(new Set(scanResult.previews.slice(0, limit).map((p) => p.commentId)));
    }
  };

  const handleExecute = async () => {
    if (selectedIds.size === 0 || executing) return;
    setError(null);
    setExecuting(true);
    try {
      const res = await api.backfillPageComments(page.id, {
        postId: presetPost?.id || 'all',
        postsLimit,
        sinceDays: parsedSinceDays,
        maxReplies: parsedMaxReplies,
        delaySeconds: parsedDelaySeconds,
        dryRun: false,
        selectedCommentIds: Array.from(selectedIds),
      });
      if (res.job) {
        setActiveJob(res.job);
        if (res.job.status === 'completed') {
          setExecuting(false);
          onCompleted(`تم الرد على ${res.job.repliedCount} تعليق في "${page.name}"`);
          onClose();
        }
      } else {
        setExecuting(false);
        onCompleted(
          `تم الرد على ${res.repliedCount} تعليق قديم في "${page.name}"${
            res.failedCount > 0 ? ` (فشل ${res.failedCount})` : ''
          }`
        );
        onClose();
      }
    } catch (err) {
      setExecuting(false);
      setError(err instanceof Error ? err.message : 'تعذر بدء إرسال الردود');
    }
  };

  const handleCancelJob = async () => {
    if (!activeJob) return;
    setCancelling(true);
    try {
      const res = await api.cancelBackfillJob(activeJob.jobId);
      setActiveJob(res.job);
      setExecuting(false);
      onCompleted(`تم إيقاف الدفعة: أُرسل ${res.job.repliedCount} رد في "${page.name}"`);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذر إيقاف الدفعة');
    } finally {
      setCancelling(false);
    }
  };

  const toggleItem = (commentId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(commentId)) next.delete(commentId);
      else next.add(commentId);
      return next;
    });
  };

  const toggleAll = () => {
    if (!scanResult) return;
    if (selectedIds.size === scanResult.previews.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(scanResult.previews.slice(0, parsedMaxReplies).map((p) => p.commentId)));
    }
  };

  const activeSendCount = Math.min(selectedIds.size, parsedMaxReplies);
  const nextReplyRemainingSec =
    activeJob?.phase !== 'sending' && countdownTargetMs !== null
      ? Math.max(0, Math.ceil((countdownTargetMs - nowMs) / 1000))
      : 0;
  const jobProgressPct =
    activeJob && activeJob.totalQueued > 0
      ? Math.min(100, Math.round((activeJob.processedCount / activeJob.totalQueued) * 100))
      : 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-[1px]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="backfill-modal-title"
    >
      <div className="flex max-h-[90vh] w-full max-w-3xl flex-col rounded-xl border border-slate-200 bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
          <div>
            <h2 id="backfill-modal-title" className="text-lg font-semibold text-slate-900">
              الرد على التعليقات القديمة غير المردود عليها
            </h2>
            <p className="mt-0.5 text-xs text-slate-500">
              الصفحة: <span className="font-medium text-slate-700">{page.name}</span>
              {presetPost && (
                <>
                  {' '}
                  · المنشور: <span className="text-slate-700">{presetPost.message.slice(0, 48)}...</span>
                </>
              )}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="إغلاق"
            className="rounded-lg p-2 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto p-6">
          <form onSubmit={handleScan} className="space-y-4 rounded-xl border border-slate-200 bg-slate-50/70 p-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <label htmlFor="bf-since" className="block text-xs font-medium text-slate-700">
                  النطاق الزمني للتعليقات
                </label>
                <select
                  id="bf-since"
                  value={sinceDays}
                  onChange={(e) => setSinceDays(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-blue-600 focus:outline-none"
                >
                  <option value="7">آخر ٧ أيام</option>
                  <option value="30">آخر ٣٠ يوماً</option>
                  <option value="90">آخر ٩٠ يوماً</option>
                  <option value="all">جميع الفترات المتاحة</option>
                </select>
              </div>

              {!presetPost && (
                <div>
                  <label htmlFor="bf-posts" className="block text-xs font-medium text-slate-700">
                    عدد المنشورات المفحوصة
                  </label>
                  <select
                    id="bf-posts"
                    value={postsLimit}
                    onChange={(e) => setPostsLimit(Number(e.target.value))}
                    className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-blue-600 focus:outline-none"
                  >
                    <option value={25}>آخر ٢٥ منشور</option>
                    <option value={50}>آخر ٥٠ منشور</option>
                    <option value={100}>آخر ١٠٠ منشور</option>
                  </select>
                </div>
              )}

              <div>
                <label htmlFor="bf-max-manual" className="block text-xs font-medium text-slate-700">
                  دفعة الردود في المرة الواحدة
                </label>
                <input
                  id="bf-max-manual"
                  type="number"
                  min={1}
                  max={1000}
                  step={1}
                  value={maxRepliesInput}
                  onChange={(e) => applyBatchLimitSelection(e.target.value)}
                  placeholder="مثال: 25"
                  className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-sm tabular-nums text-slate-900 focus:border-blue-600 focus:outline-none"
                />
              </div>

              <div>
                <label htmlFor="bf-delay-manual" className="block text-xs font-medium text-slate-700">
                  الفاصل الفعلي بين كل رد (ثانية)
                </label>
                <input
                  id="bf-delay-manual"
                  type="number"
                  min={1}
                  max={300}
                  step={1}
                  value={delaySecondsInput}
                  onChange={(e) => setDelaySecondsInput(e.target.value)}
                  disabled={executing}
                  placeholder="مثال: 5"
                  className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-sm tabular-nums text-slate-900 disabled:bg-slate-100 focus:border-blue-600 focus:outline-none"
                />
              </div>
            </div>

            <div className="flex flex-col justify-between gap-3 pt-1 sm:flex-row sm:items-center">
              <p className="text-xs text-slate-500">
                ينفذ الخادم فاصلاً زمنياً فعلياً ومتسلسلاً بعد اكتمال كل رد على فيسبوك (الحد الأدنى ١ ثانية، ويُوصى بـ ٥–١٥ ثانية لتجنب الحظر).
              </p>
              <button
                type="submit"
                disabled={scanning || executing}
                className="inline-flex items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-xs font-medium text-white whitespace-nowrap shrink-0 transition-colors hover:bg-blue-700 disabled:opacity-50"
              >
                <Search className="h-3.5 w-3.5" />
                <span>{scanning ? 'جاري فحص التعليقات...' : 'فحص ومعاينة التعليقات'}</span>
              </button>
            </div>
          </form>

          {activeJob && activeJob.status === 'running' && (
            <div className="space-y-3 rounded-xl border border-blue-200 bg-blue-50/60 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-slate-900 tabular-nums">
                    جاري إرسال الدفعة بفاصل فعلي {activeJob.delaySeconds} ثانية:{' '}
                    {activeJob.processedCount} من {activeJob.totalQueued}
                  </p>
                  <p className="mt-0.5 text-xs text-slate-600 tabular-nums">
                    تم الرد بنجاح: {activeJob.repliedCount}
                    {activeJob.failedCount > 0 ? ` · فشل: ${activeJob.failedCount}` : ''}
                    {activeJob.lastReplyAt
                      ? ` · آخر إرسال: ${new Date(activeJob.lastReplyAt).toLocaleTimeString('ar-EG', {
                          hour: '2-digit',
                          minute: '2-digit',
                          second: '2-digit',
                        })}`
                      : ''}
                    {activeJob.currentCommenter
                      ? ` · التعليق الحالي: ${activeJob.currentCommenter}`
                      : ''}
                  </p>
                </div>

                {activeJob.phase === 'sending' || nextReplyRemainingSec <= 0 ? (
                  <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-blue-700">
                    <Clock className="h-3.5 w-3.5" />
                    <span>جاري توليد وإرسال الرد الآن...</span>
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-blue-700 tabular-nums">
                    <Clock className="h-3.5 w-3.5" />
                    <span>الرد التالي خلال {nextReplyRemainingSec} ث</span>
                  </span>
                )}
              </div>

              <div className="h-2 w-full overflow-hidden rounded-full bg-blue-100">
                <div
                  className="h-full bg-blue-600 transition-all duration-300"
                  style={{ width: `${jobProgressPct}%` }}
                />
              </div>

              <div className="flex items-center justify-between text-xs text-slate-600">
                <span>يتم التنفيذ بالتسلسل دون تداخل مع المزامنة التلقائية لمنع الحظر.</span>
                <button
                  type="button"
                  onClick={handleCancelJob}
                  disabled={cancelling}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 bg-white px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50"
                >
                  <Square className="h-3 w-3" />
                  <span>{cancelling ? 'جاري الإيقاف...' : 'إيقاف الدفعة الآن'}</span>
                </button>
              </div>
            </div>
          )}

          {error && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          )}

          {scanResult && (
            <div className="space-y-4">
              {/* Summary Strip */}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <div className="rounded-lg border border-slate-200 bg-white p-3.5">
                  <p className="text-xs text-slate-500">تعليقات مفحوصة</p>
                  <p className="mt-1 font-mono text-xl font-semibold tabular-nums text-slate-900">
                    {scanResult.scannedComments}
                  </p>
                </div>
                <div className="rounded-lg border border-slate-200 bg-white p-3.5">
                  <p className="text-xs text-slate-500">مردود عليها مسبقاً</p>
                  <p className="mt-1 font-mono text-xl font-semibold tabular-nums text-slate-700">
                    {scanResult.alreadyAnsweredByPage}
                  </p>
                </div>
                <div className="rounded-lg border border-slate-200 bg-white p-3.5">
                  <p className="text-xs text-slate-500">غير مطابقة للقواعد</p>
                  <p className="mt-1 font-mono text-xl font-semibold tabular-nums text-slate-500">
                    {scanResult.unmatchedCount}
                  </p>
                </div>
                <div className="rounded-lg border border-slate-200 bg-white p-3.5">
                  <p className="text-xs text-slate-500">جاهزة للرد الآن</p>
                  <p className="mt-1 font-mono text-xl font-semibold tabular-nums text-emerald-700">
                    {scanResult.matchedUnansweredCount}
                  </p>
                </div>
              </div>

              {scanResult.previews.length === 0 ? (
                <div className="rounded-xl border border-slate-200 bg-white px-6 py-10 text-center">
                  <CheckCircle2 className="mx-auto h-7 w-7 text-emerald-600" />
                  <p className="mt-2 text-sm font-semibold text-slate-900">
                    لا توجد تعليقات قديمة غير مردود عليها مطابقة لقواعدك
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    تم فحص {scanResult.scannedPosts} منشور و{scanResult.scannedComments} تعليق؛ جميع التعليقات المطابقة تم الرد عليها مسبقاً.
                  </p>
                </div>
              ) : (
                <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-slate-50 px-4 py-2.5">
                    <span className="text-xs font-medium text-slate-700 tabular-nums">
                      سيتم إرسال {activeSendCount} رد (بحد أقصى {parsedMaxReplies} للدفعة · فاصل فعلي {parsedDelaySeconds} ث بعد كل رد)
                    </span>
                    <button
                      type="button"
                      onClick={toggleAll}
                      disabled={executing}
                      className="text-xs font-medium text-blue-600 hover:underline disabled:opacity-50"
                    >
                      {selectedIds.size === scanResult.previews.length
                        ? 'إلغاء تحديد الكل'
                        : `تحديد الدفعة (${Math.min(scanResult.previews.length, parsedMaxReplies)})`}
                    </button>
                  </div>

                  <ul className="max-h-72 divide-y divide-slate-100 overflow-y-auto">
                    {scanResult.previews.map((item) => {
                      const checked = selectedIds.has(item.commentId);
                      return (
                        <li
                          key={item.commentId}
                          className="flex items-start gap-3 px-4 py-3 hover:bg-slate-50/70"
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleItem(item.commentId)}
                            aria-label={`تحديد تعليق ${item.commenterName}`}
                            className="mt-1 h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-600"
                          />
                          <div className="min-w-0 flex-1 space-y-1">
                            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                              <span className="font-medium text-slate-900">
                                {item.commenterName}
                              </span>
                              <span aria-hidden="true">·</span>
                              <span className="tabular-nums">
                                {new Date(item.createdTime).toLocaleDateString('ar-EG')}
                              </span>
                              <span aria-hidden="true">·</span>
                              <span className="text-blue-700">{item.matchedRuleName}</span>
                              {!item.dmEligible && (
                                <>
                                  <span aria-hidden="true">·</span>
                                  <span className="text-amber-700">
                                    رد عام فقط (أقدم من ٧ أيام)
                                  </span>
                                </>
                              )}
                            </div>
                            <p className="text-sm text-slate-800">&quot;{item.commentText}&quot;</p>
                            {item.replyType === 'ai' ? (
                              <p className="inline-flex items-center gap-1 text-xs font-medium text-blue-700">
                                <Sparkles className="h-3 w-3" />
                                <span>
                                  {item.suggestedPublicReply ||
                                    'سيتم توليد رد مخصص بالذكاء الاصطناعي عند الإرسال'}
                                </span>
                              </p>
                            ) : (
                              item.suggestedPublicReply && (
                                <p className="text-xs text-slate-600">
                                  الرد المقترح: {item.suggestedPublicReply}
                                </p>
                              )
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
            </div>
          )}

          {!scanResult && !scanning && (
            <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-5 text-xs leading-relaxed text-slate-600">
              <History className="h-5 w-5 shrink-0 text-slate-400" />
              <p>
                حدد حجم الدفعة والفاصل الزمني بين كل رد يدوياً، ثم اضغط على{' '}
                <span className="font-semibold text-slate-800">فحص ومعاينة التعليقات</span> لمراجعة التعليقات غير المردود عليها قبل التنفيذ.
              </p>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-slate-200 px-6 py-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            إغلاق
          </button>

          {scanResult && scanResult.previews.length > 0 && (
            <button
              type="button"
              onClick={handleExecute}
              disabled={executing || activeSendCount === 0}
              className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2 text-sm font-medium text-white whitespace-nowrap transition-colors hover:bg-blue-700 disabled:opacity-50"
            >
              <Send className="h-4 w-4" />
              <span>
                {executing
                  ? `جاري إرسال ${activeSendCount} رد...`
                  : `إرسال الدفعة المحددة (${activeSendCount})`}
              </span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
