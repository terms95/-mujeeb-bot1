import { useMemo, useState } from 'react';
import { Edit3, Heart, MessageSquare, Plus, Search, Send, Sparkles, Trash2 } from 'lucide-react';
import type { AutoReplyRule, FacebookPage } from '../types/facebook';

interface RulesViewProps {
  rules: AutoReplyRule[];
  pages: FacebookPage[];
  onCreateRule: () => void;
  onEditRule: (rule: AutoReplyRule) => void;
  onToggleRule: (rule: AutoReplyRule) => void;
  onDeleteRule: (rule: AutoReplyRule) => void;
}

type StatusFilter = 'all' | 'enabled' | 'disabled';

const MATCH_MODE_LABELS: Record<AutoReplyRule['matchMode'], string> = {
  contains: 'يحتوي على كلمات',
  exact: 'تطابق تام',
  any: 'أي تعليق',
};

export function RulesView({
  rules,
  pages,
  onCreateRule,
  onEditRule,
  onToggleRule,
  onDeleteRule,
}: RulesViewProps) {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [pageFilter, setPageFilter] = useState('all');

  const pageMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of pages) map.set(p.id, p.name);
    return map;
  }, [pages]);

  const filteredRules = useMemo(() => {
    return rules.filter((rule) => {
      if (statusFilter === 'enabled' && !rule.enabled) return false;
      if (statusFilter === 'disabled' && rule.enabled) return false;
      if (pageFilter !== 'all' && rule.pageId !== pageFilter) return false;
      if (search.trim()) {
        const q = search.trim().toLowerCase();
        const matchesName = rule.name.toLowerCase().includes(q);
        const matchesKw = rule.keywords.some((k) => k.toLowerCase().includes(q));
        const matchesReply = rule.publicReplies.some((r) => r.toLowerCase().includes(q));
        const matchesPrompt = (rule.aiPrompt || '').toLowerCase().includes(q);
        if (!matchesName && !matchesKw && !matchesReply && !matchesPrompt) return false;
      }
      return true;
    });
  }, [rules, statusFilter, pageFilter, search]);

  return (
    <div className="space-y-5">
      {/* Toolbar */}
      <div className="flex flex-col justify-between gap-3 rounded-xl border border-slate-200 bg-white p-4 sm:flex-row sm:items-center">
        <div className="flex flex-1 flex-wrap items-center gap-3">
          <div className="relative min-w-[220px] flex-1 sm:max-w-xs">
            <Search className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="ابحث باسم القاعدة أو الكلمة المفتاحية..."
              className="w-full rounded-lg border border-slate-300 py-2 pr-9 pl-3 text-sm text-slate-900 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/15"
            />
          </div>

          <select
            value={pageFilter}
            onChange={(e) => setPageFilter(e.target.value)}
            aria-label="تصفية حسب الصفحة"
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 focus:border-blue-600 focus:outline-none"
          >
            <option value="all">جميع الصفحات</option>
            {pages.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>

          <div className="flex items-center gap-1 rounded-lg bg-slate-100 p-1">
            <button
              type="button"
              onClick={() => setStatusFilter('all')}
              className={`rounded-md px-3 py-1.5 text-xs font-medium whitespace-nowrap transition-colors ${
                statusFilter === 'all'
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              الكل
            </button>
            <button
              type="button"
              onClick={() => setStatusFilter('enabled')}
              className={`rounded-md px-3 py-1.5 text-xs font-medium whitespace-nowrap transition-colors ${
                statusFilter === 'enabled'
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              مفعّلة
            </button>
            <button
              type="button"
              onClick={() => setStatusFilter('disabled')}
              className={`rounded-md px-3 py-1.5 text-xs font-medium whitespace-nowrap transition-colors ${
                statusFilter === 'disabled'
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              متوقفة
            </button>
          </div>
        </div>

        <button
          type="button"
          onClick={onCreateRule}
          className="inline-flex items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white whitespace-nowrap shrink-0 transition-colors hover:bg-blue-700"
        >
          <Plus className="h-4 w-4" />
          <span>قاعدة جديدة</span>
        </button>
      </div>

      {/* Rules List */}
      {filteredRules.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white px-6 py-14 text-center">
          <p className="text-base font-semibold text-slate-900">
            {rules.length === 0 ? 'لا توجد قواعد رد تلقائي حتى الآن' : 'لا توجد قواعد مطابقة للبحث'}
          </p>
          <p className="mx-auto mt-1.5 max-w-md text-sm text-slate-500">
            أنشئ قاعدة جديدة لتحديد الكلمات المفتاحية مثل &quot;السعر&quot; أو &quot;التفاصيل&quot; والرد عليها فورياً في التعليقات وماسنجر.
          </p>
          {rules.length === 0 && (
            <button
              type="button"
              onClick={onCreateRule}
              className="mt-5 inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
            >
              <Plus className="h-4 w-4" />
              <span>إنشاء أول قاعدة رد</span>
            </button>
          )}
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          <ul className="divide-y divide-slate-200">
            {filteredRules.map((rule) => {
              const targetPageName =
                rule.pageId === 'all'
                  ? 'جميع الصفحات'
                  : pageMap.get(rule.pageId) || 'صفحة محذوفة';

              return (
                <li
                  key={rule.id}
                  className="flex flex-col justify-between gap-4 p-6 transition-colors hover:bg-slate-50/50 lg:flex-row lg:items-center"
                >
                  <div className="min-w-0 flex-1 space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-base font-semibold text-slate-900">{rule.name}</h3>
                      <span aria-hidden="true" className="text-slate-300">
                        ·
                      </span>
                      <span
                        className={`text-xs font-medium ${
                          rule.enabled ? 'text-emerald-700' : 'text-slate-500'
                        }`}
                      >
                        {rule.enabled ? 'مفعّلة' : 'متوقفة'}
                      </span>
                    </div>

                    {/* Clean unboxed inline metadata */}
                    <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                      <span>{targetPageName}</span>
                      <span aria-hidden="true">·</span>
                      <span>
                        {rule.postId === 'all' ? 'جميع المنشورات' : 'منشور محدد'}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span>{MATCH_MODE_LABELS[rule.matchMode]}</span>
                      <span aria-hidden="true">·</span>
                      <span className="tabular-nums">تم التشغيل {rule.triggeredCount} مرة</span>
                    </div>

                    {rule.keywords.length > 0 && (
                      <p className="text-xs text-slate-600">
                        الكلمات المفتاحية:{' '}
                        <span className="font-medium text-slate-800">
                          {rule.keywords.join('، ')}
                        </span>
                      </p>
                    )}

                    <div className="flex flex-wrap items-center gap-4 pt-1 text-xs text-slate-600">
                      {rule.replyType === 'ai' ? (
                        <span className="inline-flex items-center gap-1.5 font-medium text-blue-700">
                          <Sparkles className="h-3.5 w-3.5" />
                          <span className="max-w-md truncate">
                            ذكاء اصطناعي{rule.aiPrompt ? `: ${rule.aiPrompt}` : ' (توليد ذكي + ذاكرة مخزنة)'}
                          </span>
                        </span>
                      ) : (
                        rule.publicReplies.length > 0 && (
                          <span className="inline-flex items-center gap-1.5">
                            <MessageSquare className="h-3.5 w-3.5 text-slate-400" />
                            <span className="max-w-md truncate">
                              {rule.publicReplies[0]}
                              {rule.publicReplies.length > 1
                                ? ` (+${rule.publicReplies.length - 1} صيغ)`
                                : ''}
                            </span>
                          </span>
                        )
                      )}
                      {rule.sendPrivateReply && (
                        <span className="inline-flex items-center gap-1.5 text-blue-700">
                          <Send className="h-3.5 w-3.5" />
                          <span>رسالة خاصة مفعّلة</span>
                        </span>
                      )}
                      {rule.likeComment && (
                        <span className="inline-flex items-center gap-1.5 text-slate-600">
                          <Heart className="h-3.5 w-3.5 text-rose-500" />
                          <span>إعجاب تلقائي</span>
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => onToggleRule(rule)}
                      className={`rounded-lg border px-3 py-1.5 text-xs font-medium whitespace-nowrap transition-colors ${
                        rule.enabled
                          ? 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
                          : 'border-emerald-600 bg-emerald-600 text-white hover:bg-emerald-700'
                      }`}
                    >
                      {rule.enabled ? 'إيقاف مؤقت' : 'تفعيل'}
                    </button>
                    <button
                      type="button"
                      onClick={() => onEditRule(rule)}
                      aria-label="تعديل القاعدة"
                      className="rounded-lg border border-slate-200 bg-white p-2 text-slate-600 transition-colors hover:bg-slate-50 hover:text-slate-900"
                    >
                      <Edit3 className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => onDeleteRule(rule)}
                      aria-label="حذف القاعدة"
                      className="rounded-lg border border-slate-200 bg-white p-2 text-slate-500 transition-colors hover:border-red-200 hover:bg-red-50 hover:text-red-600"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
