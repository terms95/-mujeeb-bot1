import { useEffect, useState } from 'react';
import { Plus, Sparkles, Trash2, X } from 'lucide-react';
import type {
  AutoReplyRule,
  FacebookPage,
  FacebookPost,
  MatchMode,
  ReplyType,
} from '../types/facebook';
import { api } from '../lib/api';

interface RuleModalProps {
  open: boolean;
  pages: FacebookPage[];
  editingRule: AutoReplyRule | null;
  presetPageId?: string;
  presetPost?: FacebookPost | null;
  onClose: () => void;
  onSaved: (message: string) => void;
}

const KEYWORD_SUGGESTIONS = ['السعر', 'بكم', 'تفاصيل', 'معلومات', 'عنوان', 'توصيل', 'متاح'];
const DEFAULT_PUBLIC_TEMPLATE = 'أهلاً بك {name}، تم إرسال كافة التفاصيل لك في رسالة خاصة!';
const DEFAULT_PRIVATE_TEMPLATE = 'مرحباً {name}، يسعدنا تواصلك مع {page}. إليك تفاصيل العرض:';

export function RuleModal({
  open,
  pages,
  editingRule,
  presetPageId,
  presetPost,
  onClose,
  onSaved,
}: RuleModalProps) {
  const [name, setName] = useState('');
  const [pageId, setPageId] = useState('all');
  const [postId, setPostId] = useState('all');
  const [postPreview, setPostPreview] = useState<string | undefined>(undefined);
  const [posts, setPosts] = useState<FacebookPost[]>([]);
  const [loadingPosts, setLoadingPosts] = useState(false);

  const [matchMode, setMatchMode] = useState<MatchMode>('contains');
  const [keywordsText, setKeywordsText] = useState('');
  const [excludeText, setExcludeText] = useState('');
  const [replyType, setReplyType] = useState<ReplyType>('template');
  const [aiPrompt, setAiPrompt] = useState('');
  const [publicReplies, setPublicReplies] = useState<string[]>(['']);
  const [likeComment, setLikeComment] = useState(true);
  const [sendPrivateReply, setSendPrivateReply] = useState(false);
  const [privateReplyText, setPrivateReplyText] = useState('');
  const [priority, setPriority] = useState(10);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    if (editingRule) {
      setName(editingRule.name);
      setPageId(editingRule.pageId);
      setPostId(editingRule.postId);
      setPostPreview(editingRule.postPreview);
      setMatchMode(editingRule.matchMode);
      setKeywordsText(editingRule.keywords.join('، '));
      setExcludeText(editingRule.excludeKeywords.join('، '));
      setReplyType(editingRule.replyType === 'ai' ? 'ai' : 'template');
      setAiPrompt(editingRule.aiPrompt || '');
      setPublicReplies(editingRule.publicReplies.length > 0 ? editingRule.publicReplies : ['']);
      setLikeComment(editingRule.likeComment);
      setSendPrivateReply(editingRule.sendPrivateReply);
      setPrivateReplyText(editingRule.privateReplyText || '');
      setPriority(editingRule.priority || 10);
    } else {
      setName('');
      setPageId(presetPageId || (pages[0]?.id ?? 'all'));
      setPostId(presetPost?.id || 'all');
      setPostPreview(presetPost?.message);
      setMatchMode('contains');
      setKeywordsText('');
      setExcludeText('');
      setReplyType('template');
      setAiPrompt('');
      setPublicReplies([DEFAULT_PUBLIC_TEMPLATE]);
      setLikeComment(true);
      setSendPrivateReply(true);
      setPrivateReplyText(DEFAULT_PRIVATE_TEMPLATE);
      setPriority(10);
    }
  }, [open, editingRule, presetPageId, presetPost, pages]);

  useEffect(() => {
    if (!open || pageId === 'all') {
      setPosts([]);
      return;
    }
    let cancelled = false;
    setLoadingPosts(true);
    api
      .getPagePosts(pageId)
      .then((res) => {
        if (!cancelled) setPosts(res.posts);
      })
      .catch(() => {
        if (!cancelled) setPosts([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingPosts(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, pageId]);

  if (!open) return null;

  const parseKeywordList = (raw: string) =>
    raw
      .split(/[،,\n]+/)
      .map((s) => s.trim())
      .filter(Boolean);

  const handleAddSuggestion = (word: string) => {
    const existing = parseKeywordList(keywordsText);
    if (existing.includes(word)) return;
    setKeywordsText(existing.length > 0 ? `${existing.join('، ')}، ${word}` : word);
  };

  const insertVariable = (target: 'public' | 'private', variable: string, index = 0) => {
    if (target === 'public') {
      setPublicReplies((prev) =>
        prev.map((item, idx) => (idx === index ? `${item}${item && !item.endsWith(' ') ? ' ' : ''}${variable}` : item))
      );
    } else {
      setPrivateReplyText(
        (prev) => `${prev}${prev && !prev.endsWith(' ') ? ' ' : ''}${variable}`
      );
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const keywords = parseKeywordList(keywordsText);
    if (matchMode !== 'any' && keywords.length === 0) {
      setError('يرجى إدخال كلمة مفتاحية واحدة على الأقل أو اختيار "أي تعليق"');
      return;
    }

    const cleanedReplies = publicReplies.map((r) => r.trim()).filter(Boolean);
    if (
      replyType !== 'ai' &&
      cleanedReplies.length === 0 &&
      (!sendPrivateReply || !privateReplyText.trim())
    ) {
      setError('أدخل رداً عاماً واحداً على الأقل أو فعّل الرسالة الخاصة');
      return;
    }

    const selectedPost = posts.find((p) => p.id === postId);

    setSaving(true);
    try {
      const payload: Partial<AutoReplyRule> = {
        name: name.trim(),
        pageId,
        postId,
        postPreview: postId === 'all' ? undefined : selectedPost?.message || postPreview,
        matchMode,
        keywords,
        excludeKeywords: parseKeywordList(excludeText),
        replyType,
        aiPrompt: aiPrompt.trim(),
        publicReplies: cleanedReplies,
        likeComment,
        sendPrivateReply,
        privateReplyText: privateReplyText.trim(),
        priority,
      };

      if (editingRule) {
        await api.updateRule(editingRule.id, payload);
        onSaved('تم تحديث قاعدة الرد التلقائي بنجاح');
      } else {
        await api.createRule(payload);
        onSaved('تم إنشاء قاعدة الرد التلقائي بنجاح');
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذر حفظ القاعدة');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-[1px]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="rule-modal-title"
    >
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-xl border border-slate-200 bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
          <div>
            <h2 id="rule-modal-title" className="text-lg font-semibold text-slate-900">
              {editingRule ? 'تعديل قاعدة الرد' : 'إنشاء قاعدة رد تلقائي'}
            </h2>
            <p className="mt-0.5 text-xs text-slate-500">
              حدد شروط التعليق والرد العام أو الرسالة الخاصة التي تُرسل تلقائياً
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

        <form onSubmit={handleSubmit} className="flex-1 space-y-5 overflow-y-auto p-6">
          {error && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          )}

          {/* Rule Name & Priority */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
            <div className="sm:col-span-3">
              <label htmlFor="rule-name" className="block text-sm font-medium text-slate-800">
                اسم القاعدة
              </label>
              <input
                id="rule-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="مثال: الرد على استفسارات السعر"
                required
                className="mt-1.5 w-full rounded-lg border border-slate-300 px-3.5 py-2 text-sm text-slate-900 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/15"
              />
            </div>
            <div>
              <label htmlFor="rule-priority" className="block text-sm font-medium text-slate-800">
                الأولوية
              </label>
              <input
                id="rule-priority"
                type="number"
                min={1}
                max={100}
                value={priority}
                onChange={(e) => setPriority(Number(e.target.value) || 10)}
                className="mt-1.5 w-full rounded-lg border border-slate-300 px-3.5 py-2 font-mono text-sm tabular-nums text-slate-900 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/15"
              />
            </div>
          </div>

          {/* Target Page & Post */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="rule-page" className="block text-sm font-medium text-slate-800">
                الصفحة المستهدفة
              </label>
              <select
                id="rule-page"
                value={pageId}
                onChange={(e) => {
                  setPageId(e.target.value);
                  setPostId('all');
                }}
                className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm text-slate-900 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/15"
              >
                <option value="all">جميع الصفحات المتصلة</option>
                {pages.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} {p.mode === 'sandbox' ? '(تجريبية)' : ''}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="rule-post" className="block text-sm font-medium text-slate-800">
                المنشور المستهدف
              </label>
              <select
                id="rule-post"
                value={postId}
                disabled={pageId === 'all' || loadingPosts}
                onChange={(e) => setPostId(e.target.value)}
                className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm text-slate-900 disabled:bg-slate-50 disabled:text-slate-500 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/15"
              >
                <option value="all">جميع منشورات الصفحة</option>
                {posts.map((post) => (
                  <option key={post.id} value={post.id}>
                    {post.message.slice(0, 52)}
                    {post.message.length > 52 ? '...' : ''}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Match Mode & Keywords */}
          <div className="border-t border-slate-100 pt-5">
            <span className="block text-sm font-medium text-slate-800">شرط التطابق مع التعليق</span>
            <div className="mt-2 grid grid-cols-3 gap-1 rounded-lg bg-slate-100 p-1">
              <button
                type="button"
                onClick={() => setMatchMode('contains')}
                className={`rounded-md px-3 py-1.5 text-xs font-medium whitespace-nowrap transition-colors ${
                  matchMode === 'contains'
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                يحتوي على كلمات
              </button>
              <button
                type="button"
                onClick={() => setMatchMode('exact')}
                className={`rounded-md px-3 py-1.5 text-xs font-medium whitespace-nowrap transition-colors ${
                  matchMode === 'exact'
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                تطابق تام
              </button>
              <button
                type="button"
                onClick={() => setMatchMode('any')}
                className={`rounded-md px-3 py-1.5 text-xs font-medium whitespace-nowrap transition-colors ${
                  matchMode === 'any'
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                أي تعليق
              </button>
            </div>

            {matchMode !== 'any' && (
              <div className="mt-3">
                <label htmlFor="rule-keywords" className="block text-xs font-medium text-slate-700">
                  الكلمات المفتاحية (افصل بينها بفاصلة)
                </label>
                <input
                  id="rule-keywords"
                  type="text"
                  value={keywordsText}
                  onChange={(e) => setKeywordsText(e.target.value)}
                  placeholder="مثال: السعر، بكم، تفاصيل، توصيل"
                  className="mt-1.5 w-full rounded-lg border border-slate-300 px-3.5 py-2 text-sm text-slate-900 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/15"
                />
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <span className="text-xs text-slate-500">إضافة سريعة:</span>
                  {KEYWORD_SUGGESTIONS.map((word) => (
                    <button
                      key={word}
                      type="button"
                      onClick={() => handleAddSuggestion(word)}
                      className="rounded border border-slate-200 bg-slate-50 px-2 py-0.5 text-xs text-slate-700 transition-colors hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700"
                    >
                      + {word}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="mt-3">
              <label htmlFor="rule-exclude" className="block text-xs font-medium text-slate-700">
                كلمات مستثناة — اختياري (لا ترد إذا وردت في التعليق)
              </label>
              <input
                id="rule-exclude"
                type="text"
                value={excludeText}
                onChange={(e) => setExcludeText(e.target.value)}
                placeholder="مثال: شكوى، تم البيع، إلغاء"
                className="mt-1.5 w-full rounded-lg border border-slate-300 px-3.5 py-2 text-sm text-slate-900 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/15"
              />
            </div>
          </div>

          {/* Reply Mode Selector (Template vs AI) */}
          <div className="border-t border-slate-100 pt-5">
            <span className="block text-sm font-medium text-slate-800">أسلوب توليد الرد</span>
            <div className="mt-2 grid grid-cols-2 gap-1 rounded-lg bg-slate-100 p-1">
              <button
                type="button"
                onClick={() => {
                  setReplyType('template');
                  if (publicReplies.length === 1 && !publicReplies[0].trim()) {
                    setPublicReplies([DEFAULT_PUBLIC_TEMPLATE]);
                  }
                }}
                className={`rounded-md px-3 py-2 text-xs font-medium whitespace-nowrap transition-colors ${
                  replyType === 'template'
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                قوالب نصية ثابتة / عشوائية
              </button>
              <button
                type="button"
                onClick={() => {
                  setReplyType('ai');
                  if (
                    publicReplies.length === 1 &&
                    publicReplies[0].trim() === DEFAULT_PUBLIC_TEMPLATE
                  ) {
                    setPublicReplies(['']);
                  }
                  if (privateReplyText.trim() === DEFAULT_PRIVATE_TEMPLATE) {
                    setPrivateReplyText('');
                  }
                }}
                className={`inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-2 text-xs font-medium whitespace-nowrap transition-colors ${
                  replyType === 'ai'
                    ? 'bg-white text-blue-700 shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <Sparkles className="h-3.5 w-3.5" />
                <span>الرد بالذكاء الاصطناعي (مع ذاكرة احتياطية)</span>
              </button>
            </div>

            {replyType === 'ai' && (
              <div className="mt-4 space-y-3 rounded-lg border border-blue-200 bg-blue-50/50 p-4">
                <div>
                  <label htmlFor="rule-ai-prompt" className="block text-xs font-semibold text-slate-800">
                    توجيهات الذكاء الاصطناعي ومعلومات الصفحة / المنتج
                  </label>
                  <p className="mt-0.5 text-xs text-slate-500">
                    اكتب تفاصيل الأسعار، الشحن، العنوان، وأسلوب الحديث المطلوب حتى يرد الذكاء الاصطناعي بدقة على كل تعليق.
                  </p>
                  <textarea
                    id="rule-ai-prompt"
                    rows={3}
                    value={aiPrompt}
                    onChange={(e) => setAiPrompt(e.target.value)}
                    placeholder="مثال: نحن متجر أزياء. سعر الطقم 450 جنيه والتوصيل خلال 48 ساعة لجميع المحافظات بـ 50 جنيه. رد بأسلوب مصري لطيف ومختصر."
                    className="mt-2 w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm text-slate-900 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/15"
                  />
                </div>
                <p className="text-xs leading-relaxed text-slate-600">
                  يُحفظ كل رد يولّده الذكاء الاصطناعي تلقائياً في الذاكرة المحلية؛ وفي حال بلوغ حد الاستخدام المؤقت للخدمة، يختار النظام أنسب رد مخزن مشابهاً للتعليق تلقائياً حتى يعود الذكاء الاصطناعي للعمل.
                </p>
              </div>
            )}
          </div>

          {/* Public Replies */}
          <div className="border-t border-slate-100 pt-5">
            <div className="flex items-center justify-between">
              <div>
                <span className="block text-sm font-medium text-slate-800">
                  {replyType === 'ai'
                    ? 'ردود عامة احتياطية (اختياري — تُستخدم فقط إذا كانت الذاكرة فارغة)'
                    : 'الردود العامة على التعليق'}
                </span>
                <p className="text-xs text-slate-500">
                  يمكنك استخدام{' '}
                  <span dir="ltr" className="font-mono text-slate-700">
                    {'{😀|❤️|💜}'}
                  </span>{' '}
                  أو{' '}
                  <span dir="ltr" className="font-mono text-slate-700">
                    {'{أهلاً|مرحباً}'}
                  </span>{' '}
                  لاختيار رد عشوائي دون تكرار
                </p>
              </div>
              {publicReplies.length < 4 && (
                <button
                  type="button"
                  onClick={() => setPublicReplies((prev) => [...prev, ''])}
                  className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                >
                  <Plus className="h-3.5 w-3.5" />
                  <span>صيغة إضافية</span>
                </button>
              )}
            </div>

            <div className="mt-3 space-y-3">
              {publicReplies.map((reply, idx) => (
                <div key={idx} className="space-y-1.5">
                  <div className="flex items-center justify-between text-xs text-slate-500">
                    <span>
                      {replyType === 'ai' ? `رد احتياطي ${idx + 1}` : `صيغة الرد ${idx + 1}`}
                    </span>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => insertVariable('public', '{name}', idx)}
                        className="text-blue-600 hover:underline"
                      >
                        + اسم المعلّق
                      </button>
                      <button
                        type="button"
                        onClick={() => insertVariable('public', '{page}', idx)}
                        className="text-blue-600 hover:underline"
                      >
                        + اسم الصفحة
                      </button>
                      <button
                        type="button"
                        onClick={() => insertVariable('public', '{😀|❤️|💜}', idx)}
                        className="text-blue-600 hover:underline"
                      >
                        + تنويع عشوائي
                      </button>
                      {publicReplies.length > 1 && (
                        <button
                          type="button"
                          onClick={() =>
                            setPublicReplies((prev) => prev.filter((_, i) => i !== idx))
                          }
                          aria-label="حذف صيغة الرد"
                          className="text-slate-400 hover:text-red-600"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                  <textarea
                    rows={2}
                    value={reply}
                    onChange={(e) =>
                      setPublicReplies((prev) =>
                        prev.map((item, i) => (i === idx ? e.target.value : item))
                      )
                    }
                    placeholder={
                      replyType === 'ai'
                        ? 'اختياري: نص يُستخدم كاحتياطي أولي قبل امتلاء ذاكرة الذكاء الاصطناعي...'
                        : 'اكتب نص الرد على التعليق...'
                    }
                    className="w-full rounded-lg border border-slate-300 px-3.5 py-2 text-sm text-slate-900 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/15"
                  />
                </div>
              ))}
            </div>
          </div>

          {/* Like + Private Reply */}
          <div className="space-y-4 border-t border-slate-100 pt-5">
            <label className="flex items-center justify-between gap-4">
              <div>
                <span className="block text-sm font-medium text-slate-800">
                  الإعجاب بالتعليق تلقائياً
                </span>
                <span className="block text-xs text-slate-500">
                  إضافة تفاعل إعجاب باسم الصفحة على تعليق العميل عند الرد
                </span>
              </div>
              <input
                type="checkbox"
                checked={likeComment}
                onChange={(e) => setLikeComment(e.target.checked)}
                className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-600"
              />
            </label>

            <label className="flex items-center justify-between gap-4">
              <div>
                <span className="block text-sm font-medium text-slate-800">
                  إرسال رسالة خاصة في ماسنجر (Private Reply)
                </span>
                <span className="block text-xs text-slate-500">
                  يُرسل رسالة مباشرة لصندوق وارد المعلّق متضمنة تفاصيل السعر أو رابط الطلب
                </span>
              </div>
              <input
                type="checkbox"
                checked={sendPrivateReply}
                onChange={(e) => setSendPrivateReply(e.target.checked)}
                className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-600"
              />
            </label>

            {sendPrivateReply && (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs text-slate-500">
                  <span>
                    {replyType === 'ai'
                      ? 'رسالة خاصة احتياطية (اختياري — يولّدها الذكاء الاصطناعي تلقائياً)'
                      : 'نص الرسالة الخاصة'}
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => insertVariable('private', '{name}')}
                      className="text-blue-600 hover:underline"
                    >
                      + اسم المعلّق
                    </button>
                    <button
                      type="button"
                      onClick={() => insertVariable('private', '{page}')}
                      className="text-blue-600 hover:underline"
                    >
                      + اسم الصفحة
                    </button>
                    <button
                      type="button"
                      onClick={() => insertVariable('private', '{😀|❤️|💜}')}
                      className="text-blue-600 hover:underline"
                    >
                      + تنويع عشوائي
                    </button>
                  </div>
                </div>
                <textarea
                  rows={3}
                  value={privateReplyText}
                  onChange={(e) => setPrivateReplyText(e.target.value)}
                  placeholder={
                    replyType === 'ai'
                      ? 'اختياري: رسالة احتياطية تُستخدم فقط إذا لم يتوفر رد ذكي أو مخزن...'
                      : 'مرحباً {name}، شكراً لتعليقك! إليك تفاصيل المنتج...'
                  }
                  className="w-full rounded-lg border border-slate-300 px-3.5 py-2 text-sm text-slate-900 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/15"
                />
              </div>
            )}
          </div>

          <div className="flex items-center justify-end gap-3 border-t border-slate-200 pt-4">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              إلغاء
            </button>
            <button
              type="submit"
              disabled={saving}
              className="rounded-lg bg-blue-600 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
            >
              {saving ? 'جاري الحفظ...' : editingRule ? 'حفظ التعديلات' : 'حفظ وتفعيل القاعدة'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
