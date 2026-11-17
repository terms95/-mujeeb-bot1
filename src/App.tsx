import { useCallback, useEffect, useRef, useState } from 'react';
import { onAuthStateChanged, signInWithPopup, signOut, type User } from 'firebase/auth';
import {
  AlertCircle,
  CheckCircle2,
  Cloud,
  Globe,
  History,
  LayoutDashboard,
  LogOut,
  Menu,
  MessageSquareText,
  Plus,
  Power,
  Settings2,
  X,
} from 'lucide-react';
import type {
  AutoReplyRule,
  FacebookPage,
  FacebookPost,
  IntegrationConfig,
  ReplyLogEntry,
} from './types/facebook';
import { api } from './lib/api';
import { auth, googleProvider } from './lib/firebase';
import {
  pushSnapshotToCloud,
  resetCloudSyncFingerprint,
  syncWithCloudOnAuth,
} from './lib/firebaseSync';
import { ConnectPageModal } from './components/ConnectPageModal';
import { RuleModal } from './components/RuleModal';
import { OverviewView } from './components/OverviewView';
import { RulesView } from './components/RulesView';
import { PagesView } from './components/PagesView';
import { LogsView } from './components/LogsView';
import { SettingsView } from './components/SettingsView';

type NavTab = 'overview' | 'rules' | 'pages' | 'logs' | 'settings';

const NAV_ITEMS: Array<{ id: NavTab; label: string; icon: typeof LayoutDashboard }> = [
  { id: 'overview', label: 'نظرة عامة', icon: LayoutDashboard },
  { id: 'rules', label: 'قواعد الرد التلقائي', icon: MessageSquareText },
  { id: 'pages', label: 'صفحات فيسبوك', icon: Globe },
  { id: 'logs', label: 'سجل الردود', icon: History },
  { id: 'settings', label: 'إعدادات الربط', icon: Settings2 },
];

const TAB_TITLES: Record<NavTab, { title: string; subtitle: string }> = {
  overview: {
    title: 'نظرة عامة',
    subtitle: 'ملخص أداء الرد التلقائي واختبار مطابقة القواعد',
  },
  rules: {
    title: 'قواعد الرد التلقائي',
    subtitle: 'إدارة الكلمات المفتاحية وصيغ الرد العام ورسائل ماسنجر الخاصة',
  },
  pages: {
    title: 'صفحات فيسبوك',
    subtitle: 'ربط الصفحات ومزامنة التعليقات وتخصيص القواعد لكل منشور',
  },
  logs: {
    title: 'سجل الردود',
    subtitle: 'متابعة كافة التعليقات والردود المرسلة وحالة التنفيذ',
  },
  settings: {
    title: 'إعدادات الربط والويب هوك',
    subtitle: 'بيانات Meta Webhooks وتفويض OAuth للاستقبال الفوري',
  },
};

