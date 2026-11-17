import { useEffect, useState } from 'react';
import {
  AlertCircle,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  Copy,
  Database,
  KeyRound,
  RefreshCw,
  Sparkles,
  Trash2,
  Unlink,
} from 'lucide-react';
import type { CachedAiReply, IntegrationConfig } from '../types/facebook';
import { api } from '../lib/api';

interface SettingsViewProps {
  config: IntegrationConfig | null;
  onRefreshConfig: () => void;
  onNotify: (type: 'success' | 'error', text: string) => void;
}

export function SettingsView({ config, onRefreshConfig, onNotify }: SettingsViewProps) {
  const [userToken, setUserToken] = useState('');
  const [connectingUser, setConnectingUser] = useState(false);
  const [refreshingPages, setRefreshingPages] = useState(false);

  const [verifyToken, setVerifyToken] = useState(config?.webhookVerifyToken || '');
  const [savingToken, setSavingToken] = useState(false);
  const [replyDelayInput, setReplyDelayInput] = useState(
    String(config?.autoReplyDelaySeconds ?? 15)
  );
  const [savingDelay, setSavingDelay] = useState(false);
  const [copiedField, setCopiedField] = useState<string | null>(null);

  const [cacheOpen, setCacheOpen] = useState(false);
  const [aiCache, setAiCache] = useState<CachedAiReply[]>([]);
  const [loadingCache, setLoadingCache] = useState(false);
  const [clearingCache, setClearingCache] = useState(false);
  const [resettingCooldown, setResettingCooldown] = useState(false);

  useEffect(() => {
    if (config?.webhookVerifyToken) {
      setVerifyToken(config.webhookVerifyToken);
    }
  }, [config?.webhookVerifyToken]);

  useEffect(() => {
    if (typeof config?.autoReplyDelaySeconds === 'number') {
      setReplyDelayInput(String(config.autoReplyDelaySeconds));
    }
  }, [config?.autoReplyDelaySeconds]);

  const loadAiCache = async () => {
    setLoadingCache(true);
    try {
      const res = await api.getAiCache();
      setAiCache(res.cache);
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'تعذر تحميل ذاكرة الردود');
    } finally {
      setLoadingCache(false);
    }
  };

  const handleToggleCacheList = () => {
    const next = !cacheOpen;
    setCacheOpen(next);
    if (next) {
      loadAiCache();
    }
  };

  const handleClearAiCache = async () => {
    setClearingCache(true);
    try {
      await api.clearAiCache();
      setAiCache([]);
      onNotify('success', 'تم مسح ذاكرة ردود الذكاء الاصطناعي المخزنة');
      onRefreshConfig();
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'تعذر مسح الذاكرة');
    } finally {
      setClearingCache(false);
    }
  };

  const handleResetAiCooldown = async () => {
    setResettingCooldown(true);
    try {
      await api.resetAiCooldown();
      onNotify('success', 'تمت إعادة تفعيل المحاولة المباشرة للذكاء الاصطناعي');
      onRefreshConfig();
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'تعذر إعادة التفعيل');
    } finally {
      setResettingCooldown(false);
    }
  };

  const handleCopy = async (key: string, value: string) => {
    await navigator.clipboard.writeText(value);
    setCopiedField(key);
    setTimeout(() => setCopiedField(null), 1800);
  };

  const handleConnectUserToken = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!userToken.trim()) return;
    setConnectingUser(true);
    try {
      const res = await api.connectPageToken(userToken.trim());
      setUserToken('');
      onNotify(
        'success',
        res.mode === 'user'
          ? `تم ربط ${res.connectedCount} صفحة من حساب "${res.userName || ''}" بنجاح`
          : `تم ربط صفحة "${res.pages[0]?.name || ''}" بنجاح`
      );
      onRefreshConfig();
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'تعذر التحقق من رمز المستخدم');
    } finally {
      setConnectingUser(false);
    }
  };

  const handleRefreshPages = async () => {
    setRefreshingPages(true);
    try {
      const res = await api.refreshUserPages();
      onNotify('success', `تم تحديث ومزامنة ${res.connectedCount} صفحة من حسابك`);
      onRefreshConfig();
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'تعذر تحديث قائمة الصفحات');
    } finally {
      setRefreshingPages(false);
    }
  };

  const handleDisconnectUser = async () => {
    try {
      await api.disconnectUserConnection();
      onNotify('success', 'تم فصل رمز المستخدم المحفوظ');
      onRefreshConfig();
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'تعذر فصل رمز المستخدم');
    }
  };

  const handleSaveToken = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!verifyToken.trim()) return;
    setSavingToken(true);
    try {
      await api.updateWebhookToken(verifyToken.trim());
      onNotify('success', 'تم تحديث رمز التحقق للويب هوك بنجاح');
      onRefreshConfig();
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'تعذر حفظ رمز التحقق');
    } finally {
      setSavingToken(false);
    }
  };

  const handleSaveReplyDelay = async (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = Math.round(Number(replyDelayInput));
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > 300) {
      onNotify('error', 'يرجى إدخال فاصل زمني بين ١ و ٣٠٠ ثانية');
      return;
    }
    setSavingDelay(true);
    try {
      const res = await api.updateAutoReplyDelay(parsed);
      setReplyDelayInput(String(res.autoReplyDelaySeconds));
      onNotify('success', `تم ضبط الفاصل الزمني للرد التلقائي إلى ${res.autoReplyDelaySeconds} ثانية`);
      onRefreshConfig();
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'تعذر حفظ الفاصل الزمني');
    } finally {
      setSavingDelay(false);
    }
  };

  if (!config) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-500">
        جاري تحميل إعدادات الربط...
      </div>
    );
  }

  return (
    <div className="max-w-3xl space-y-6">
      {/* User Access Token Connection Card (All Pages) */}
      <section className="rounded-xl border border-slate-200 bg-white">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-6 py-4">
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              ربط جميع الصفحات عبر رمز المستخدم (User Access Token)
            </h2>
            <p className="mt-0.5 text-xs text-slate-500">
              اربط حسابك مرة واحدة لجلب وإدارة كافة صفحات فيسبوك التي تديرها تلقائياً
            </p>
          </div>
          {config.userConnection?.connected ? (
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-700">
              <CheckCircle2 className="h-4 w-4" />
              <span>متصل: {config.userConnection.userName}</span>
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500">
              <KeyRound className="h-4 w-4" />
              <span>غير مربوط</span>
            </span>
          )}
        </div>

        <div className="space-y-4 p-6">
          {config.userConnection?.connected && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-xs">
              <div className="text-slate-600">
                الحساب المرتبط:{' '}
                <span className="font-semibold text-slate-900">
                  {config.userConnection.userName}
                </span>
                {config.userConnection.connectedAt && (
                  <>
                    {' '}
                    ·{' '}
                    <span className="tabular-nums">
                      منذ{' '}
                      {new Date(config.userConnection.connectedAt).toLocaleDateString('ar-EG')}
                    </span>
                  </>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleRefreshPages}
                  disabled={refreshingPages}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${refreshingPages ? 'animate-spin' : ''}`} />
                  <span>{refreshingPages ? 'جاري التحديث...' : 'تحديث قائمة الصفحات'}</span>
                </button>
                <button
                  type="button"
                  onClick={handleDisconnectUser}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-red-600 hover:border-red-200 hover:bg-red-50"
                >
                  <Unlink className="h-3.5 w-3.5" />
                  <span>فصل الرمز</span>
                </button>
              </div>
            </div>
          )}

          <form onSubmit={handleConnectUserToken} className="space-y-3">
            <div>
              <label htmlFor="settings-user-token" className="block text-xs font-medium text-slate-700">
                {config.userConnection?.connected
                  ? 'تحديث رمز وصول المستخدم (User Access Token)'
                  : 'إدخال رمز وصول المستخدم (User Access Token)'}
              </label>
              <textarea
                id="settings-user-token"
                rows={2}
                dir="ltr"
                value={userToken}
                onChange={(e) => setUserToken(e.target.value)}
                placeholder="EAA..."
                className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2 font-mono text-xs text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/15"
              />
              <p className="mt-1.5 text-xs text-slate-500">
                يتطلب صلاحيات:{' '}
                <span dir="ltr" className="font-mono text-slate-700">
                  pages_show_list, pages_manage_engagement, pages_read_engagement, pages_read_user_content, pages_messaging
                </span>
              </p>
            </div>
            <div className="flex justify-end">
              <button
                type="submit"
                disabled={connectingUser || !userToken.trim()}
                className="rounded-lg bg-blue-600 px-4 py-2 text-xs font-medium text-white whitespace-nowrap transition-colors hover:bg-blue-700 disabled:opacity-50"
              >
                {connectingUser ? 'جاري جلب وربط الصفحات...' : 'حفظ وربط جميع الصفحات'}
              </button>
            </div>
          </form>
        </div>
      </section>

      {/* Auto-Reply Pacing & Anti-Ban Interval Card */}
      <section className="rounded-xl border border-slate-200 bg-white">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-6 py-4">
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              الفاصل الزمني بين الردود التلقائية (الحماية من الحظر)
            </h2>
            <p className="mt-0.5 text-xs text-slate-500">
              يُلزم الخادم بهذا الفاصل الفعلي بين كل رد وآخر على نفس الصفحة في المراقبة الدورية والويب هوك
            </p>
          </div>
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600 tabular-nums">
            <Clock className="h-4 w-4 text-slate-400" />
            <span>الحالي: {config.autoReplyDelaySeconds ?? 15} ثانية</span>
          </span>
        </div>

        <form onSubmit={handleSaveReplyDelay} className="flex flex-wrap items-end gap-3 p-6">
          <div className="min-w-[200px] flex-1">
            <label htmlFor="auto-reply-delay-input" className="block text-xs font-medium text-slate-700">
              الفاصل الفعلي بين الردود التلقائية على التعليقات القديمة والجديدة (من ١ إلى ٣٠٠ ثانية)
            </label>
            <input
              id="auto-reply-delay-input"
              type="number"
              min={1}
              max={300}
              step={1}
              value={replyDelayInput}
              onChange={(e) => setReplyDelayInput(e.target.value)}
              className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2 font-mono text-sm tabular-nums text-slate-900 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/15"
            />
          </div>
          <button
            type="submit"
            disabled={savingDelay}
            className="rounded-lg bg-blue-600 px-4 py-2 text-xs font-medium text-white whitespace-nowrap hover:bg-blue-700 disabled:opacity-50"
          >
            {savingDelay ? 'جاري الحفظ...' : 'حفظ الفاصل الزمني'}
          </button>
        </form>
      </section>

      {/* Webhook Endpoint Card */}
      <section className="rounded-xl border border-slate-200 bg-white">
        <div className="border-b border-slate-200 px-6 py-4">
          <h2 className="text-base font-semibold text-slate-900">
            إعدادات الويب هوك الفوري (Meta Webhooks)
          </h2>
          <p className="mt-0.5 text-xs text-slate-500">
            انسخ هذه البيانات في لوحة مطوري فيسبوك لاستقبال التعليقات لحظة كتابتها والرد عليها في أقل من ثانية
          </p>
        </div>

        <div className="space-y-5 p-6">
          <div>
            <label className="block text-xs font-medium text-slate-700">
              رابط الاستقبال (Callback URL)
            </label>
            <div className="mt-1.5 flex items-center gap-2">
              <input
                type="text"
                readOnly
                dir="ltr"
                value={config.webhookUrl}
                className="flex-1 rounded-lg border border-slate-300 bg-slate-50 px-3.5 py-2 font-mono text-xs text-slate-800"
              />
              <button
                type="button"
                onClick={() => handleCopy('webhook', config.webhookUrl)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 whitespace-nowrap hover:bg-slate-50"
              >
                {copiedField === 'webhook' ? (
                  <>
                    <Check className="h-3.5 w-3.5 text-emerald-600" />
                    <span>تم النسخ</span>
                  </>
                ) : (
                  <>
                    <Copy className="h-3.5 w-3.5" />
                    <span>نسخ</span>
                  </>
                )}
              </button>
            </div>
          </div>

          <form onSubmit={handleSaveToken}>
            <label htmlFor="verify-token-input" className="block text-xs font-medium text-slate-700">
              رمز التحقق (Verify Token)
            </label>
            <div className="mt-1.5 flex items-center gap-2">
              <input
                id="verify-token-input"
                type="text"
                dir="ltr"
                value={verifyToken}
                onChange={(e) => setVerifyToken(e.target.value)}
                className="flex-1 rounded-lg border border-slate-300 bg-white px-3.5 py-2 font-mono text-xs text-slate-900 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/15"
              />
              <button
                type="button"
                onClick={() => handleCopy('token', verifyToken)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 whitespace-nowrap hover:bg-slate-50"
              >
                {copiedField === 'token' ? (
                  <>
                    <Check className="h-3.5 w-3.5 text-emerald-600" />
                    <span>تم النسخ</span>
                  </>
                ) : (
                  <>
                    <Copy className="h-3.5 w-3.5" />
                    <span>نسخ</span>
                  </>
                )}
              </button>
              <button
                type="submit"
                disabled={savingToken}
                className="rounded-lg bg-blue-600 px-4 py-2 text-xs font-medium text-white whitespace-nowrap hover:bg-blue-700 disabled:opacity-50"
              >
                {savingToken ? 'حفظ...' : 'حفظ الرمز'}
              </button>
            </div>
          </form>

          {config.webhookUrl.includes('ais-dev-') && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-xs leading-relaxed text-amber-900">
              <p className="font-semibold">ملاحظة مهمة حول التحقق من الويب هوك في بيئة المعاينة:</p>
              <p className="mt-1">
                رابط المعاينة المؤقت (<span dir="ltr" className="font-mono">ais-dev-...</span>) محمي ببوابة تحقق للمتصفح تمنع خوادم ميتا الخارجية من الوصول إليه مباشرة، لذا قد يظهر خطأ تعذر التحقق عند اختباره في Meta for Developers.
              </p>
              <p className="mt-1.5">
                يمكنك تشغيل الرد التلقائي فوراً دون Webhook عبر تبويب{' '}
                <span className="font-semibold">صفحات فيسبوك ← ربط صفحة ← توكن الصفحة</span> وتفعيل{' '}
                <span className="font-semibold">المراقبة التلقائية</span>، أو نشر التطبيق على استضافة عامة لاستقبال Webhooks مباشرة.
              </p>
            </div>
          )}
        </div>
      </section>

      {/* OAuth Settings Card */}
      <section className="rounded-xl border border-slate-200 bg-white">
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              إعدادات تسجيل الدخول عبر فيسبوك (OAuth)
            </h2>
            <p className="mt-0.5 text-xs text-slate-500">
              تسمح بالربط المباشر بضغطة زر دون نسخ التوكن يدوياً
            </p>
          </div>
          {config.oauthConfigured ? (
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-700">
              <CheckCircle2 className="h-4 w-4" />
              <span>مُفعّل</span>
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-700">
              <AlertCircle className="h-4 w-4" />
              <span>بحاجة إلى مفاتيح التطبيق</span>
            </span>
          )}
        </div>

        <div className="space-y-4 p-6">
          <div>
            <label className="block text-xs font-medium text-slate-700">
              Valid OAuth Redirect URI
            </label>
            <div className="mt-1.5 flex items-center gap-2">
              <input
                type="text"
                readOnly
                dir="ltr"
                value={config.oauthCallbackUrl}
                className="flex-1 rounded-lg border border-slate-300 bg-slate-50 px-3.5 py-2 font-mono text-xs text-slate-800"
              />
              <button
                type="button"
                onClick={() => handleCopy('oauth', config.oauthCallbackUrl)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 whitespace-nowrap hover:bg-slate-50"
              >
                {copiedField === 'oauth' ? (
                  <>
                    <Check className="h-3.5 w-3.5 text-emerald-600" />
                    <span>تم النسخ</span>
                  </>
                ) : (
                  <>
                    <Copy className="h-3.5 w-3.5" />
                    <span>نسخ</span>
                  </>
                )}
              </button>
            </div>
          </div>

          <div className="border-t border-slate-100 pt-4 text-xs leading-relaxed text-slate-600">
            <p className="font-semibold text-slate-800">خطوات التفعيل في Meta for Developers:</p>
            <ol className="mt-2 list-inside list-decimal space-y-1.5">
              <li>
                أنشئ تطبيقاً جديداً من نوع <span className="font-medium text-slate-800">Business</span> في{' '}
                <span dir="ltr" className="font-mono text-slate-800">
                  developers.facebook.com
                </span>
                .
              </li>
              <li>
                أضف منتج <span className="font-medium text-slate-800">Webhooks</span> واختر الكائن{' '}
                <span className="font-mono text-slate-800">Page</span> ثم اشترك في حقل{' '}
                <span className="font-mono text-slate-800">feed</span> باستخدام رابط الاستقبال ورمز التحقق أعلاه.
              </li>
              <li>
                أضف متغيرات البيئة <span className="font-mono text-slate-800">FACEBOOK_APP_ID</span> و{' '}
                <span className="font-mono text-slate-800">FACEBOOK_APP_SECRET</span> لتفعيل زر تسجيل الدخول المباشر.
              </li>
            </ol>
          </div>
        </div>
      </section>

      {/* AI Auto-Reply Status & Persistent Cache Card */}
      <section className="rounded-xl border border-slate-200 bg-white">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-6 py-4">
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              الرد بالذكاء الاصطناعي وذاكرة الردود الاحتياطية
            </h2>
            <p className="mt-0.5 text-xs text-slate-500">
              تخزين تلقائي لكل رد يولّده الذكاء الاصطناعي لاستخدامه عند بلوغ حدود الاستخدام المؤقتة حتى عودته
            </p>
          </div>
          {config.aiStatus?.inCooldown ? (
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-700">
              <Database className="h-4 w-4" />
              <span>تهدئة مؤقتة · يعمل من الذاكرة</span>
            </span>
          ) : config.aiStatus?.configured ? (
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-700">
              <Sparkles className="h-4 w-4" />
              <span>نشط وجاهز</span>
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500">
              <AlertCircle className="h-4 w-4" />
              <span>بانتظار مفتاح الخدمة على الخادم</span>
            </span>
          )}
        </div>

        <div className="space-y-4 p-6">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="rounded-lg border border-slate-200 bg-slate-50/70 px-4 py-3">
              <p className="text-xs text-slate-500">ردود الذكاء الاصطناعي</p>
              <p className="mt-1 font-mono text-2xl font-semibold tabular-nums text-slate-900">
                {config.aiStatus?.totalAiGenerated ?? 0}
              </p>
            </div>
            <div className="rounded-lg border border-slate-200 bg-slate-50/70 px-4 py-3">
              <p className="text-xs text-slate-500">ردود مخدومة من الذاكرة</p>
              <p className="mt-1 font-mono text-2xl font-semibold tabular-nums text-slate-900">
                {config.aiStatus?.totalCacheServed ?? 0}
              </p>
            </div>
            <div className="rounded-lg border border-slate-200 bg-slate-50/70 px-4 py-3">
              <p className="text-xs text-slate-500">الردود المخزنة حالياً</p>
              <p className="mt-1 font-mono text-2xl font-semibold tabular-nums text-blue-700">
                {config.aiStatus?.cachedCount ?? 0}
              </p>
            </div>
          </div>

          {config.aiStatus?.inCooldown && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900">
              <div>
                <p className="font-semibold">
                  تم تفعيل وضع التهدئة المؤقتة — يرد النظام الآن من الذاكرة المخزنة تلقائياً
                </p>
                {config.aiStatus.cooldownUntil && (
                  <p className="mt-0.5 tabular-nums">
                    سيحاول الخادم العودة للذكاء الاصطناعي تلقائياً بعد:{' '}
                    {new Date(config.aiStatus.cooldownUntil).toLocaleTimeString('ar-EG', {
                      hour: '2-digit',
                      minute: '2-digit',
                      second: '2-digit',
                    })}
                  </p>
                )}
                {config.aiStatus.lastError && (
                  <p className="mt-0.5 text-amber-800">{config.aiStatus.lastError}</p>
                )}
              </div>
              <button
                type="button"
                onClick={handleResetAiCooldown}
                disabled={resettingCooldown}
                className="inline-flex items-center gap-1.5 rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-xs font-medium text-amber-900 whitespace-nowrap hover:bg-amber-100 disabled:opacity-50"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${resettingCooldown ? 'animate-spin' : ''}`} />
                <span>إعادة المحاولة الآن</span>
              </button>
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
            <button
              type="button"
              onClick={handleToggleCacheList}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              {cacheOpen ? (
                <ChevronUp className="h-3.5 w-3.5" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5" />
              )}
              <span>
                {cacheOpen
                  ? 'إخفاء الردود المخزنة'
                  : `عرض الردود المخزنة (${config.aiStatus?.cachedCount ?? 0})`}
              </span>
            </button>

            {(config.aiStatus?.cachedCount ?? 0) > 0 && (
              <button
                type="button"
                onClick={handleClearAiCache}
                disabled={clearingCache}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-medium text-red-600 hover:border-red-200 hover:bg-red-50 disabled:opacity-50"
              >
                <Trash2 className="h-3.5 w-3.5" />
                <span>{clearingCache ? 'جاري المسح...' : 'مسح الذاكرة المخزنة'}</span>
              </button>
            )}
          </div>

          {cacheOpen && (
            <div className="rounded-lg border border-slate-200 bg-slate-50/70">
              {loadingCache ? (
                <p className="p-4 text-xs text-slate-500">جاري تحميل الذاكرة المخزنة...</p>
              ) : aiCache.length === 0 ? (
                <p className="p-4 text-xs text-slate-500">
                  لا توجد ردود مخزنة بعد. كل رد يتم توليده بالذكاء الاصطناعي يُحفظ هنا تلقائياً.
                </p>
              ) : (
                <ul className="max-h-72 divide-y divide-slate-200 overflow-y-auto">
                  {aiCache.map((item) => (
                    <li key={item.id} className="space-y-1 p-3.5 text-xs">
                      <div className="flex items-center justify-between gap-2 text-slate-500">
                        <span className="font-medium text-slate-800">
                          تعليق مشابه: &quot;{item.commentText}&quot;
                        </span>
                        <span className="tabular-nums shrink-0">
                          استُخدم {item.useCount} مرة
                        </span>
                      </div>
                      <p className="text-slate-700">
                        <span className="text-slate-400">الرد العام:</span> {item.publicReply}
                      </p>
                      {item.privateReply && (
                        <p className="text-blue-700">
                          <span className="text-blue-500">الرد الخاص:</span> {item.privateReply}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
