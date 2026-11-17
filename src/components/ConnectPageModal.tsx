import { useEffect, useState } from 'react';
import { Check, Copy, ExternalLink, FlaskConical, KeyRound, X } from 'lucide-react';
import type { FacebookPage, IntegrationConfig } from '../types/facebook';
import { api } from '../lib/api';

interface ConnectPageModalProps {
  open: boolean;
  config: IntegrationConfig | null;
  onClose: () => void;
  onConnected: (page?: FacebookPage, message?: string) => void;
}

type ConnectTab = 'token' | 'oauth' | 'sandbox';

export function ConnectPageModal({
  open,
  config,
  onClose,
  onConnected,
}: ConnectPageModalProps) {
  const [tab, setTab] = useState<ConnectTab>('token');
  const [accessToken, setAccessToken] = useState('');
  const [sandboxName, setSandboxName] = useState('');
  const [sandboxCategory, setSandboxCategory] = useState('متجر إلكتروني');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedUrl, setCopiedUrl] = useState(false);

  useEffect(() => {
    if (!open) return;
    const handleMessage = (event: MessageEvent) => {
      const origin = event.origin;
      if (!origin.endsWith('.run.app') && !origin.includes('localhost')) {
        return;
      }
      if (event.data?.type === 'OAUTH_AUTH_SUCCESS') {
        const count = Number(event.data?.count || 0);
        onConnected(undefined, `تم ربط ${count} صفحة عبر حساب فيسبوك بنجاح`);
        onClose();
      } else if (event.data?.type === 'OAUTH_AUTH_ERROR') {
        setError('تعذر إكمال تفويض فيسبوك. تأكد من صلاحيات الصفحة وإعدادات التطبيق.');
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [open, onClose, onConnected]);

  if (!open) return null;

  const handleConnectToken = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await api.connectPageToken(accessToken);
      setAccessToken('');
      const msg =
        res.mode === 'user'
          ? `تم ربط ${res.connectedCount} صفحة من حساب "${res.userName || ''}" بنجاح`
          : `تم ربط صفحة "${res.pages[0]?.name || ''}" بنجاح`;
      onConnected(res.pages[0], msg);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذر التحقق من رمز المستخدم');
    } finally {
      setLoading(false);
    }
  };

  const handleCreateSandbox = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const { page } = await api.createSandboxPage(sandboxName, sandboxCategory);
      setSandboxName('');
      onConnected(page, `تم إنشاء الصفحة التجريبية "${page.name}"`);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذر إنشاء الصفحة التجريبية');
    } finally {
      setLoading(false);
    }
  };

  const handleOAuthPopup = async () => {
    setError(null);
    setLoading(true);
    try {
      const { url } = await api.getFacebookAuthUrl();
      const popup = window.open(url, 'fb_oauth_popup', 'width=640,height=740');
      if (!popup) {
        setError('قام المتصفح بحظر النافذة المنبثقة. يرجى السماح بالنوافذ المنبثقة وإعادة المحاولة.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذر بدء الربط عبر فيسبوك');
    } finally {
      setLoading(false);
    }
  };

  const handleCopyCallback = async () => {
    if (!config?.oauthCallbackUrl) return;
    await navigator.clipboard.writeText(config.oauthCallbackUrl);
    setCopiedUrl(true);
    setTimeout(() => setCopiedUrl(false), 1800);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-[1px]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="connect-page-title"
    >
      <div className="w-full max-w-xl rounded-xl border border-slate-200 bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
          <div>
            <h2 id="connect-page-title" className="text-lg font-semibold text-slate-900">
              ربط صفحة فيسبوك
            </h2>
            <p className="mt-0.5 text-sm text-slate-500">
              اختر طريقة الربط المناسبة لتفعيل الرد التلقائي على التعليقات
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

        <div className="p-6">
          {/* Segmented Tab Switcher */}
          <div className="grid grid-cols-3 gap-1 rounded-lg bg-slate-100 p-1">
            <button
              type="button"
              onClick={() => {
                setTab('token');
                setError(null);
              }}
              className={`flex items-center justify-center gap-1.5 rounded-md px-3 py-2 text-xs font-medium whitespace-nowrap transition-colors ${
                tab === 'token'
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <KeyRound className="h-3.5 w-3.5 shrink-0" />
              <span>رمز المستخدم</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setTab('oauth');
                setError(null);
              }}
              className={`flex items-center justify-center gap-1.5 rounded-md px-3 py-2 text-xs font-medium whitespace-nowrap transition-colors ${
                tab === 'oauth'
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <ExternalLink className="h-3.5 w-3.5 shrink-0" />
              <span>حساب فيسبوك</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setTab('sandbox');
                setError(null);
              }}
              className={`flex items-center justify-center gap-1.5 rounded-md px-3 py-2 text-xs font-medium whitespace-nowrap transition-colors ${
                tab === 'sandbox'
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <FlaskConical className="h-3.5 w-3.5 shrink-0" />
              <span>صفحة تجريبية</span>
            </button>
          </div>

          {error && (
            <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          )}

          {tab === 'token' && (
            <form onSubmit={handleConnectToken} className="mt-5 space-y-4">
              <div>
                <label
                  htmlFor="page-token-input"
                  className="block text-sm font-medium text-slate-800"
                >
                  رمز وصول المستخدم (User Access Token)
                </label>
                <p className="mt-1 text-xs leading-relaxed text-slate-500">
                  يتم التحقق من رمز حسابك وجلب جميع صفحات فيسبوك التي تديرها وربطها دفعة واحدة تلقائياً.
                </p>
                <textarea
                  id="page-token-input"
                  rows={3}
                  dir="ltr"
                  value={accessToken}
                  onChange={(e) => setAccessToken(e.target.value)}
                  placeholder="EAA..."
                  required
                  className="mt-2 w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 font-mono text-xs text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/15"
                />
              </div>

              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3.5 text-xs leading-relaxed text-slate-600">
                <p className="font-medium text-slate-800">خطوات الحصول على رمز المستخدم:</p>
                <ol className="mt-1.5 list-inside list-decimal space-y-1">
                  <li>افتح أداة Graph API Explorer في حساب مطوري ميتا.</li>
                  <li>
                    اختر <span className="font-medium text-slate-800">User Token</span> وأضف صلاحيات{' '}
                    <span className="font-mono text-slate-800">
                      pages_show_list, pages_manage_engagement, pages_read_engagement, pages_read_user_content, pages_messaging
                    </span>
                    .
                  </li>
                  <li>انسخ رمز المستخدم (User Access Token) والصقه في الحقل أعلاه لربط كل صفحاتك.</li>
                </ol>
              </div>

              <div className="flex items-center justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  disabled={loading || !accessToken.trim()}
                  className="rounded-lg bg-blue-600 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
                >
                  {loading ? 'جاري جلب وربط الصفحات...' : 'ربط جميع الصفحات'}
                </button>
              </div>
            </form>
          )}

          {tab === 'oauth' && (
            <div className="mt-5 space-y-4">
              <p className="text-sm leading-relaxed text-slate-600">
                اربط حسابك في فيسبوك مباشرة لجلب جميع الصفحات التي تديرها تلقائياً وتفعيل استقبال التعليقات الفوري.
              </p>

              {config && (
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3.5 text-xs text-slate-600">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-slate-800">رابط إعادة التوجيه (Redirect URI):</span>
                    <button
                      type="button"
                      onClick={handleCopyCallback}
                      className="inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                    >
                      {copiedUrl ? (
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
                  <p dir="ltr" className="mt-2 truncate font-mono text-slate-800">
                    {config.oauthCallbackUrl}
                  </p>
                </div>
              )}

              {!config?.oauthConfigured && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-relaxed text-amber-800">
                  يتطلب الربط المباشر عبر OAuth إضافة متغيرات البيئة{' '}
                  <span className="font-mono font-medium">FACEBOOK_APP_ID</span> و{' '}
                  <span className="font-mono font-medium">FACEBOOK_APP_SECRET</span>. يمكنك استخدام تبويب
                  &quot;توكن الصفحة&quot; فوراً دون انتظار إعداد تطبيق OAuth.
                </div>
              )}

              <div className="flex items-center justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50"
                >
                  إلغاء
                </button>
                <button
                  type="button"
                  onClick={handleOAuthPopup}
                  disabled={loading}
                  className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
                >
                  <ExternalLink className="h-4 w-4" />
                  <span>{loading ? 'جاري الفتح...' : 'تسجيل الدخول عبر فيسبوك'}</span>
                </button>
              </div>
            </div>
          )}

          {tab === 'sandbox' && (
            <form onSubmit={handleCreateSandbox} className="mt-5 space-y-4">
              <p className="text-sm leading-relaxed text-slate-600">
                أنشئ صفحة تجريبية محلية لبناء قواعد الرد واختبار مطابقة الكلمات المفتاحية والرسائل الخاصة قبل الربط الفعلي.
              </p>

              <div>
                <label htmlFor="sandbox-name" className="block text-sm font-medium text-slate-800">
                  اسم الصفحة
                </label>
                <input
                  id="sandbox-name"
                  type="text"
                  value={sandboxName}
                  onChange={(e) => setSandboxName(e.target.value)}
                  placeholder="مثال: متجر الأناقة للعطور"
                  required
                  className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/15"
                />
              </div>

              <div>
                <label htmlFor="sandbox-cat" className="block text-sm font-medium text-slate-800">
                  تصنيف الصفحة
                </label>
                <input
                  id="sandbox-cat"
                  type="text"
                  value={sandboxCategory}
                  onChange={(e) => setSandboxCategory(e.target.value)}
                  placeholder="مثال: متجر إلكتروني"
                  className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/15"
                />
              </div>

              <div className="flex items-center justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  disabled={loading || !sandboxName.trim()}
                  className="rounded-lg bg-blue-600 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
                >
                  {loading ? 'جاري الإنشاء...' : 'إنشاء الصفحة التجريبية'}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