export default function App() {
  const [activeTab, setActiveTab] = useState<NavTab>('overview');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const [pages, setPages] = useState<FacebookPage[]>([]);
  const [rules, setRules] = useState<AutoReplyRule[]>([]);
  const [logs, setLogs] = useState<ReplyLogEntry[]>([]);
  const [config, setConfig] = useState<IntegrationConfig | null>(null);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const [connectModalOpen, setConnectModalOpen] = useState(false);
  const [ruleModalOpen, setRuleModalOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<AutoReplyRule | null>(null);
  const [presetPageId, setPresetPageId] = useState<string | undefined>(undefined);
  const [presetPost, setPresetPost] = useState<FacebookPost | null>(null);

  const [cloudUser, setCloudUser] = useState<User | null>(null);
  const [cloudSyncing, setCloudSyncing] = useState(false);
  const [cloudReady, setCloudReady] = useState(false);
  const cloudSyncLockRef = useRef(false);
  const hasLoadedOnceRef = useRef(false);
  const fetchingRef = useRef(false);
  const lastSweepSigRef = useRef('');

  const notify = useCallback((type: 'success' | 'error', text: string) => {
    setToast({ type, text });
    setTimeout(() => {
      setToast((curr) => (curr?.text === text ? null : curr));
    }, 4500);
  }, []);

  const fetchAll = useCallback(async () => {
    if (fetchingRef.current) return;
    fetchingRef.current = true;
    try {
      const [pagesRes, rulesRes, logsRes, configRes] = await Promise.all([
        api.getPages(),
        api.getRules(),
        api.getLogs(),
        api.getConfig(),
      ]);
      hasLoadedOnceRef.current = true;
      setLoadError(null);
      setPages(pagesRes.pages);
      setRules(rulesRes.rules);
      setLogs(logsRes.logs);
      setConfig(configRes);
      if (configRes.autoSweep) {
        lastSweepSigRef.current = `${configRes.autoSweep.running}:${configRes.autoSweep.processedCount}:${configRes.autoSweep.recentItems[0]?.id || ''}`;
      }
    } catch (err) {
      if (!hasLoadedOnceRef.current) {
        setLoadError(err instanceof Error ? err.message : 'تعذر تحميل البيانات من الخادم');
      }
    } finally {
      fetchingRef.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      setCloudUser(user);
      if (!user) {
        setCloudReady(false);
        resetCloudSyncFingerprint();
        return;
      }
      if (cloudSyncLockRef.current) return;
      cloudSyncLockRef.current = true;
      setCloudSyncing(true);
      try {
        const res = await syncWithCloudOnAuth(user);
        setCloudReady(true);
        await fetchAll();
        if (res.restoredFromCloud && (res.pagesCount > 0 || res.rulesCount > 0)) {
          notify(
            'success',
            `تمت استعادة إعداداتك المحفوظة سحابياً (${res.rulesCount} قاعدة · فاصل ${res.delaySeconds} ث)`
          );
        }
      } catch (err) {
        notify(
          'error',
          err instanceof Error ? 'تعذر مزامنة الإعدادات السحابية مع Firestore' : 'تعذر المزامنة السحابية'
        );
      } finally {
        cloudSyncLockRef.current = false;
        setCloudSyncing(false);
      }
    });
    return () => unsubscribe();
  }, [fetchAll, notify]);

  // Debounced automatic push of config/rule/page changes to Firestore when signed in
  useEffect(() => {
    if (!cloudUser || !cloudReady || cloudSyncLockRef.current) return;
    const timer = setTimeout(() => {
      if (cloudSyncLockRef.current) return;
      void pushSnapshotToCloud(cloudUser).catch(() => {
        // Errors are logged via handleFirestoreError; next sync cycle will retry
      });
    }, 3500);
    return () => clearTimeout(timer);
  }, [cloudUser, cloudReady, pages, rules, config?.autoReplyEnabled, config?.autoReplyDelaySeconds, config?.webhookVerifyToken, config?.userConnection?.connected]);

  const handleCloudSignIn = async () => {
    setCloudSyncing(true);
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err) {
      setCloudSyncing(false);
      notify('error', err instanceof Error ? err.message : 'تعذر تسجيل الدخول بحساب جوجل');
    }
  };

  const handleCloudSignOut = async () => {
    try {
      await signOut(auth);
      notify('success', 'تم تسجيل الخروج من المزامنة السحابية');
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'تعذر تسجيل الخروج');
    }
  };

  const handleUpdateReplyDelay = async (delaySeconds: number) => {
    const res = await api.updateAutoReplyDelay(delaySeconds);
    setConfig((prev) =>
      prev ? { ...prev, autoReplyDelaySeconds: res.autoReplyDelaySeconds } : prev
    );
    notify(
      'success',
      `تم حفظ الفاصل الفعلي (${res.autoReplyDelaySeconds} ثانية) وتفعيله على جميع الردود`
    );
    await fetchAll();
  };

  const sweepRunning = Boolean(config?.autoSweep?.running || config?.autoSweep?.scanning);

  const pollLiveSweepStatus = useCallback(async () => {
    try {
      const status = await api.getAutoSweepStatus();
      setConfig((prev) =>
        prev
          ? {
              ...prev,
              autoReplyEnabled: status.autoReplyEnabled,
              autoReplyDelaySeconds: status.autoReplyDelaySeconds,
              totalRepliesSent: status.totalRepliesSent,
              totalFailedReplies: status.totalFailedReplies,
              aiStatus: status.aiStatus,
              autoSweep: status.autoSweep,
            }
          : prev
      );
      const sig = `${status.autoSweep.running}:${status.autoSweep.processedCount}:${status.autoSweep.recentItems[0]?.id || ''}`;
      if (sig !== lastSweepSigRef.current) {
        lastSweepSigRef.current = sig;
        void fetchAll();
      }
    } catch {
      // Keep running silently on transient polling glitch
    }
  }, [fetchAll]);

  useEffect(() => {
    const statusIntervalMs = sweepRunning ? 1000 : 10000;
    const statusTimer = setInterval(() => {
      if (typeof document === 'undefined' || !document.hidden) {
        void pollLiveSweepStatus();
      }
    }, statusIntervalMs);

    const fullRefreshTimer = setInterval(() => {
      if (typeof document === 'undefined' || !document.hidden) {
        void fetchAll();
      }
    }, 30000);

    const handleVisibility = () => {
      if (typeof document !== 'undefined' && !document.hidden) {
        void pollLiveSweepStatus();
        void fetchAll();
      }
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibility);
    }

    return () => {
      clearInterval(statusTimer);
      clearInterval(fullRefreshTimer);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibility);
      }
    };
  }, [fetchAll, pollLiveSweepStatus, sweepRunning]);

  const openCreateRule = (pageId?: string, post?: FacebookPost) => {
    setEditingRule(null);
    setPresetPageId(pageId);
    setPresetPost(post || null);
    setRuleModalOpen(true);
  };

  const openEditRule = (rule: AutoReplyRule) => {
    setEditingRule(rule);
    setPresetPageId(undefined);
    setPresetPost(null);
    setRuleModalOpen(true);
  };

  const handleToggleRule = async (rule: AutoReplyRule) => {
    try {
      await api.updateRule(rule.id, { enabled: !rule.enabled });
      notify('success', !rule.enabled ? `تم تفعيل قاعدة "${rule.name}"` : `تم إيقاف قاعدة "${rule.name}"`);
      fetchAll();
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'تعذر تحديث حالة القاعدة');
    }
  };

  const handleDeleteRule = async (rule: AutoReplyRule) => {
    try {
      await api.deleteRule(rule.id);
      notify('success', `تم حذف قاعدة "${rule.name}"`);
      fetchAll();
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'تعذر حذف القاعدة');
    }
  };

  const [togglingAutoReply, setTogglingAutoReply] = useState(false);
  const [enablingAllPages, setEnablingAllPages] = useState(false);
  const autoReplyEnabled = config?.autoReplyEnabled ?? true;

  const handleToggleAutoReply = async () => {
    const next = !autoReplyEnabled;
    setTogglingAutoReply(true);
    setConfig((prev) => (prev ? { ...prev, autoReplyEnabled: next } : prev));
    try {
      const res = await api.setAutoReplyEnabled(next);
      setConfig((prev) => (prev ? { ...prev, autoReplyEnabled: res.autoReplyEnabled } : prev));
      notify(
        'success',
        res.autoReplyEnabled
          ? 'تم تشغيل الرد التلقائي فوراً — جاري فحص والرد على جميع التعليقات القديمة والجديدة وفق الفاصل الزمني المحدد'
          : 'تم إيقاف الرد التلقائي فوراً — لن تُرسل أي ردود تلقائية حتى تعيد تشغيله'
      );
      fetchAll();
      if (res.autoReplyEnabled) {
        setTimeout(() => fetchAll(), 1200);
      }
    } catch (err) {
      setConfig((prev) => (prev ? { ...prev, autoReplyEnabled: !next } : prev));
      notify('error', err instanceof Error ? err.message : 'تعذر تغيير حالة الرد التلقائي');
    } finally {
      setTogglingAutoReply(false);
    }
  };

  const handleEnableAllAutoReply = async () => {
    setEnablingAllPages(true);
    try {
      const res = await api.enableAllAutoReply();
      notify(
        'success',
        `تم تفعيل الرد التلقائي على ${res.enabledPagesCount} صفحة؛ بدأ الفحص والرد على التعليقات القديمة والجديدة وفق الفاصل المحدد`
      );
      await fetchAll();
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'تعذر تفعيل جميع الصفحات');
    } finally {
      setEnablingAllPages(false);
    }
  };

  const handleClearLogs = async () => {
    try {
      await api.clearLogs();
      notify('success', 'تم مسح سجل الردود');
      fetchAll();
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'تعذر مسح السجل');
    }
  };

  const currentHeading = TAB_TITLES[activeTab];

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <div className="flex min-h-screen">
        {/* Desktop Sidebar (RTL right side) */}
        <aside className="hidden w-64 shrink-0 flex-col border-l border-slate-200 bg-white lg:flex">
          <div className="flex h-16 items-center gap-3 border-b border-slate-200 px-6">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-600 text-white">
              <MessageSquareText className="h-4 w-4" />
            </div>
            <span className="text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap">
              مُجيب
            </span>
          </div>

          <nav className="flex-1 space-y-1 p-4" aria-label="القائمة الرئيسية">
            {NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              const isActive = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setActiveTab(item.id)}
                  className={`flex w-full items-center gap-3 rounded-lg px-3.5 py-2.5 text-sm font-medium whitespace-nowrap transition-colors ${
                    isActive
                      ? 'bg-blue-50 text-blue-700'
                      : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                  }`}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </nav>

          <div className="space-y-2.5 border-t border-slate-200 p-4">
            {cloudUser ? (
              <div className="flex items-center justify-between gap-2 rounded-lg border border-blue-200 bg-blue-50/70 px-3 py-2 text-xs">
                <div className="min-w-0">
                  <p className="flex items-center gap-1.5 font-semibold text-blue-800">
                    <Cloud className="h-3.5 w-3.5 shrink-0" />
                    <span>{cloudSyncing ? 'جاري الحفظ...' : 'محفوظ سحابياً دائماً'}</span>
                  </p>
                  <p className="truncate text-[11px] text-blue-700" dir="ltr">
                    {cloudUser.email}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleCloudSignOut}
                  aria-label="تسجيل الخروج"
                  className="rounded p-1 text-blue-700 hover:bg-blue-100"
                >
                  <LogOut className="h-3.5 w-3.5" />
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={handleCloudSignIn}
                disabled={cloudSyncing}
                className="flex w-full items-center justify-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3.5 py-2 text-xs font-semibold text-blue-700 whitespace-nowrap transition-colors hover:bg-blue-100 disabled:opacity-50"
              >
                <Cloud className="h-3.5 w-3.5 shrink-0" />
                <span>{cloudSyncing ? 'جاري الربط...' : 'حفظ دائم بحساب جوجل'}</span>
              </button>
            )}

            <button
              type="button"
              onClick={handleToggleAutoReply}
              disabled={togglingAutoReply}
              aria-pressed={autoReplyEnabled}
              className={`flex w-full items-center justify-between gap-2 rounded-lg border px-3.5 py-2.5 text-xs font-semibold whitespace-nowrap transition-colors ${
                autoReplyEnabled
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-800 hover:bg-emerald-100'
                  : 'border-red-200 bg-red-50 text-red-700 hover:bg-red-100'
              }`}
            >
              <span className="inline-flex items-center gap-2">
                <Power className="h-3.5 w-3.5 shrink-0" />
                <span>{autoReplyEnabled ? 'الرد التلقائي: مُشغّل' : 'الرد التلقائي: متوقف'}</span>
              </span>
              <span className="text-[11px] font-medium underline-offset-2 hover:underline">
                {autoReplyEnabled ? 'إيقاف' : 'تشغيل'}
              </span>
            </button>

            <button
              type="button"
              onClick={() => setConnectModalOpen(true)}
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-medium text-slate-700 whitespace-nowrap transition-colors hover:bg-slate-50"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>ربط صفحة فيسبوك</span>
            </button>
          </div>
        </aside>

        {/* Mobile Drawer */}
        {mobileMenuOpen && (
          <div className="fixed inset-0 z-40 flex lg:hidden">
            <div
              className="fixed inset-0 bg-slate-900/40"
              onClick={() => setMobileMenuOpen(false)}
            />
            <aside className="relative z-50 flex w-64 flex-col bg-white shadow-xl">
              <div className="flex h-16 items-center justify-between border-b border-slate-200 px-5">
                <span className="text-lg font-bold text-slate-900">مُجيب</span>
                <button
                  type="button"
                  onClick={() => setMobileMenuOpen(false)}
                  aria-label="إغلاق القائمة"
                  className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
              <nav className="flex-1 space-y-1 p-4">
                {NAV_ITEMS.map((item) => {
                  const Icon = item.icon;
                  const isActive = activeTab === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => {
                        setActiveTab(item.id);
                        setMobileMenuOpen(false);
                      }}
                      className={`flex w-full items-center gap-3 rounded-lg px-3.5 py-2.5 text-sm font-medium whitespace-nowrap transition-colors ${
                        isActive
                          ? 'bg-blue-50 text-blue-700'
                          : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                      }`}
                    >
                      <Icon className="h-4 w-4 shrink-0" />
                      <span>{item.label}</span>
                    </button>
                  );
                })}
              </nav>
              <div className="border-t border-slate-200 p-4">
                <button
                  type="button"
                  onClick={handleToggleAutoReply}
                  disabled={togglingAutoReply}
                  aria-pressed={autoReplyEnabled}
                  className={`flex w-full items-center justify-between gap-2 rounded-lg border px-3.5 py-2.5 text-xs font-semibold whitespace-nowrap transition-colors ${
                    autoReplyEnabled
                      ? 'border-emerald-200 bg-emerald-50 text-emerald-800 hover:bg-emerald-100'
                      : 'border-red-200 bg-red-50 text-red-700 hover:bg-red-100'
                  }`}
                >
                  <span className="inline-flex items-center gap-2">
                    <Power className="h-3.5 w-3.5 shrink-0" />
                    <span>{autoReplyEnabled ? 'الرد التلقائي: مُشغّل' : 'الرد التلقائي: متوقف'}</span>
                  </span>
                  <span className="text-[11px] font-medium">
                    {autoReplyEnabled ? 'إيقاف' : 'تشغيل'}
                  </span>
                </button>
              </div>
            </aside>
          </div>
        )}

        {/* Main Viewport */}
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-16 items-center justify-between gap-4 border-b border-slate-200 bg-white px-4 sm:px-8">
            <div className="flex min-w-0 items-center gap-3">
              <button
                type="button"
                onClick={() => setMobileMenuOpen(true)}
                aria-label="فتح القائمة"
                className="rounded-lg p-2 text-slate-600 hover:bg-slate-100 lg:hidden"
              >
                <Menu className="h-5 w-5" />
              </button>
              <div className="min-w-0">
                <h1 className="truncate text-base font-semibold text-slate-900 sm:text-lg">
                  {currentHeading.title}
                </h1>
              </div>
            </div>

            <div className="flex items-center gap-3 shrink-0">
              {activeTab === 'pages' ? (
                <button
                  type="button"
                  onClick={() => setConnectModalOpen(true)}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-xs font-medium text-white whitespace-nowrap shrink-0 transition-colors hover:bg-blue-700 sm:text-sm"
                >
                  <Plus className="h-4 w-4" />
                  <span>ربط صفحة</span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => openCreateRule()}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-xs font-medium text-white whitespace-nowrap shrink-0 transition-colors hover:bg-blue-700 sm:text-sm"
                >
                  <Plus className="h-4 w-4" />
                  <span>قاعدة رد جديدة</span>
                </button>
              )}
            </div>
          </header>

          <main className="mx-auto w-full max-w-6xl flex-1 p-4 sm:p-8">
            <p className="mb-6 text-sm text-slate-500">{currentHeading.subtitle}</p>

            {toast && (
              <div
                role="status"
                className={`mb-6 flex items-center justify-between gap-3 rounded-xl border px-4 py-3 text-sm ${
                  toast.type === 'success'
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                    : 'border-red-200 bg-red-50 text-red-700'
                }`}
              >
                <div className="flex items-center gap-2">
                  {toast.type === 'success' ? (
                    <CheckCircle2 className="h-4 w-4 shrink-0" />
                  ) : (
                    <AlertCircle className="h-4 w-4 shrink-0" />
                  )}
                  <span>{toast.text}</span>
                </div>
                <button
                  type="button"
                  onClick={() => setToast(null)}
                  aria-label="إخفاء التنبيه"
                  className="rounded p-1 opacity-70 hover:opacity-100"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            )}

            {loading ? (
              <div className="space-y-4">
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  {[0, 1, 2, 3].map((idx) => (
                    <div
                      key={idx}
                      className="h-28 animate-pulse rounded-xl border border-slate-200 bg-white"
                    />
                  ))}
                </div>
                <div className="h-72 animate-pulse rounded-xl border border-slate-200 bg-white" />
              </div>
            ) : loadError ? (
              <div className="rounded-xl border border-red-200 bg-white p-8 text-center">
                <p className="text-sm font-medium text-red-700">{loadError}</p>
                <button
                  type="button"
                  onClick={fetchAll}
                  className="mt-4 rounded-lg bg-slate-900 px-4 py-2 text-xs font-medium text-white hover:bg-slate-800"
                >
                  إعادة المحاولة
                </button>
              </div>
            ) : (
              <>
                {activeTab === 'overview' && (
                  <OverviewView
                    pages={pages}
                    rules={rules}
                    logs={logs}
                    autoReplyEnabled={autoReplyEnabled}
                    autoReplyDelaySeconds={config?.autoReplyDelaySeconds ?? 15}
                    totalRepliesSent={config?.totalRepliesSent}
                    totalFailedReplies={config?.totalFailedReplies}
                    togglingAutoReply={togglingAutoReply}
                    enablingAllPages={enablingAllPages}
                    aiStatus={config?.aiStatus}
                    autoSweep={config?.autoSweep}
                    cloudEmail={cloudUser?.email || null}
                    cloudSyncing={cloudSyncing}
                    onCloudSignIn={handleCloudSignIn}
                    onUpdateReplyDelay={handleUpdateReplyDelay}
                    onToggleAutoReply={handleToggleAutoReply}
                    onEnableAllAutoReply={handleEnableAllAutoReply}
                    onConnectPage={() => setConnectModalOpen(true)}
                    onCreateRule={() => openCreateRule()}
                    onNavigate={setActiveTab}
                    onRefresh={fetchAll}
                  />
                )}
                {activeTab === 'rules' && (
                  <RulesView
                    rules={rules}
                    pages={pages}
                    onCreateRule={() => openCreateRule()}
                    onEditRule={openEditRule}
                    onToggleRule={handleToggleRule}
                    onDeleteRule={handleDeleteRule}
                  />
                )}
                {activeTab === 'pages' && (
                  <PagesView
                    pages={pages}
                    config={config}
                    onConnectPage={() => setConnectModalOpen(true)}
                    onCreateRuleForPost={(pId, post) => openCreateRule(pId, post)}
                    onRefresh={fetchAll}
                    onNotify={notify}
                  />
                )}
                {activeTab === 'logs' && (
                  <LogsView logs={logs} pages={pages} onClearLogs={handleClearLogs} />
                )}
                {activeTab === 'settings' && (
                  <SettingsView config={config} onRefreshConfig={fetchAll} onNotify={notify} />
                )}
              </>
            )}
          </main>
        </div>
      </div>

      <ConnectPageModal
        open={connectModalOpen}
        config={config}
        onClose={() => setConnectModalOpen(false)}
        onConnected={(_page, msg) => {
          if (msg) notify('success', msg);
          fetchAll();
        }}
      />

      <RuleModal
        open={ruleModalOpen}
        pages={pages}
        editingRule={editingRule}
        presetPageId={presetPageId}
        presetPost={presetPost}
        onClose={() => setRuleModalOpen(false)}
        onSaved={(msg) => {
          notify('success', msg);
          fetchAll();
        }}
      />
    </div>
  );
}
