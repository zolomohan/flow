import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { open as pickFiles } from '@tauri-apps/plugin-dialog';
import { Icon } from '../components/Icon';
import { Button, Confirm } from '../components/ui';
import { ChatMarkdown } from '../components/ChatMarkdown';
import { api, isDesktop } from '../lib/api';
import {
  ask, attach, decide, decideAll, deleteChat, detach, newChat, openChat, refreshChats, stop,
  takeReturned, turns, useChat,
  type Part,
} from '../lib/chat';
import { spring } from '../lib/motion';
import type { AiPendingChange, AiStatus } from '../lib/types';

/** What the statement reader can open. */
const STATEMENT_EXTENSIONS = ['pdf', 'csv', 'tsv', 'txt', 'xls', 'xlsx', 'xlsm', 'ods', 'png', 'jpg', 'jpeg', 'webp', 'gif'];
const isStatement = (path: string) =>
  STATEMENT_EXTENSIONS.includes(path.split('.').pop()?.toLowerCase() ?? '');
const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;

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
  const [dragging, setDragging] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.aiStatus().then(setStatus).catch(() => setStatus(null));
    void refreshChats();
  }, []);

  // Statements dropped anywhere on the window while Ask is open are
  // attached to the next question. The webview hands over real paths,
  // which is what the reader needs.
  useEffect(() => {
    if (!isDesktop) return;
    const off = getCurrentWebview().onDragDropEvent((e) => {
      const p = e.payload;
      if (p.type === 'enter' || p.type === 'over') setDragging(true);
      else if (p.type === 'leave') setDragging(false);
      else if (p.type === 'drop') {
        setDragging(false);
        const ok = p.paths.filter(isStatement);
        const not = p.paths.filter((x) => !isStatement(x));
        if (ok.length) attach(ok);
        setRefused(
          not.length
            ? `${not.map(fileName).join(', ')} ${not.length === 1 ? "isn't a statement" : "aren't statements"} Claude can read.`
            : null,
        );
        input.current?.focus({ preventScroll: true });
      }
    });
    return () => {
      void off.then((f) => f());
    };
  }, []);

  const browse = async () => {
    const picked = await pickFiles({
      title: 'Which statements should Claude read?',
      multiple: true,
      directory: false,
      filters: [{ name: 'Statements', extensions: STATEMENT_EXTENSIONS }],
    });
    if (!picked) return;
    attach(Array.isArray(picked) ? picked : [picked]);
    input.current?.focus({ preventScroll: true });
  };

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
    // Scrolls only the log's own pane: scrollIntoView would also nudge every
    // scrollable ancestor, the window and the sidebar included.
    const pane = scrollParent(bottom.current);
    if (following.current && pane) pane.scrollTop = pane.scrollHeight;
  }, [chat.live, chat.messages, chat.pending, chat.asking]);

  const submit = (text = draft) => {
    if ((!text.trim() && chat.files.length === 0) || busy || waiting) return;
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
    <div className="ask-layout">
    <aside className="ask-chats">
      <Button icon="plus" tone="secondary" onClick={newChat} disabled={busy} block>
        New chat
      </Button>
      <div className="ask-chats-list">
        {chat.chats.length === 0 && <p className="ask-chats-none">Your chats will be kept here.</p>}
        {chat.chats.map((c) => (
          <div key={c.id} className={`ask-chat-item ${c.id === chat.chatId ? 'is-active' : ''}`}>
            <button className="ask-chat-open" onClick={() => void openChat(c.id)} disabled={busy} title={c.title}>
              <span className="ask-chat-title">{c.title}</span>
              <span className="ask-chat-when">{when(c.updatedAt)}</span>
            </button>
            <button
              className="ask-chat-delete"
              onClick={() => setDeleting(c.id)}
              disabled={busy && c.id === chat.chatId}
              aria-label="Delete chat"
              title="Delete chat"
            >
              <Icon name="trash-2" size={14} />
            </button>
          </div>
        ))}
      </div>
    </aside>
    <Confirm
      open={deleting !== null}
      title="Delete this chat?"
      onCancel={() => setDeleting(null)}
      onConfirm={async () => {
        const id = deleting;
        setDeleting(null);
        if (id) await deleteChat(id);
      }}
    >
      The conversation goes for good. Anything it changed in your book stays as it is.
    </Confirm>
    <div className="screen ask-screen">
      <header className="screen-head">
        <div>
          <h1>Ask</h1>
          <p>
            Questions about your money, answered from your book by Claude. Drop a statement here
            to import it. Claude asks you before every change.
          </p>
        </div>
      </header>

      <AnimatePresence>
        {dragging && (
          <motion.div
            className="ask-drop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <div>
              <Icon name="file-text" size={26} />
              <strong>Drop statements to attach them</strong>
              <span>PDF, CSV, Excel or a picture of one</span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

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
            <p>
              Spending, income, cards, debts, investments: Claude looks it up and shows its working.
              Drop a statement anywhere on this screen to have it imported.
            </p>
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
            <Question text={turn.question} files={turn.files} />
            <Answer parts={turn.answer} />
          </div>
        ))}

        {chat.asking && <Question text={chat.asking} files={chat.askingFiles} />}
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
        {(chat.files.length > 0 || refused) && (
          <div className="ask-attached">
            {chat.files.map((f) => (
              <span key={f} className="ask-file" title={f}>
                <Icon name="file-text" size={13} />
                {fileName(f)}
                <button onClick={() => detach(f)} aria-label={`Remove ${fileName(f)}`}>
                  <Icon name="x" size={12} strokeWidth={2.4} />
                </button>
              </span>
            ))}
            {refused && <span className="ask-refused">{refused}</span>}
          </div>
        )}
        <div className="ask-compose-row">
        <button
          className="ask-clip"
          onClick={browse}
          disabled={busy || waiting}
          aria-label="Attach a statement"
          title="Attach a statement"
        >
          <Icon name="paperclip" size={17} />
        </button>
        <textarea
          ref={input}
          rows={1}
          value={draft}
          placeholder={
            waiting
              ? 'Apply or decline the change above first'
              : chat.files.length > 0
                ? 'Which account is it for? Or just send to import it'
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
            disabled={(!draft.trim() && chat.files.length === 0) || waiting}
            aria-label="Send"
            title="Send  ↵"
          >
            <Icon name="arrow-up" size={17} strokeWidth={2.4} />
          </button>
        )}
        </div>
      </div>
    </div>
    </div>
  );
}

function Question({ text, files = [] }: { text: string; files?: string[] }) {
  return (
    <div className="ask-q">
      {files.length > 0 && (
        <div className="ask-q-files">
          {files.map((f) => (
            <span key={f} className="ask-file" title={f}>
              <Icon name="file-text" size={13} />
              {fileName(f)}
            </span>
          ))}
        </div>
      )}
      {text && <div className="ask-q-bubble">{text}</div>}
    </div>
  );
}

/** When a chat was last touched, the way the list wants it: a time today,
 *  a day this week, a date otherwise. */
function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const days = Math.floor((now.getTime() - d.getTime()) / 86_400_000);
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: 'short' });
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
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
  const path = (part.input as { path?: string } | undefined)?.path;
  const label =
    part.tool === 'read_statement'
      ? `Read ${path ? fileName(path) : 'the statement'}`
      : part.tool === 'query_book'
      ? 'Looked in the book'
      : part.tool === 'list_accounts'
        ? 'Read account balances'
        : part.tool === 'book_summary'
          ? `Read the overview${month ? ` for ${month}` : ''}`
          : part.tool;
  const detail = !part.done
    ? part.tool === 'read_statement'
      ? part.found
        ? `${part.found} found so far…`
        : 'reading…'
      : 'looking…'
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
