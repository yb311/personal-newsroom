import { ArrowUp, Globe, History, MessageSquareText, Plus, Square, Trash2, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AiStatus, AssistantChat, AssistantChatSummary, AssistantEvent, AssistantMessage, AssistantPhase, AssistantSource, AssistantUnit } from '../types.ts';
import { ago } from '../i18n.ts';

const CHAT_KEY = 'pnr.assistantChat';
const WEB_KEY = 'pnr.assistantWeb';
const SUGGESTIONS = ['today', 'library', 'explain'] as const;
const remember = (key: string, value: string | null): void => {
  try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch { /* optional */ }
};
const recall = (key: string): string | null => { try { return localStorage.getItem(key); } catch { return null; } };

interface Pending { requestId: string; question: string; phase: AssistantPhase | null; units: AssistantUnit[] }

/**
 * 新闻助手: ask about any news, or about what is in the subscriptions. Not tied
 * to the article on screen. Answers cite numbered sources the app gathered —
 * the reader's library, news search and, when switched on, the web.
 */
export function Assistant({ ai, onOpenItem, onSetup, onClose }: {
  ai: AiStatus | null; onOpenItem: (id: string) => void; onSetup: () => void; onClose: () => void;
}) {
  const { t } = useTranslation();
  const [chat, setChat] = useState<AssistantChat | null>(null);
  const [chats, setChats] = useState<AssistantChatSummary[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [draft, setDraft] = useState('');
  const [web, setWeb] = useState(() => recall(WEB_KEY) !== '0');
  const [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState('');
  const input = useRef<HTMLTextAreaElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const pendingRef = useRef<Pending | null>(null);
  const requestRef = useRef<string | null>(null);
  pendingRef.current = pending;

  const loadChats = async (): Promise<void> => setChats(await window.pnr.assistantList());
  useEffect(() => {
    void loadChats();
    const last = recall(CHAT_KEY);
    if (last) void window.pnr.assistantGet(last).then((c) => { if (c && !pendingRef.current) setChat(c); });
  }, []);

  useEffect(() => {
    const off = window.pnr.onAssistantEvent((event: AssistantEvent) => {
      if (event.requestId !== requestRef.current) return;
      setPending((p) => {
        if (!p || p.requestId !== event.requestId) return p;
        if (event.type === 'phase' && event.phase) return { ...p, phase: event.phase };
        if (event.type === 'partial') {
          // Structured streams expose fields while their objects are still
          // incomplete. Never hand those partial shapes directly to Units,
          // which quite reasonably expects sourceRefIds to be an array.
          const raw = Array.isArray(event.value?.units) ? event.value.units : [];
          const units = raw.flatMap((unit) => {
            const text = typeof unit?.text === 'string' ? unit.text : '';
            if (!text) return [];
            return [{ kind: unit.kind === 'listItem' ? 'listItem' as const : 'paragraph' as const, text,
              sourceRefIds: Array.isArray(unit.sourceRefIds) ? unit.sourceRefIds.filter((id): id is string => typeof id === 'string') : [],
              supported: unit.supported === true }];
          });
          return { ...p, units };
        }
        return p;
      });
    });
    return () => {
      off();
      const id = requestRef.current;
      requestRef.current = null;
      if (id) void window.pnr.assistantCancel(id);
    };
  }, []);

  // Keep the newest turn in view while it is written.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && !showHistory) el.scrollTop = el.scrollHeight;
  }, [chat, pending, showHistory]);

  // The composer grows with its text, up to a few lines.
  useLayoutEffect(() => {
    const el = input.current; if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [draft]);

  const open = (c: AssistantChat | null): void => {
    if (requestRef.current) return;
    setChat(c); setError(''); setShowHistory(false); remember(CHAT_KEY, c?.id ?? null);
    requestAnimationFrame(() => input.current?.focus());
  };
  const describe = (code: string | null | undefined): string =>
    t(`assistant.errors.${code ?? 'failed'}`, { defaultValue: t('assistant.errors.failed') });

  const ask = async (text: string): Promise<void> => {
    const question = text.trim();
    if (!question || pending || !ai?.available) return;
    const requestId = crypto.randomUUID();
    requestRef.current = requestId;
    setPending({ requestId, question, phase: null, units: [] }); setError(''); setDraft(''); setShowHistory(false);
    try {
      const result = await window.pnr.assistantAsk({ chatId: chat?.id ?? null, question, web, lang: ai.outputLang, requestId });
      if (requestRef.current !== requestId) return;
      if (result.chat) { setChat(result.chat); remember(CHAT_KEY, result.chat.id); }
      else { setError(describe(result.error)); setDraft((d) => d || question); }
    } catch {
      if (requestRef.current === requestId) { setError(describe(null)); setDraft((d) => d || question); }
    } finally {
      if (requestRef.current === requestId) {
        requestRef.current = null; setPending(null); void loadChats(); requestAnimationFrame(() => input.current?.focus());
      }
    }
  };
  const stop = (): void => { if (pending) void window.pnr.assistantCancel(pending.requestId); };
  const close = (): void => {
    const id = requestRef.current;
    requestRef.current = null;
    if (id) void window.pnr.assistantCancel(id);
    onClose();
  };
  const toggleWeb = (): void => { setWeb((on) => { remember(WEB_KEY, on ? '0' : '1'); return !on; }); };
  const remove = async (id: string): Promise<void> => {
    if (requestRef.current) return;
    await window.pnr.assistantDelete(id);
    if (chat?.id === id) open(null);
    await loadChats();
  };

  const sources = useMemo(() => new Map((chat?.sources ?? []).map((s) => [s.refId, s])), [chat]);
  const openSource = (s: AssistantSource): void => {
    if (s.kind === 'library' && s.itemId) onOpenItem(s.itemId); else void window.pnr.openExternal(s.url);
  };
  // The question that led to a failed answer, so it can be asked again.
  const questionBefore = (m: AssistantMessage): string | null =>
    chat?.messages.findLast((x) => x.role === 'user' && x.sequence < m.sequence)?.content ?? null;
  const last = chat?.messages.at(-1);

  const webTitle = !web ? t('assistant.webOff') : ai?.webSearch ? t('assistant.webOn') : t('assistant.webNewsOnly');
  const body = !ai ? null : !ai.available ? (
    <div className="empty-state">
      <MessageSquareText size={26} strokeWidth={1.6} />
      <h3>{t('assistant.title')}</h3>
      <p>{t('assistant.needAi')}</p>
      <button className="primary" onClick={onSetup}>{t('common.connectAi')}</button>
    </div>
  ) : showHistory ? (
    <div className="assistant-history">
      {chats.length === 0 && <p className="section-hint pad">{t('assistant.noHistory')}</p>}
      <ul>{chats.map((c) => (
        <li key={c.id} className={c.id === chat?.id ? 'selected' : ''}>
          <button className="history-open" onClick={() => void window.pnr.assistantGet(c.id).then(open)}>
            <strong>{c.title}</strong><small>{ago(c.updatedAt)}</small></button>
          <button className="tool" title={t('assistant.deleteChat')} aria-label={t('assistant.deleteChat')} onClick={() => void remove(c.id)}><Trash2 size={13} /></button>
        </li>
      ))}</ul>
    </div>
  ) : !chat && !pending ? (
    <div className="assistant-welcome">
      <h3>{t('assistant.welcomeTitle')}</h3>
      <p>{t('assistant.welcomeBody')}</p>
      <div className="suggestions">
        {SUGGESTIONS.map((k) => <button key={k} className="push" onClick={() => void ask(t(`assistant.suggest.${k}`))}>{t(`assistant.suggest.${k}`)}</button>)}
      </div>
    </div>
  ) : (
    <div className="assistant-thread">
      {chat?.messages.map((m) => m.role === 'user'
        ? <div key={m.id} className="bubble">{m.content}</div>
        : <Answer key={m.id} message={m} sources={sources} onSource={openSource}
            retry={m.status === 'failed' && m.id === last?.id ? questionBefore(m) : null} onRetry={(q) => void ask(q)} describe={describe} />)}
      {pending && <>
        <div className="bubble">{pending.question}</div>
        <div className="answer">
          {pending.units.length > 0 && <Units units={pending.units} sources={new Map()} onSource={openSource} />}
          <p className="working"><span className="spinner" aria-hidden />{t(`assistant.phase.${pending.phase ?? 'library'}`)}</p>
        </div>
      </>}
    </div>
  );

  return (
    <aside className="assistant" aria-label={t('assistant.title')}>
      <header className="assistant-bar">
        <strong>{showHistory ? t('assistant.history') : t('assistant.title')}</strong>
        <span className="grow" />
        {ai?.available && <>
          <button className="tool" aria-pressed={showHistory} title={t('assistant.history')} aria-label={t('assistant.history')} disabled={Boolean(pending)} onClick={() => setShowHistory((v) => !v)}><History size={15} /></button>
          <button className="tool" title={t('assistant.newChat')} aria-label={t('assistant.newChat')} disabled={Boolean(pending) || (!chat && !showHistory)} onClick={() => open(null)}><Plus size={16} /></button>
        </>}
        <button className="tool" title={t('common.close')} aria-label={t('common.close')} onClick={close}><X size={16} /></button>
      </header>
      <div className="assistant-scroll" ref={scroller}>{body}</div>
      {ai?.available && !showHistory && (
        <footer className="composer">
          {error && <p role="alert" className="error-text">{error}</p>}
          <div className="composer-box">
            <textarea ref={input} rows={1} value={draft} placeholder={t('assistant.placeholder')} aria-label={t('assistant.placeholder')}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void ask(draft); } }} />
            <div className="composer-actions">
              <button className={`chip-toggle ${web ? 'on' : ''}`} aria-pressed={web} title={webTitle} onClick={toggleWeb}>
                <Globe size={13} />{t('assistant.web')}</button>
              <span className="grow" />
              {pending
                ? <button className="send" title={t('assistant.stop')} aria-label={t('assistant.stop')} onClick={stop}><Square size={12} fill="currentColor" /></button>
                : <button className="send" title={t('assistant.send')} aria-label={t('assistant.send')} disabled={!draft.trim()} onClick={() => void ask(draft)}><ArrowUp size={15} /></button>}
            </div>
          </div>
          <p className="composer-hint">{t('assistant.disclaimer')}</p>
        </footer>
      )}
    </aside>
  );
}

