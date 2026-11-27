import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { motion } from 'motion/react';
import { Icon } from './Icon';
import { Answer, PendingCard } from './ChatParts';
import { createChat, isAutoKey, toggleAutoMode, turns, useAutoMode, type ChatSession } from '../lib/chat';
import { spring } from '../lib/motion';
import type { Transaction } from '../lib/types';

/**
 * A chat that lives for one errand: the ledger's picked transactions, a
 * question or a change about them, and its answer. Nothing of it is saved.
 * Once a change has been applied and Claude has nothing left to ask, it says
 * so and goes; closing it any earlier drops it all the same.
 */
export function QuickChat({
  ids, known, onClose, onDone,
}: {
  ids: string[];
  known: Transaction[];
  onClose: () => void;
  /** Called with what was changed, as the chat closes itself. */
  onDone: (what: string) => void;
}) {
  const session = useRef<ChatSession | null>(null);
  if (!session.current) {
    session.current = createChat(false);
    session.current.select(ids, known);
  }
  const chat = session.current;
  const state = chat.use();
  const auto = useAutoMode();
  const [draft, setDraft] = useState('');
  const input = useRef<HTMLTextAreaElement>(null);
  const log = useRef<HTMLDivElement>(null);

  useEffect(() => {
    input.current?.focus({ preventScroll: true });
    return () => chat.dispose();
  }, [chat]);

  // A question that didn't get an answer comes back to be asked again.
  useEffect(() => {
    if (state.returned === null) return;
    const q = chat.takeReturned();
    if (q) setDraft(q);
  }, [state.returned, chat]);

  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, [draft]);

  const history = turns(state.messages);
  const busy = state.run !== null;
  const waiting = state.pending.length > 0;

  useEffect(() => {
    const el = log.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state.live, state.messages, state.pending, state.asking]);

  // Done when the last exchange applied something and nothing more is asked.
  const last = history[history.length - 1];
  const applied = last?.answer.filter((p) => p.kind === 'change' && p.status === 'applied') ?? [];
  const finished = !busy && !waiting && !state.error && applied.length > 0;
  useEffect(() => {
    if (!finished) return;
    const what = applied.map((p) => (p.kind === 'change' ? p.title : '')).join(' · ');
    const t = window.setTimeout(() => onDone(what), 1400);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finished]);

  const submit = () => {
    if ((!draft.trim() && !state.selection) || busy || waiting) return;
    const q = draft;
    setDraft('');
    void chat.ask(q);
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (isAutoKey(e)) {
      e.preventDefault();
      toggleAutoMode();
    } else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
    }
  };

  const n = ids.length;
  const started = history.length > 0 || state.asking !== null;

  return (
    <motion.div
      className="quick-chat"
      initial={{ opacity: 0, y: 12, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 8, scale: 0.98 }}
      transition={spring}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="quick-chat-head">
        <span className="quick-chat-mark">
          <Icon name="sparkles" size={14} />
        </span>
        <span className="quick-chat-title">
          Quick ask · {n.toLocaleString('en-IN')} {n === 1 ? 'transaction' : 'transactions'}
          <small>Not saved: it goes when you close it.</small>
        </span>
        <button className="quick-chat-close" onClick={onClose} aria-label="Close" title="Close  esc">
          <Icon name="x" size={15} />
        </button>
      </div>

      {started && (
        <div className="quick-chat-log" ref={log}>
          {history.map((turn, i) => (
            <div key={i} className="ask-turn">
              {turn.question && (
                <div className="ask-q">
                  <div className="ask-q-bubble">{turn.question}</div>
                </div>
              )}
              <Answer parts={turn.answer} />
            </div>
          ))}
          {state.asking && (
            <div className="ask-q">
              <div className="ask-q-bubble">{state.asking}</div>
            </div>
          )}
          {state.live && <Answer parts={state.live} live />}
          {waiting && !busy && (
            <div className="quick-chat-pending">
              {state.pending.map((p, i) => (
                <PendingCard
                  key={p.id}
                  change={p}
                  decision={state.decisions[p.id]}
                  index={i}
                  count={state.pending.length}
                  onDecide={chat.decide}
                />
              ))}
            </div>
          )}
          {finished && (
            <div className="quick-chat-done">
              <Icon name="check" size={14} strokeWidth={2.6} />
              Done
            </div>
          )}
          {state.error && (
            <div className="ask-error">
              <Icon name="alert-circle" size={16} />
              <span>{state.error}</span>
            </div>
          )}
        </div>
      )}

      <div className="quick-chat-compose">
        <button
          className={`ask-auto ${auto ? 'is-on' : ''}`}
          onClick={toggleAutoMode}
          aria-pressed={auto}
          title={auto ? 'Auto mode is on: changes apply without asking  ⇧Tab' : 'Auto mode: apply changes without asking  ⇧Tab'}
        >
          <Icon name="zap" size={13} strokeWidth={2.4} />
          {auto && <span>Auto</span>}
        </button>
        <textarea
          ref={input}
          rows={1}
          value={draft}
          placeholder={
            waiting
              ? 'Apply or decline the change above first'
              : started
                ? 'Anything else?'
                : 'Change these, or ask about them… “file under Travel”, “split with Asha”'
          }
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKey}
          disabled={waiting && !busy}
        />
        {busy ? (
          <button className="ask-send is-stop" onClick={chat.stop} aria-label="Stop" title="Stop">
            <Icon name="square" size={12} strokeWidth={3} />
          </button>
        ) : (
          <button
            className="ask-send"
            onClick={submit}
            disabled={(!draft.trim() && !state.selection) || waiting}
            aria-label="Send"
            title="Send  ↵"
          >
            <Icon name="arrow-up" size={16} strokeWidth={2.4} />
          </button>
        )}
      </div>
    </motion.div>
  );
}
