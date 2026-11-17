import { useMemo, useState } from 'react';
import { AlertCircle, CheckCircle2, Database, Heart, Search, Slash, Sparkles, Trash2 } from 'lucide-react';
import type { FacebookPage, ReplyLogEntry } from '../types/facebook';

interface LogsViewProps {
  logs: ReplyLogEntry[];
  pages: FacebookPage[];
  onClearLogs: () => void;
}

type LogStatusFilter = 'all' | 'replied' | 'skipped' | 'failed';

const SOURCE_LABELS: Record<ReplyLogEntry['source'], string> = {
  webhook: 'ويب هوك فوري',
  sync: 'مزامنة الصفحة',
  tester: 'مختبر القواعد',
};

const REPLY_SOURCE_LABELS: Record<NonNullable<ReplyLogEntry['replySource']>, string> = {
  rule: 'قالب نصي',
  ai: 'ذكاء اصطناعي',
  'ai-cache': 'ذاكرة AI المخزنة',
  fallback: 'رد احتياطي',
};

export function LogsView({ logs, pages, onClearLogs }: LogsViewProps) {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<LogStatusFilter>('all');
  const [pageFilter, setPageFilter] = useState('all');

  const filteredLogs = useMemo(() => {
    return logs.filter((log) => {
      if (statusFilter !== 'all' && log.status !== statusFilter) return false;
      if (pageFilter !== 'all' && log.pageId !== pageFilter) return false;
      if (search.trim()) {
        const q = search.trim().toLowerCase();
        const hit =
          log.commentText.toLowerCase().includes(q) ||
          log.commenterName.toLowerCase().includes(q) ||
          (log.matchedRuleName || '').toLowerCase().includes(q) ||
          (log.publicReplySent || '').toLowerCase().includes(q);
        if (!hit) return false;
      }
      return true;
    });
  }, [logs, statusFilter, pageFilter, search]);

  return (
    <div className="space-y-5">
      <div className="flex flex-col justify-between gap-3 rounded-xl border border-slate-200 bg-white p-4 sm:flex-row sm:items-center">
        <div className="flex flex-1 flex-wrap items-center gap-3">
          <div className="relative min-w-[220px] flex-1 sm:max-w-xs">
            <Search className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="ابحث في التعليقات أو الردود..."
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
            {(['all', 'replied', 'skipped', 'failed'] as const).map((st) => {
              const labels: Record<LogStatusFilter, string> = {
                all: 'الكل',
                replied: 'تم الرد',
                skipped: 'متجاهل',
                failed: 'فشل',
              };
              return (
                <button
                  key={st}
                  type="button"
                  onClick={() => setStatusFilter(st)}
                  className={`rounded-md px-3 py-1.5 text-xs font-medium whitespace-nowrap transition-colors ${
                    statusFilter === st
                      ? 'bg-white text-slate-900 shadow-sm'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {labels[st]}
                </button>
              );
            })}
          </div>
        </div>

        {logs.length > 0 && (
          <button
            type="button"
            onClick={onClearLogs}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 whitespace-nowrap shrink-0 hover:border-red-200 hover:bg-red-50 hover:text-red-600"
          >
            <Trash2 className="h-3.5 w-3.5" />
            <span>مسح السجل</span>
          </button>
        )}
      </div>

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        {filteredLogs.length === 0 ? (
          <div className="px-6 py-14 text-center">
            <p className="text-sm font-medium text-slate-700">لا توجد سجلات مطابقة للعرض</p>
            <p className="mt-1 text-xs text-slate-500">
              ستظهر هنا تفاصيل كل تعليق تمت معالجته والرد العام أو الرسالة الخاصة المرسلة.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-right text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-500">
                  <th className="px-5 py-3">المعلّق والتعليق</th>
                  <th className="px-5 py-3">القاعدة والرد المرسل</th>
                  <th className="px-5 py-3">المصدر والوقت</th>
                  <th className="px-5 py-3">الحالة</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredLogs.map((log) => (
                  <tr key={log.id} className="align-top transition-colors hover:bg-slate-50/70">
                    <td className="max-w-xs px-5 py-3.5">
                      <div className="text-xs font-medium text-slate-900">
                        {log.commenterName}{' '}
                        <span className="font-normal text-slate-400">· {log.pageName}</span>
                      </div>
                      <p className="mt-1 text-sm text-slate-700">&quot;{log.commentText}&quot;</p>
                    </td>

                    <td className="max-w-sm px-5 py-3.5">
                      {log.matchedRuleName ? (
                        <div className="space-y-1">
                          <div className="flex flex-wrap items-center gap-2 text-xs font-medium text-slate-800">
                            <span>{log.matchedRuleName}</span>
                            {log.replySource && log.replySource !== 'rule' && (
                              <>
                                <span aria-hidden="true" className="text-slate-300">
                                  ·
                                </span>
                                <span
                                  className={`inline-flex items-center gap-1 font-normal ${
                                    log.replySource === 'ai'
                                      ? 'text-blue-700'
                                      : log.replySource === 'ai-cache'
                                      ? 'text-amber-700'
                                      : 'text-slate-600'
                                  }`}
                                >
                                  {log.replySource === 'ai' ? (
                                    <Sparkles className="h-3 w-3" />
                                  ) : (
                                    <Database className="h-3 w-3" />
                                  )}
                                  <span>{REPLY_SOURCE_LABELS[log.replySource]}</span>
                                </span>
                              </>
                            )}
                            {log.likedComment && (
                              <Heart className="h-3 w-3 text-rose-500" aria-label="إعجاب بالتعليق" />
                            )}
                          </div>
                          {log.publicReplySent && (
                            <p className="text-xs text-slate-600">
                              <span className="text-slate-400">عام:</span> {log.publicReplySent}
                            </p>
                          )}
                          {log.privateReplySent && (
                            <p className="text-xs text-blue-700">
                              <span className="text-blue-500">خاص:</span> {log.privateReplySent}
                            </p>
                          )}
                          {log.errorMessage && (
                            <p className="text-xs text-red-600">{log.errorMessage}</p>
                          )}
                        </div>
                      ) : (
                        <span className="text-xs text-slate-500">
                          {log.errorMessage || 'بدون قاعدة مطابقة'}
                        </span>
                      )}
                    </td>

                    <td className="px-5 py-3.5 text-xs text-slate-500 whitespace-nowrap">
                      <div>{SOURCE_LABELS[log.source]}</div>
                      <div className="mt-1 font-mono tabular-nums text-slate-400">
                        {new Date(log.createdAt).toLocaleString('ar-EG', {
                          month: '2-digit',
                          day: '2-digit',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </div>
                    </td>

                    <td className="px-5 py-3.5 whitespace-nowrap">
                      {log.status === 'replied' && (
                        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-700">
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          <span>تم الرد</span>
                        </span>
                      )}
                      {log.status === 'skipped' && (
                        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-700">
                          <Slash className="h-3.5 w-3.5" />
                          <span>متجاهل</span>
                        </span>
                      )}
                      {log.status === 'failed' && (
                        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-red-600">
                          <AlertCircle className="h-3.5 w-3.5" />
                          <span>فشل</span>
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