function Answer({ message, sources, onSource, retry, onRetry, describe }: {
  message: AssistantMessage; sources: Map<string, AssistantSource>; onSource: (s: AssistantSource) => void;
  retry: string | null; onRetry: (question: string) => void; describe: (code: string | null) => string;
}) {
  const { t } = useTranslation();
  if (message.status === 'cancelled') return <p className="answer-note">{t('assistant.stopped')}</p>;
  if (message.status !== 'complete' || !message.answer) {
    return <p className="answer-note warn">{describe(message.error)}{retry && <button className="link" onClick={() => onRetry(retry)}>{t('common.retry')}</button>}</p>;
  }
  const units = message.answer.units;
  const cited = [...new Set(units.flatMap((u) => u.sourceRefIds))].map((r) => sources.get(r)).filter((s): s is AssistantSource => Boolean(s));
  return (
    <div className="answer">
      <Units units={units} sources={sources} onSource={onSource} />
      {units.some((u) => !u.supported) && <p className="answer-note">{t('assistant.unsourced')}</p>}
      {cited.length > 0 && <details className="answer-sources" open={cited.length <= 3}>
        <summary>{t('assistant.sources', { count: cited.length })}</summary>
        <ol>{cited.map((s) => (
          <li key={s.refId}><button onClick={() => onSource(s)} title={s.url}>
            <span className="ref">{s.refId.slice(1)}</span>
            <span className="source-title">{s.title}</span>
            <small>{[t(`assistant.kind.${s.kind}`), s.publisher, s.publishedAt ? ago(s.publishedAt) : null].filter(Boolean).join(' · ')}</small>
          </button></li>
        ))}</ol>
      </details>}
    </div>
  );
}

function Units({ units, sources, onSource }: { units: AssistantUnit[]; sources: Map<string, AssistantSource>; onSource: (s: AssistantSource) => void }) {
  // Consecutive list items form one list; everything else is a paragraph.
  const blocks: { list: boolean; units: AssistantUnit[] }[] = [];
  for (const u of units) {
    const list = u.kind === 'listItem';
    const prev = blocks.at(-1);
    if (prev && prev.list && list) prev.units.push(u); else blocks.push({ list, units: [u] });
  }
  const refs = (u: AssistantUnit) => u.sourceRefIds.map((r) => sources.get(r)).filter((s): s is AssistantSource => Boolean(s))
    .map((s) => <button key={s.refId} className="ref" title={s.title} onClick={() => onSource(s)}>{s.refId.slice(1)}</button>);
  return <>{blocks.map((b, i) => b.list
    ? <ul key={i}>{b.units.map((u, j) => <li key={j}>{u.text}{refs(u)}</li>)}</ul>
    : <p key={i}>{b.units[0]!.text}{refs(b.units[0]!)}</p>)}</>;
}
