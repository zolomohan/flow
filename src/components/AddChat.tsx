/**
 * What the phone's + opens: a chat with Claude for the errand at hand —
 * "450 on lunch at Toit", "how much on cabs this month" — rather than a form.
 *
 * It comes up as a panel over the bottom half, with the tab bar put away and
 * a Manual button for the times a form is quicker. Dragged up by its head it
 * takes the whole screen; dragged down
 * it goes back to half, and from half, away. Nothing of it is saved.
 */

import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { animate, motion, useMotionValue, useTransform } from 'motion/react';
import { Icon } from './Icon';
import { Answer, PendingCard } from './ChatParts';
import { createChat, isAutoKey, toggleAutoMode, turns, useAutoMode, type ChatSession } from '../lib/chat';

const SETTLE = { type: 'spring', stiffness: 380, damping: 38, mass: 0.8 } as const;

/** The half-open panel's height, as a share of the screen. */
const COMPACT = 0.52;

export function AddChat({
  onClose, onManual,
}: {
  onClose: () => void;
  /** The form instead: the panel closes and the manual sheet opens. */
  onManual: () => void;
}) {
  const session = useRef<ChatSession | null>(null);
  if (!session.current) session.current = createChat(false);
  const chat = session.current;
  const state = chat.use();
  const auto = useAutoMode();
  const [draft, setDraft] = useState('');
  const input = useRef<HTMLTextAreaElement>(null);
  const log = useRef<HTMLDivElement>(null);

  /* `p` is how far toward the whole screen the panel is: 0 half, 1 full. The
     CSS reads it for the height, the corners and how far above the tab bar it
     sits, so a drag is one value moving. `drop` is how far below half it has
     been pulled on its way out. */
  const p = useMotionValue(0);
  const drop = useMotionValue(window.innerHeight * COMPACT + 40);
  const [full, setFull] = useState(false);
  const shade = useTransform(drop, [0, window.innerHeight * COMPACT], [1, 0]);

  useEffect(() => {
    // In from below, the way it goes out.
    animate(drop, 0, SETTLE);
    return () => chat.dispose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat]);

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
  const started = history.length > 0 || state.asking !== null;

  useEffect(() => {
    const el = log.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state.live, state.messages, state.pending, state.asking]);

  const settle = (to: 'compact' | 'full' | 'close') => {
    if (to === 'close') {
      animate(drop, window.innerHeight * COMPACT + 40, { ...SETTLE, onComplete: onClose });
      return;
    }
    setFull(to === 'full');
    animate(p, to === 'full' ? 1 : 0, SETTLE);
    animate(drop, 0, SETTLE);
  };

  // Dragged by the head: the log scrolls on its own and keeps its touches.
  const drag = useRef<{ id: number; y: number; from: number; lastY: number; lastT: number; v: number } | null>(null);
  const range = () => window.innerHeight * (1 - COMPACT);
  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('button')) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { id: e.pointerId, y: e.clientY, from: p.get() * range() - drop.get(), lastY: e.clientY, lastT: e.timeStamp, v: 0 };
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const dt = e.timeStamp - d.lastT;
    if (dt > 0) d.v = ((e.clientY - d.lastY) / dt) * 1000;
    d.lastY = e.clientY;
    d.lastT = e.timeStamp;
    const raised = d.from - (e.clientY - d.y);
    if (raised >= 0) {
      p.set(Math.min(1, raised / range()));
      drop.set(0);
    } else {
      p.set(0);
      drop.set(-raised);
    }
  };
  const onUp = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    const moved = Math.abs(e.clientY - d.y);
    if (moved < 4) return;
    if (drop.get() > 90 || (d.v > 700 && p.get() < 0.05)) settle('close');
    else if (d.v < -500) settle('full');
    else if (d.v > 500) settle('compact');
    else settle(p.get() > 0.5 ? 'full' : 'compact');
  };

  const submit = () => {
    if (!draft.trim() || busy || waiting) return;
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
      settle('close');
    }
  };

  return (
    <>
      <motion.div
        className="add-chat-shade"
        style={{ opacity: shade }}
        onClick={() => settle('close')}
      />
      <motion.section
        className={`add-chat ${full ? 'is-full' : ''}`}
        role="dialog"
        aria-label="Quick chat"
        style={{ '--p': p, y: drop } as never}
      >
        <div
          className="add-chat-head"
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          onDoubleClick={() => settle(full ? 'compact' : 'full')}
        >
          <span className="add-chat-grip" aria-hidden />
          <div className="add-chat-bar">
            <span className="add-chat-mark">
              <Icon name="sparkles" size={14} />
            </span>
            <span className="add-chat-title">
              {full ? 'Chat' : 'Log it or ask'}
              <small>Not saved once you close it</small>
            </span>
            {!full && (
              <button type="button" className="add-chat-manual" onClick={onManual}>
                <Icon name="pencil" size={13} />
                Manual
              </button>
            )}
            <button
              type="button"
              className="add-chat-close"
              onClick={() => (full ? settle('compact') : settle('close'))}
              aria-label={full ? 'Shrink' : 'Close'}
            >
              <Icon name={full ? 'chevron-down' : 'x'} size={16} />
            </button>
          </div>
        </div>

        <div className="add-chat-log" ref={log}>
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
              {state.pending.map((pc, i) => (
                <PendingCard
                  key={pc.id}
                  change={pc}
                  decision={state.decisions[pc.id]}
                  index={i}
                  count={state.pending.length}
                  onDecide={chat.decide}
                />
              ))}
            </div>
          )}
          {state.error && (
            <div className="ask-error">
              <Icon name="alert-circle" size={16} />
              <span>{state.error}</span>
            </div>
          )}
        </div>

        <div className="add-chat-compose">
          <button
            type="button"
            className={`ask-auto ${auto ? 'is-on' : ''}`}
            onClick={toggleAutoMode}
            aria-pressed={auto}
            title={auto ? 'Auto mode is on: changes apply without asking' : 'Auto mode: apply changes without asking'}
          >
            <Icon name="zap" size={13} strokeWidth={2.4} />
            {auto && <span>Auto</span>}
          </button>
          <textarea
            ref={input}
            rows={1}
            value={draft}
            placeholder={waiting ? 'Apply or decline the change above first' : started ? 'Anything else?' : 'Log a spend, or ask anything'}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKey}
            disabled={waiting && !busy}
          />
          {busy ? (
            <button type="button" className="ask-send is-stop" onClick={chat.stop} aria-label="Stop">
              <Icon name="square" size={12} strokeWidth={3} />
            </button>
          ) : (
            <button
              type="button"
              className="ask-send"
              onClick={submit}
              disabled={!draft.trim() || waiting}
              aria-label="Send"
            >
              <Icon name="arrow-up" size={16} strokeWidth={2.4} />
            </button>
          )}
        </div>
      </motion.section>
    </>
  );
}
