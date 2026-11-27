import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { open as pickFiles } from '@tauri-apps/plugin-dialog';
import { Icon } from '../components/Icon';
import { Button, Confirm } from '../components/ui';
import { Answer, PendingCard } from '../components/ChatParts';
import { api, isDesktop } from '../lib/api';
import {
  ask, attach, decide, decideAll, deleteChat, detach, dropSelection, isAutoKey, newChat, openChat,
  refreshChats, renameChat, saveChat, stop, takeReturned, toggleAutoMode, turns, useAutoMode, useChat,
} from '../lib/chat';
import { spring } from '../lib/motion';
import type { AiStatus } from '../lib/types';

/** What Claude can read: statements, and order histories or other exports
 *  that tell it more about what's already in the book. */
const STATEMENT_EXTENSIONS = [
  'pdf', 'csv', 'tsv', 'txt', 'xls', 'xlsx', 'xlsm', 'ods', 'png', 'jpg', 'jpeg', 'webp', 'gif',
  'json', 'jsonl', 'ndjson', 'html', 'htm', 'xml', 'md',
];
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
  const auto = useAutoMode();
  const [draft, setDraft] = useState('');
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [dragging, setDragging] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const listRoot = useRef<HTMLDivElement>(null);

  // The chat list closes on a click elsewhere or Escape, like any menu.
  useEffect(() => {
    if (!listOpen) return;
    void refreshChats();
    const onDown = (e: MouseEvent) => {
      if (listRoot.current?.contains(e.target as Node)) return;
      setListOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && setListOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [listOpen]);
  const input = useRef<HTMLTextAreaElement>(null);
  const bottom = useRef<HTMLDivElement>(null);

  // ⇧Tab turns auto mode on and off; ⌘S keeps the open chat.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (isAutoKey(e)) {
        e.preventDefault();
        toggleAutoMode();
      } else if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void saveChat();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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
            ? `${not.map(fileName).join(', ')} ${not.length === 1 ? "isn't a file" : "aren't files"} Claude can read.`
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
      title: 'Which files should Claude read?',
      multiple: true,
      directory: false,
      filters: [{ name: 'Statements and exports', extensions: STATEMENT_EXTENSIONS }],
    });
    if (!picked) return;
    attach(Array.isArray(picked) ? picked : [picked]);
    input.current?.focus({ preventScroll: true });
  };

  // Transactions brought over from the ledger wait for the question about them.
  useEffect(() => {
    if (chat.selection) input.current?.focus({ preventScroll: true });
  }, [chat.selection]);

  const saveRename = async () => {
    const r = renaming;
    setRenaming(null);
    if (!r) return;
    const was = chat.chats.find((c) => c.id === r.id)?.title;
    if (!r.title.trim() || r.title.trim() === was) return;
    try {
      await renameChat(r.id, r.title);
    } catch {
      void refreshChats();
    }
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
    if ((!text.trim() && chat.files.length === 0 && !chat.selection) || busy || waiting) return;
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
      <header className="screen-head ask-head">
        <div className="ask-title" ref={listRoot}>
          <button
            className="ask-title-button"
            onClick={() => setListOpen((o) => !o)}
            aria-expanded={listOpen}
            title="Your chats"
          >
            <h1>{chat.chatId ? chat.title || 'Untitled chat' : 'New chat'}</h1>
            <Icon name="chevron-down" size={18} />
          </button>
          {chat.chatId && !chat.saved && <span className="ask-unsaved">Not saved</span>}
          <AnimatePresence>
            {listOpen && (
              <motion.div
                className="ask-chats"
                initial={{ opacity: 0, y: -6, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -4, scale: 0.98 }}
                transition={{ duration: 0.14 }}
              >
                <div className="ask-chats-label">Your chats</div>
                <div className="ask-chats-list">
                  {chat.chats.length === 0 && <p className="ask-chats-none">Chats you save are kept here.</p>}
                  {chat.chats.map((c) => (
                    <div key={c.id} className={`ask-chat-item ${c.id === chat.chatId ? 'is-active' : ''}`}>
                      {renaming?.id === c.id ? (
                        <input
                          className="ask-chat-rename"
                          value={renaming.title}
                          maxLength={120}
                          autoFocus
                          onFocus={(e) => e.currentTarget.select()}
                          onChange={(e) => setRenaming({ id: c.id, title: e.target.value })}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') void saveRename();
                            else if (e.key === 'Escape') { e.stopPropagation(); setRenaming(null); }
                          }}
                          onBlur={() => void saveRename()}
                          aria-label="Chat name"
                        />
                      ) : (
                        <button
                          className="ask-chat-open"
                          onClick={() => {
                            setListOpen(false);
                            void openChat(c.id);
                          }}
                          disabled={busy}
                          title={c.title}
                        >
                          <span className="ask-chat-title">{c.title}</span>
                          <span className="ask-chat-when">{when(c.updatedAt)}</span>
                        </button>
                      )}
                      <button
                        className="ask-chat-delete is-rename"
                        onClick={() => setRenaming({ id: c.id, title: c.title })}
                        aria-label="Rename chat"
                        title="Rename chat"
                      >
                        <Icon name="pencil" size={14} />
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
              </motion.div>
            )}
          </AnimatePresence>
        </div>
        <div className="head-actions">
          {chat.chatId && !chat.saved && (
            <Button
              tone="ghost"
              icon="bookmark"
              onClick={() => void saveChat()}
              disabled={busy || chat.messages.length === 0}
              title="Keep this chat in your list  ⌘S"
            >
              Save
            </Button>
          )}
          {chat.chatId && chat.saved && (
            <Button
              tone="ghost"
              icon="pencil"
              onClick={() => {
                setListOpen(true);
                setRenaming({ id: chat.chatId!, title: chat.title });
              }}
              disabled={busy}
            >
              Rename
            </Button>
          )}
          {chat.chatId && (
            <Button icon="plus" onClick={() => { setListOpen(false); newChat(); }} title="New chat  ⌘⇧O">
              New chat
            </Button>
          )}
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
              <strong>Drop files to attach them</strong>
              <span>Statements (PDF, CSV, Excel, a picture) or order exports (JSON, CSV)</span>
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
              Drop a statement here to import it, or an order export (Swiggy, Amazon) to fill in descriptions and notes.
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
            <Question text={turn.question} files={turn.files} selected={turn.selected} />
            <Answer parts={turn.answer} />
          </div>
        ))}

        {chat.asking && (
          <Question text={chat.asking} files={chat.askingFiles} selected={chat.askingSelection?.count ?? 0} />
        )}
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
                <span>
                  {chat.pending.length === 1
                    ? 'Claude wants to make this change'
                    : `Claude wants to make ${chat.pending.length} changes`}
                  <small>Nothing is written until you apply it. ⇧Tab turns on auto mode, which applies changes as they come.</small>
                </span>
                {chat.pending.length > 1 && (
                  <span className="ask-pending-all">
                    <Button tone="ghost" onClick={() => decideAll(false)}>Decline all</Button>
                    <Button tone="primary" onClick={() => decideAll(true)}>Apply all</Button>
                  </span>
                )}
              </div>
              {chat.pending.map((p, i) => (
                <PendingCard
                  key={p.id}
                  change={p}
                  decision={chat.decisions[p.id]}
                  index={i}
                  count={chat.pending.length}
                  onDecide={decide}
                />
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
        {(chat.files.length > 0 || refused || chat.selection) && (
          <div className="ask-attached">
            {chat.selection && (
              <span className="ask-file is-selection">
                <Icon name="receipt" size={13} />
                {transactionsLabel(chat.selection.count)} from the ledger
                <button onClick={dropSelection} aria-label="Remove the transactions">
                  <Icon name="x" size={12} strokeWidth={2.4} />
                </button>
              </span>
            )}
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
          className={`ask-auto ${auto ? 'is-on' : ''}`}
          onClick={toggleAutoMode}
          aria-pressed={auto}
          title={auto ? 'Auto mode is on: changes apply without asking  ⇧Tab' : 'Auto mode: apply changes without asking  ⇧Tab'}
        >
          <Icon name="zap" size={14} strokeWidth={2.4} />
          {auto && <span>Auto</span>}
        </button>
        <button
          className="ask-clip"
          onClick={browse}
          disabled={busy || waiting}
          aria-label="Attach a file"
          title="Attach a statement or export"
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
              : auto
                ? 'Auto mode: changes apply as Claude makes them…'
              : chat.files.length > 0
                ? 'Which account is it for? Or just send to import it'
                : chat.selection
                  ? 'What would you like to know, or change, about these?'
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
            disabled={(!draft.trim() && chat.files.length === 0 && !chat.selection) || waiting}
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

const transactionsLabel = (n: number) =>
  `${n.toLocaleString('en-IN')} ${n === 1 ? 'transaction' : 'transactions'}`;

function Question({ text, files = [], selected = 0 }: { text: string; files?: string[]; selected?: number }) {
  return (
    <div className="ask-q">
      {(files.length > 0 || selected > 0) && (
        <div className="ask-q-files">
          {selected > 0 && (
            <span className="ask-file is-selection">
              <Icon name="receipt" size={13} />
              {transactionsLabel(selected)}
            </span>
          )}
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

function scrollParent(el: HTMLElement | null): HTMLElement | null {
  let node = el?.parentElement ?? null;
  while (node) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY === 'auto' || overflowY === 'scroll') return node;
    node = node.parentElement;
  }
  return null;
}
