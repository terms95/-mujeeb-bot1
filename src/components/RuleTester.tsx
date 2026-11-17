import { useState } from 'react';
import { CheckCircle2, Database, Heart, MessageSquare, Send, Slash, Sparkles } from 'lucide-react';
import type { FacebookPage, ReplyLogEntry } from '../types/facebook';
import { api } from '../lib/api';

interface RuleTesterProps {
  pages: FacebookPage[];
  onSimulated: () => void;
}

const QUICK_COMMENTS = ['بكم السعر لو سمحت؟', 'ممكن تفاصيل التوصيل للقاهرة؟', 'هل المنتج متاح حالياً؟'];

export function RuleTester({ pages, onSimulated }: RuleTesterProps) {
  const [pageId, setPageId] = useState<string>(pages[0]?.id || 'all');
  const [commenterName, setCommenterName] = useState('سارة محمود');
  const [commentText, setCommentText] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ReplyLogEntry | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleRunTest = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!commentText.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.simulateComment({
        pageId: pageId === 'all' ? pages[0]?.id : pageId,
        commenterName: commenterName.trim() || 'عميل جديد',
        commentText: commentText.trim(),
      });
      setResult(res.result);
      onSimulated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذر إجراء الاختبار');
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="rounded-xl border border-slate-200 bg-white">
      <div className="border-b border-slate-200 px-6 py-4">
        <h3 className="text-base font-semibold text-slate-900">مُختبِر القواعد الفوري</h3>
        <p className="mt-0.5 text-xs text-slate-500">
          جرّب أي تعليق للتحقق من القاعدة المطابقة وشكل الرد العام والرسالة الخاصة قبل النشر
        </p>
      </div>

      <form onSubmit={handleRunTest} className="space-y-4 p-6">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="tester-name" className="block text-xs font-medium text-slate-700">
              اسم المعلّق
            </label>
            <input
              id="tester-name"
              type="text"
              value={commenterName}
              onChange={(e) => setCommenterName(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/15"
            />
          </div>
          <div>
            <label htmlFor="tester-page" className="block text-xs font-medium text-slate-700">
              الصفحة المستهدفة
            </label>
            <select
              id="tester-page"
              value={pageId}
              onChange={(e) => setPageId(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/15"
            >
              {pages.length === 0 && <option value="all">صفحة تجريبية افتراضية</option>}
              {pages.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <label htmlFor="tester-comment" className="block text-xs font-medium text-slate-700">
            نص تعليق العميل
          </label>
          <textarea
            id="tester-comment"
            rows={2}
            value={commentText}
            onChange={(e) => setCommentText(e.target.value)}
            placeholder="اكتب تعليقاً لاختبار المطابقة (مثال: بكم السعر؟)"
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/15"
          />
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-slate-500">نماذج سريعة:</span>
            {QUICK_COMMENTS.map((sample) => (
              <button
                key={sample}
                type="button"
                onClick={() => setCommentText(sample)}
                className="rounded border border-slate-200 bg-slate-50 px-2 py-0.5 text-xs text-slate-600 transition-colors hover:border-blue-300 hover:text-blue-700"
              >
                {sample}
              </button>
            ))}
          </div>
        </div>

        {error && <p className="text-xs text-red-600">{error}</p>}

        <div className="flex justify-end">
          <button
            type="submit"
            disabled={loading || !commentText.trim()}
            className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white whitespace-nowrap shrink-0 transition-colors hover:bg-blue-700 disabled:opacity-50"
          >
            <Send className="h-4 w-4" />
            <span>{loading ? 'جاري الاختبار...' : 'اختبار المطابقة'}</span>
          </button>
        </div>
      </form>

      {result && (
        <div className="border-t border-slate-200 bg-slate-50/70 px-6 py-4">
          {result.status === 'replied' ? (
            <div className="space-y-2.5 text-sm">
              <div className="flex flex-wrap items-center gap-2 text-emerald-700">
                <CheckCircle2 className="h-4 w-4 shrink-0" />
                <span className="font-medium">تطابق مع القاعدة: {result.matchedRuleName}</span>
                {result.replySource && result.replySource !== 'rule' && (
                  <>
                    <span aria-hidden="true" className="text-slate-300">
                      ·
                    </span>
                    <span className="inline-flex items-center gap-1 text-xs font-medium text-blue-700">
                      {result.replySource === 'ai' ? (
                        <Sparkles className="h-3.5 w-3.5" />
                      ) : (
                        <Database className="h-3.5 w-3.5 text-amber-600" />
                      )}
                      <span>
                        {result.replySource === 'ai'
                          ? 'رد بالذكاء الاصطناعي'
                          : result.replySource === 'ai-cache'
                          ? 'رد من ذاكرة AI المخزنة'
                          : 'رد احتياطي'}
                      </span>
                    </span>
                  </>
                )}
              </div>
              {result.publicReplySent && (
                <div className="space-y-1">
                  <div className="flex items-center gap-1.5 text-xs font-medium text-slate-500">
                    <MessageSquare className="h-3.5 w-3.5" />
                    <span>الرد العام على التعليق</span>
                  </div>
                  <p className="text-sm text-slate-800">{result.publicReplySent}</p>
                </div>
              )}
              {result.privateReplySent && (
                <div className="space-y-1 border-t border-slate-200 pt-2">
                  <div className="flex items-center gap-1.5 text-xs font-medium text-slate-500">
                    <Send className="h-3.5 w-3.5" />
                    <span>رسالة ماسنجر الخاصة</span>
                  </div>
                  <p className="text-sm text-slate-800">{result.privateReplySent}</p>
                </div>
              )}
              {result.likedComment && (
                <div className="flex items-center gap-1.5 text-xs text-slate-600">
                  <Heart className="h-3.5 w-3.5 text-rose-500" />
                  <span>تم تسجيل إعجاب تلقائي بالتعليق</span>
                </div>
              )}
            </div>
          ) : (
            <div className="flex items-center gap-2 text-sm text-amber-700">
              <Slash className="h-4 w-4 shrink-0" />
              <span>{result.errorMessage || 'لم تتطابق أي قاعدة مفعّلة مع هذا التعليق'}</span>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
