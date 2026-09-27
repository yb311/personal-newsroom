import { ArrowUp, CheckCheck, ChevronRight, Eye, EyeOff, Globe, History, MessageSquareText, Plus, ShieldCheck, ShieldOff, Square, Trash2, X, Zap } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ActionOutcome, AgentMode, AiStatus, AssistantAction, AssistantChat, AssistantChatSummary, AssistantEvent, AssistantMessage, AssistantPhase, AssistantSource, AssistantUnit, NavTarget, Screen } from '../types.ts';
import { AGENT_MODES } from '../types.ts';
import { ActionCard } from './ActionCard.tsx';
import { ago } from '../i18n.ts';
import { Cited } from './Cites.tsx';

const CHAT_KEY = 'pnr.assistantChat';
const WEB_KEY = 'pnr.assistantWeb';
const remember = (key: string, value: string | null): void => {
  try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch { /* optional */ }
};
const recall = (key: string): string | null => { try { return localStorage.getItem(key); } catch { return null; } };

/** A turn being answered. `question` is null when a turn resumes after its changes were confirmed. */
interface Pending { requestId: string; question: string | null; screenLabel: string | null; phase: AssistantPhase | null; tool: string | null; units: AssistantUnit[]; actions: AssistantAction[] }

const MODE_ICON: Record<AgentMode, typeof ShieldCheck> = { readonly: ShieldOff, ask: ShieldCheck, auto: Zap, full: Zap };

/** What the agent did or proposed in one turn: look-ups and page changes as one quiet line each, changes as cards. */
export interface ActionHandlers {
  busy: string | null;
  confirm: (a: AssistantAction, edits: Record<string, string>, dontAsk: boolean) => void;
  confirmAll: (actions: AssistantAction[], edits: Record<string, Record<string, string>>) => void;
  reject: (a: AssistantAction) => void; undo: (a: AssistantAction) => void; open: (target: NavTarget) => void;
}

/** One thing on the left; a list keeps its identity while its rows change. */
const screenKey = (s: Screen | null): string =>
  !s ? '' : s.focus.kind === 'articles' ? `articles:${s.focus.title}` : JSON.stringify(s.focus);

/**
 * 新闻助手: ask about any news, or about what is in the subscriptions. It is told
 * what is open on the left (`screen`) — an article, a watch, today's brief — so
 * 「这篇讲了什么」 needs no restating; the chip above the input shows it and
 * leaves it out for the next question when clicked. Answers cite numbered
 * sources the app gathered — the reader's library, news search and, when
 * switched on, the web.
 */
