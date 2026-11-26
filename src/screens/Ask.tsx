import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Icon } from '../components/Icon';
import { Button } from '../components/ui';
import { ChatMarkdown } from '../components/ChatMarkdown';
import { api } from '../lib/api';
import {
  ask, decide, decideAll, newChat, stop, takeReturned, turns, useChat,
  type Part,
} from '../lib/chat';
import { spring } from '../lib/motion';
import type { AiPendingChange, AiStatus } from '../lib/types';

/** Somewhere to start, for a book you haven't asked anything yet. */
const STARTERS = [
  'How much did I spend last month, and on what?',
  'What are my biggest expenses so far this month?',
  'How has my spending changed over the last six months?',
  'What is my net worth, and where is it held?',
  'Which merchants do I pay every month?',
  'File everything from Swiggy and Zomato under Food delivery',
];

/**
 * Questions about the book, answered by Claude from the book itself. It
 * looks things up as it needs to — each lookup shows as a line that opens
 * onto the query behind it — and when asked to change something it says
 * what it would do and waits: nothing is written until it is applied here.
 */
export function Ask({ onOpenSettings }: { onOpenSettings: () => void }) {
  const chat = useChat();
  const [draft, setDraft] = useState('');
  const [status, setStatus] = useState<AiStatus | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.aiStatus().then(setStatus).catch(() => setStatus(null));
  }, []);

  // A question that didn't get an answer comes back to be asked again.
  useEffect(() => {
    if (chat.returned === null) return;
    const q = takeReturned();
    if (q) setDraft(q);
  }, [chat.returned]);

  // Grows with what is typed, up to a point.
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [draft]);

  const history = turns(chat.messages);
  const busy = chat.run !== null;
  const waiting = chat.pending.length > 0;
  const connected = status?.source != null;

  // Follows the answer down as it comes in, unless you've scrolled up to
  // read something earlier.
  const following = useRef(true);
  useEffect(() => {
    const pane = scrollParent(bottom.current);
    if (!pane) return;
    const onScroll = () => {
      following.current = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 120;
    };
    pane.addEventListener('scroll', onScroll, { passive: true });
    return () => pane.removeEventListener('scroll', onScroll);
  }, []);
  useEffect(() => {
    if (following.current) bottom.current?.scrollIntoView({ block: 'end' });
  }, [chat.live, chat.messages, chat.pending, chat.asking]);

  const submit = (text = draft) => {
    if (!text.trim() || busy || waiting) return;
    following.current = true;
    setDraft('');
    void ask(text);
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  const empty = history.length === 0 && !chat.asking;

  return (
    <div className="screen ask-screen">
      <header className="screen-head">
        <div>
          <h1>Ask</h1>
          <p>
            Questions about your money, answered from your book by Claude. It can make changes
            too, and asks you before each one.
          </p>
        </div>
        {!empty && (
          <Button icon="plus" tone="ghost" onClick={newChat}>
            New chat
          </Button>
        )}
      </header>

      {status && !connected && (
        <div className="ask-notice">
          <Icon name="alert-circle" size={16} />
          <span>Claude isn't connected yet. Sign in or add an API key first.</span>
          <Button tone="ghost" onClick={onOpenSettings}>
            Open Settings
          </Button>
        </div>
      )}

      <div className="ask-log">
        {empty && (
          <div className="ask-empty">
            <div className="ask-empty-mark">
              <Icon name="sparkles" size={22} />
            </div>
            <strong>Ask anything about your book</strong>
            <p>Spending, income, cards, debts, investments: Claude looks it up and shows its working.</p>
            <div className="ask-starters">
              {STARTERS.map((s) => (
                <button key={s} className="ask-starter" onClick={() => submit(s)} disabled={busy}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {history.map((turn, i) => (
          <div key={i} className="ask-turn">
            <Question text={turn.question} />
            <Answer parts={turn.answer} />
          </div>
        ))}

        {chat.asking && <Question text={chat.asking} />}
        {chat.live && <Answer parts={chat.live} live />}

        <AnimatePresence>
          {waiting && !busy && (
            <motion.div
              className="ask-pending"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={spring}
            >
              <div className="ask-pending-head">
                <Icon name="pencil" size={15} />
                {chat.pending.length === 1
                  ? 'Claude wants to make this change'
                  : `Claude wants to make ${chat.pending.length} changes`}
                {chat.pending.length > 1 && (
                  <span className="ask-pending-all">
                    <Button tone="ghost" onClick={() => decideAll(false)}>Decline all</Button>
                    <Button tone="primary" onClick={() => decideAll(true)}>Apply all</Button>
                  </span>
                )}
              </div>
              {chat.pending.map((p) => (
                <PendingCard key={p.id} change={p} decision={chat.decisions[p.id]} />
              ))}
            </motion.div>
          )}
        </AnimatePresence>

        {chat.error && (
          <div className="ask-error">
            <Icon name="alert-circle" size={16} />
            <span>{chat.error}</span>
          </div>
        )}
        <div ref={bottom} />
      </div>

      <div className="ask-composer">
        <textarea
          ref={input}
          rows={1}
          value={draft}
          placeholder={
            waiting
              ? 'Apply or decline the change above first'
              : 'Ask about your spending, or ask for a change…'
          }
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKey}
          disabled={waiting && !busy}
          autoFocus
        />
        {busy ? (
          <button className="ask-send is-stop" onClick={stop} aria-label="Stop" title="Stop">
            <Icon name="square" size={13} strokeWidth={3} />
          </button>
        ) : (
          <button
            className="ask-send"
            onClick={() => submit()}
            disabled={!draft.trim() || waiting}
            aria-label="Send"
            title="Send  ↵"
          >
            <Icon name="arrow-up" size={17} strokeWidth={2.4} />
          </button>
        )}
      </div>
    </div>
  );
}

function Question({ text }: { text: string }) {
  return (
    <div className="ask-q">
      <div className="ask-q-bubble">{text}</div>
    </div>
  );
}

function Answer({ parts, live = false }: { parts: Part[]; live?: boolean }) {
  const lastText = parts.length > 0 && parts[parts.length - 1].kind === 'text';
  return (
    <div className="ask-a">
      {parts.map((p, i) =>
        p.kind === 'text' ? (
          <ChatMarkdown key={i} text={p.text} />
        ) : p.kind === 'lookup' ? (
          <LookupLine key={i} part={p} />
        ) : (
          <div key={i} className={`ask-change is-${p.status}`}>
            <Icon name={p.status === 'applied' ? 'check' : p.status === 'declined' ? 'x' : 'alert-circle'} size={14} />
            <span>
              <strong>
                {p.status === 'applied' ? 'Applied' : p.status === 'declined' ? 'Declined' : 'Couldn’t apply'}
              </strong>{' '}
              {p.title}
              {p.error && <em> · {p.error}</em>}
            </span>
          </div>
        ),
      )}
      {live && !lastText && (
        <div className="ask-thinking">
          <span /><span /><span />
        </div>
      )}
    </div>
  );
}

function LookupLine({ part }: { part: Part & { kind: 'lookup' } }) {
  const [open, setOpen] = useState(false);
  const sql = (part.input as { sql?: string } | undefined)?.sql;
  const month = (part.input as { month?: string } | undefined)?.month;
  const label =
    part.tool === 'query_book'
      ? 'Looked in the book'
      : part.tool === 'list_accounts'
        ? 'Read account balances'
        : part.tool === 'book_summary'
          ? `Read the overview${month ? ` for ${month}` : ''}`
          : part.tool;
  const detail = !part.done
    ? 'looking…'
    : part.error
      ? 'failed'
      : part.rows !== undefined
        ? `${part.rows} ${part.rows === 1 ? 'row' : 'rows'}`
        : null;
  return (
    <div className={`ask-lookup ${part.error ? 'is-error' : ''}`}>
      <button className="ask-lookup-line" onClick={() => setOpen((o) => !o)} disabled={!sql && !part.error}>
        <Icon name={part.done ? 'search' : 'refresh-cw'} size={13} className={part.done ? '' : 'spin'} />
        <span>{label}</span>
        {detail && <span className="ask-lookup-detail">{detail}</span>}
        {(sql || part.error) && <Icon name={open ? 'chevron-down' : 'chevron-right'} size={13} />}
      </button>
      {open && (
        <div className="ask-lookup-body">
          {sql && <pre>{sql.trim()}</pre>}
          {part.error && <p>{part.error}</p>}
        </div>
      )}
    </div>
  );
}

function PendingCard({ change, decision }: { change: AiPendingChange; decision?: boolean }) {
  const destructive = change.tool === 'delete_transactions';
  return (
    <div className={`ask-pending-card ${decision !== undefined ? 'is-decided' : ''}`}>
      <div className="ask-pending-text">
        <strong>{change.title}</strong>
        {change.lines.filter(Boolean).length > 0 && (
          <ul>
            {change.lines.filter(Boolean).map((l, i) => <li key={i}>{l}</li>)}
          </ul>
        )}
      </div>
      <div className="ask-pending-actions">
        {decision === undefined ? (
          <>
            <Button tone="ghost" onClick={() => decide(change.id, false)}>Decline</Button>
            <Button tone={destructive ? 'danger' : 'primary'} onClick={() => decide(change.id, true)}>
              {destructive ? 'Delete' : 'Apply'}
            </Button>
          </>
        ) : (
          <span className="ask-pending-said">{decision ? 'Will apply' : 'Will decline'}</span>
        )}
      </div>
    </div>
  );
}

function scrollParent(el: HTMLElement | null): HTMLElement | null {
  let node = el?.parentElement ?? null;
  while (node) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY === 'auto' || overflowY === 'scroll') return node;
    node = node.parentElement;
  }
  return null;
}