export function Assistant({ ai, screen, onOpenItem, onNavigate, onSetup, onClose }: {
  ai: AiStatus | null; screen: Screen | null; onOpenItem: (id: string) => void; onNavigate: (target: NavTarget) => void; onSetup: () => void; onClose: () => void;
}) {
  const { t } = useTranslation();
  const [chat, setChat] = useState<AssistantChat | null>(null);
  const [chats, setChats] = useState<AssistantChatSummary[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [draft, setDraft] = useState('');
  const [web, setWeb] = useState(() => recall(WEB_KEY) !== '0');
  const [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState('');
  /** The permission mode: how freely the assistant may change things (see agent.ts). */
  const [mode, setModeState] = useState<AgentMode>('ask');
  /** The action being confirmed, declined or undone. */
  const [busy, setBusy] = useState<string | null>(null);
  // A ref alongside the state: two clicks fired before React re-renders would
  // both see the same stale `busy` value and both start the action twice.
  const busyRef = useRef<string | null>(null);
  /** The screen the person left out; anything newly opened is included again. */
  const [leftOut, setLeftOut] = useState('');
  const attached = screen && screen.label && screenKey(screen) !== leftOut ? screen : null;
  const input = useRef<HTMLTextAreaElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const pendingRef = useRef<Pending | null>(null);
  const requestRef = useRef<string | null>(null);
  pendingRef.current = pending;
  // The panel unmounts when closed (App.tsx renders it only while open); a
  // confirm/reject/undo in flight at that point must not touch state afterwards.
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const loadChats = async (): Promise<void> => setChats(await window.pnr.assistantList());
  useEffect(() => {
    void window.pnr.assistantMode().then(setModeState);
    return window.pnr.onCommand?.((c) => { if (c === 'assistantMode') void window.pnr.assistantMode().then(setModeState); });
  }, []);
  useEffect(() => {
    void loadChats();
    const last = recall(CHAT_KEY);
    if (last) void window.pnr.assistantGet(last).then((c) => { if (c && !pendingRef.current) setChat(c); });
  }, []);

  useEffect(() => {
    const off = window.pnr.onAssistantEvent((event: AssistantEvent) => {
      if (event.requestId !== requestRef.current) return;
      if (event.type === 'action') {
        // A card appeared or changed mid-turn: its text lives in the database.
        void window.pnr.assistantGet(event.chatId).then((c) => {
          const actions = c?.messages.find((m) => m.id === event.messageId)?.actions ?? [];
          setPending((p) => (p && p.requestId === event.requestId ? { ...p, actions } : p));
        });
        return;
      }
      setPending((p) => {
        if (!p || p.requestId !== event.requestId) return p;
        if (event.type === 'phase' && event.phase) return { ...p, phase: event.phase, tool: event.tool ?? null };
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

  /** Asks a question — or, with `resume`, lets the last one continue after its changes were settled. */
  const ask = async (text: string, resume = false, chatId = chat?.id ?? null): Promise<void> => {
    const question = text.trim();
    if ((!question && !resume) || requestRef.current || !ai?.available) return;
    const requestId = crypto.randomUUID();
    requestRef.current = requestId;
    setPending({ requestId, question: resume ? null : question, screenLabel: resume ? null : attached?.label ?? null, phase: null, tool: null, units: [], actions: [] });
    setError(''); if (!resume) setDraft(''); setShowHistory(false);
    const restore = (): void => { if (!resume) setDraft((d) => d || question); };
    try {
      const result = await window.pnr.assistantAsk({ chatId, question, web, lang: ai.outputLang, requestId, screen: attached, ...(resume ? { resume } : {}) });
      if (requestRef.current !== requestId) return;
      if (result.chat) { setChat(result.chat); remember(CHAT_KEY, result.chat.id); }
      else { setError(describe(result.error)); restore(); }
    } catch {
      if (requestRef.current === requestId) { setError(describe(null)); restore(); }
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
  // ── the agent's changes ──────────────────────────────────────────────────
  const settle = async (a: AssistantAction, work: () => Promise<ActionOutcome>): Promise<ActionOutcome | null> => {
    if (busyRef.current || requestRef.current) return null;
    busyRef.current = a.id; setBusy(a.id); setError('');
    try {
      const outcome = await work();
      if (!mountedRef.current) return outcome;
      if (outcome.chat) setChat(outcome.chat);
      if (!outcome.ok && outcome.error) setError(t(`assistant.actionErrors.${outcome.error}`, { defaultValue: t('assistant.actionErrors.failed') }));
      return outcome;
    } catch { if (mountedRef.current) setError(t('assistant.actionErrors.failed')); return null; }
    finally { busyRef.current = null; if (mountedRef.current) setBusy(null); }
  };
  /** Once every proposal of a turn is settled, the turn carries on if the model had more to do. */
  const afterSettle = (outcome: ActionOutcome | null): void => {
    if (outcome?.resume && outcome.chat && mountedRef.current) void ask('', true, outcome.chat.id);
  };
  const handlers: ActionHandlers = {
    busy,
    confirm: (a, edits, dontAsk) => void settle(a, async () => {
      if (dontAsk && chat) await window.pnr.assistantAllow(chat.id, a.tool);
      return window.pnr.assistantConfirm(a.id, edits);
    }).then(afterSettle),
    confirmAll: (list, edits) => void (async () => {
      let last: ActionOutcome | null = null;
      for (const a of list) { last = await settle(a, () => window.pnr.assistantConfirm(a.id, edits[a.id] ?? {})); if (!last?.ok) return; }
      afterSettle(last);
    })(),
    reject: (a) => void settle(a, () => window.pnr.assistantReject(a.id)).then(afterSettle),
    undo: (a) => void settle(a, () => window.pnr.assistantUndo(a.id)),
    open: onNavigate
  };

  const changeMode = async (next: AgentMode): Promise<void> => {
    if (next === 'full' && mode !== 'full' && !await window.pnr.confirm({ message: t('assistant.fullWarn.message'), detail: t('assistant.fullWarn.detail'),
      confirm: t('assistant.fullWarn.confirm'), cancel: t('common.cancel') })) return;
    setModeState(await window.pnr.assistantSetMode(next));
  };
  const pickMode = async (): Promise<void> => {
    const choice = await window.pnr.contextMenu(AGENT_MODES.map((m) => ({ id: m, label: t(`assistant.mode.${m}`), checked: m === mode })));
    if (choice) void changeMode(choice as AgentMode);
  };
  const ModeIcon = MODE_ICON[mode];

  const toggleWeb = (): void => { setWeb((on) => { remember(WEB_KEY, on ? '0' : '1'); return !on; }); };
  const toggleScreen = (): void => setLeftOut((k) => (screen && k !== screenKey(screen) ? screenKey(screen) : ''));
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
      <ul className="assistant-examples">{(['example1', 'example2', 'example3'] as const).map((k) => (
        <li key={k}><button className="link" onClick={() => { setDraft(t(`assistant.${k}`)); input.current?.focus(); }}>{t(`assistant.${k}`)}</button></li>
      ))}</ul>
    </div>
  ) : (
    <div className="assistant-thread">
      {chat?.messages.map((m) => m.role === 'user'
        ? <Question key={m.id} text={m.content ?? ''} screenLabel={m.screenLabel} />
        : <Answer key={m.id} message={m} sources={sources} onSource={openSource} handlers={handlers}
            retry={m.status === 'failed' && m.id === last?.id ? questionBefore(m) : null} onRetry={(q) => void ask(q)} describe={describe} />)}
      {pending && <>
        {pending.question !== null && <Question text={pending.question} screenLabel={pending.screenLabel} />}
        <div className="answer">
          {pending.actions.length > 0 && <Actions actions={pending.actions} handlers={{ ...handlers, busy: pending.requestId }} />}
          {pending.units.length > 0 && <Units units={pending.units} sources={new Map()} onSource={openSource} />}
          <p className="working"><span className="spinner" aria-hidden />{pending.phase === 'tools' && pending.tool
            ? t('assistant.phase.tools', { tool: t(`assistant.tool.${pending.tool}`, { defaultValue: pending.tool }) })
            : t(`assistant.phase.${pending.phase ?? 'thinking'}`)}</p>
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
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void ask(draft); }
                // ⇧Tab cycles the permission mode, as in Claude Code.
                else if (e.key === 'Tab' && e.shiftKey) { e.preventDefault(); void changeMode(AGENT_MODES[(AGENT_MODES.indexOf(mode) + 1) % AGENT_MODES.length]!); }
              }} />
            <div className="composer-actions">
              <button className={`chip-toggle mode-chip ${mode}`} title={t(`assistant.modeHint.${mode}`)} aria-label={`${t('assistant.modeTitle')}: ${t(`assistant.mode.${mode}`)}`}
                onClick={() => void pickMode()}><ModeIcon size={13} />{t(`assistant.modeShort.${mode}`)}</button>
              <button className={`chip-toggle ${web ? 'on' : ''}`} aria-pressed={web} title={webTitle} onClick={toggleWeb}>
                <Globe size={13} />{t('assistant.web')}</button>
              {screen?.label && <button className={`chip-toggle screen-chip ${attached ? 'on' : ''}`} aria-pressed={Boolean(attached)}
                title={t(attached ? 'assistant.screenOn' : 'assistant.screenOff', { label: screen.label })} onClick={toggleScreen}>
                {attached ? <Eye size={13} /> : <EyeOff size={13} />}<span>{screen.label}</span></button>}
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

/** A question, with what was open on the left when it was asked. */
function Question({ text, screenLabel }: { text: string; screenLabel: string | null }) {
  const { t } = useTranslation();
  return <>
    <div className="bubble">{text}</div>
    {screenLabel && <p className="bubble-context" title={screenLabel}><Eye size={11} aria-hidden />{t('assistant.askedAbout', { label: screenLabel })}</p>}
  </>;
}

function Answer({ message, sources, onSource, handlers, retry, onRetry, describe }: {
  message: AssistantMessage; sources: Map<string, AssistantSource>; onSource: (s: AssistantSource) => void; handlers: ActionHandlers;
  retry: string | null; onRetry: (question: string) => void; describe: (code: string | null) => string;
}) {
  const { t } = useTranslation();
  const actions = message.actions.length > 0 ? <Actions actions={message.actions} handlers={handlers} /> : null;
  if (message.status === 'cancelled') return <div className="answer">{actions}<p className="answer-note">{t('assistant.stopped')}</p></div>;
  if (message.status !== 'complete' || !message.answer) {
    return <div className="answer">{actions}<p className="answer-note warn">{describe(message.error)}{retry && <button className="link" onClick={() => onRetry(retry)}>{t('common.retry')}</button>}</p></div>;
  }
  const units = message.answer.units;
  const cited = [...new Set(units.flatMap((u) => u.sourceRefIds))].map((r) => sources.get(r)).filter((s): s is AssistantSource => Boolean(s));
  return (
    <div className="answer">
      {actions}
      <Units units={units} sources={sources} onSource={onSource} />
      {units.some((u) => !u.supported && u.kind !== 'note') && <p className="answer-note">{t('assistant.unsourced')}</p>}
      {cited.length > 0 && <details className="answer-sources" open={cited.length <= 3}>
        <summary><ChevronRight size={11} strokeWidth={2.25} aria-hidden />{t('assistant.sources', { count: cited.length })}</summary>
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

function Actions({ actions, handlers }: { actions: AssistantAction[]; handlers: ActionHandlers }) {
  const { t } = useTranslation();
  const label = (a: AssistantAction): string => t(`assistant.tool.${a.tool}`, { defaultValue: a.tool });
  const quiet = (risk: 'read' | 'navigate'): string[] => [...new Set(actions.filter((a) => a.risk === risk && a.status === 'done').map(label))];
  const looked = quiet('read'); const opened = quiet('navigate');
  const cards = actions.filter((a) => a.risk !== 'read' && a.risk !== 'navigate');
  const open = cards.filter((a) => a.status === 'proposed' && !a.expired);
  // A deletion, or words that are not the person's own, is confirmed on its own card.
  const routine = open.filter((a) => a.risk !== 'danger' && !a.view?.fields.some((f) => f.warn));
  // Edits live here rather than in each card, so 全部确认 sends them too.
  const [edits, setEdits] = useState<Record<string, Record<string, string>>>({});
  const sep = t('assistant.listSeparator');
  return <>
    {looked.length > 0 && <p className="answer-note">{t('assistant.looked', { list: looked.join(sep) })}</p>}
    {opened.length > 0 && <p className="answer-note">{t('assistant.opened', { list: opened.join(sep) })}</p>}
    {routine.length > 1 && <div className="confirm-all"><button className="push" disabled={Boolean(handlers.busy)} onClick={() => handlers.confirmAll(routine, edits)}>
      <CheckCheck size={12} />{t('assistant.confirmAll', { count: routine.length })}</button></div>}
    {cards.map((a) => <ActionCard key={a.id} action={a} busy={Boolean(handlers.busy)}
      edits={edits[a.id] ?? {}} onEdit={(e) => setEdits((all) => ({ ...all, [a.id]: e }))}
      onConfirm={(dontAsk) => handlers.confirm(a, edits[a.id] ?? {}, dontAsk)} onReject={() => handlers.reject(a)}
      onUndo={() => handlers.undo(a)} onOpen={handlers.open} />)}
  </>;
}

function Units({ units, sources, onSource }: { units: AssistantUnit[]; sources: Map<string, AssistantSource>; onSource: (s: AssistantSource) => void }) {
  // Consecutive list items form one list; everything else is a paragraph.
  const blocks: { list: boolean; units: AssistantUnit[] }[] = [];
  for (const u of units) {
    const list = u.kind === 'listItem';
    const prev = blocks.at(-1);
    if (prev && prev.list && list) prev.units.push(u); else blocks.push({ list, units: [u] });
  }
  const refs = (u: AssistantUnit) => {
    const found = u.sourceRefIds.map((r) => sources.get(r)).filter((s): s is AssistantSource => Boolean(s));
    return found.length === 0 ? null : <span className="refs">{found.map((s) =>
      <button key={s.refId} className="ref" title={[s.publisher, s.title].filter(Boolean).join(' · ')} onClick={() => onSource(s)}>{s.refId.slice(1)}</button>)}</span>;
  };
  return <>{blocks.map((b, i) => b.units[0]!.kind === 'note' ? <p key={i} className="answer-agent-note">{b.units[0]!.text}</p> : b.list
    ? <ul key={i}>{b.units.map((u, j) => <li key={j}><Cited text={u.text}>{refs(u)}</Cited></li>)}</ul>
    : <p key={i}><Cited text={b.units[0]!.text}>{refs(b.units[0]!)}</Cited></p>)}</>;
}
