import { useSyncExternalStore } from 'react';
import { listen } from '@tauri-apps/api/event';
import { api, isDesktop } from './api';
import type {
  AiChatProgress, AiChatReply, AiPendingChange, AiReadProgress, ChatSummary,
} from './types';

/**
 * The conversation on the Ask screen. It lives here rather than in the
 * screen, so walking off to look at a transaction and coming back finds it
 * where it was — and an answer still on its way keeps arriving meanwhile.
 *
 * `messages` is the Claude API's own transcript, thinking and tool calls
 * included. It goes back to Rust whole with every question, unchanged, and
 * the screen reads what it shows out of it. Nothing of it is written to
 * disk: closing the app ends the conversation.
 *
 * When Claude asks to change the book, the reply comes back with the
 * changes `pending` and the transcript ending on Claude's turn. Each one is
 * applied or declined here, and once all of them have an answer the
 * conversation is sent back with those answers to carry on.
 *
 * Every conversation is saved to the book after each reply, pending changes
 * and all, so it can be opened again from the list beside it.
 */

/** How attached statements are written into a question: this line, then
 *  one `- /path` line per file. Rust reads the same marker. */
export const ATTACHED = 'Attached statement files:';

/** The tools that change the book, as against the ones that read it. */
const WRITE_TOOLS = new Set([
  'add_transaction',
  'edit_transaction',
  'update_transactions',
  'delete_transactions',
  'add_category',
  'label_transactions',
  'import_statement',
]);

export const isWriteTool = (tool: string) => WRITE_TOOLS.has(tool);

/** One lookup Claude made while answering. */
export interface Lookup {
  tool: string;
  input?: unknown;
  rows?: number;
  error?: string;
  done: boolean;
  /** Transactions found so far, while a statement is being read. */
  found?: number;
}

/** A change Claude made, or was told not to. */
export interface Change {
  tool: string;
  title: string;
  status: 'applied' | 'declined' | 'failed';
  error?: string;
}

/** What an answer is made of, in the order it was written. */
export type Part =
  | { kind: 'text'; text: string }
  | ({ kind: 'lookup' } & Lookup)
  | ({ kind: 'change' } & Change);

/** One exchange as the screen draws it. */
export interface Turn {
  question: string;
  /** Statements attached to the question, by path. */
  files: string[];
  answer: Part[];
}

interface State {
  /** The conversation open now; null until its first question. */
  chatId: string | null;
  title: string;
  /** Every saved conversation, latest first. */
  chats: ChatSummary[];
  /** Statements waiting in the composer for the next question. */
  files: string[];
  messages: unknown[];
  /** The answer streaming in, while one is. */
  live: Part[] | null;
  run: string | null;
  /** The question being answered, until it is, and what came with it. */
  asking: string | null;
  askingFiles: string[];
  /** Changes waiting on the user, and what they have said so far. */
  pending: AiPendingChange[];
  decisions: Record<string, boolean>;
  error: string | null;
  /** A question handed back to the composer after a failed or stopped run. */
  returned: string | null;
}

let state: State = {
  chatId: null,
  title: '',
  chats: [],
  files: [],
  askingFiles: [],
  messages: [],
  live: null,
  run: null,
  asking: null,
  pending: [],
  decisions: {},
  error: null,
  returned: null,
};
const subscribers = new Set<() => void>();
/** What each change was called on its card, so a declined one, which has no
 *  result of its own to name it, still reads as what it was. */
const titles = new Map<string, string>();

function set(next: Partial<State>) {
  state = { ...state, ...next };
  subscribers.forEach((f) => f());
}

type LookupPart = Part & { kind: 'lookup' };

let listening = false;
function startListening() {
  if (listening || !isDesktop) return;
  listening = true;
  startReadListening();
  void listen<AiChatProgress>('ai-chat-progress', (e) => {
    const p = e.payload;
    if (p.run !== state.run || state.live === null) return;
    const live = [...state.live];
    const last = live[live.length - 1];
    if (p.kind === 'text' && p.text) {
      if (last?.kind === 'text') live[live.length - 1] = { ...last, text: last.text + p.text };
      else live.push({ kind: 'text', text: p.text });
    } else if (p.kind === 'tool' && p.tool) {
      // A change shows once it has been answered, not while it is asked for.
      if (isWriteTool(p.tool)) return;
      // Announced twice: once as it starts, and again with its input.
      const open = findLast(live, (x) => x.kind === 'lookup' && !x.done && x.tool === p.tool && x.input === undefined);
      if (p.input !== undefined && open !== -1) {
        live[open] = { ...(live[open] as LookupPart), input: p.input };
      } else {
        live.push({ kind: 'lookup', tool: p.tool, input: p.input, done: false });
      }
    } else if (p.kind === 'tool_done' && p.tool) {
      if (isWriteTool(p.tool)) return;
      const i = live.findIndex((x) => x.kind === 'lookup' && !x.done && x.tool === p.tool);
      if (i !== -1) live[i] = { ...(live[i] as LookupPart), done: true, rows: p.rows, error: p.error };
    } else {
      return;
    }
    set({ live });
  });
}

function startReadListening() {
  void listen<AiReadProgress>('ai-read-progress', (e) => {
    const p = e.payload;
    if (p.run !== state.run || state.live === null) return;
    const i = findLast(state.live, (x) => x.kind === 'lookup' && !x.done && x.tool === 'read_statement');
    if (i === -1) return;
    const live = [...state.live];
    live[i] = { ...(live[i] as LookupPart), found: p.found };
    set({ live });
  });
}

function findLast<T>(list: T[], test: (x: T) => boolean): number {
  for (let i = list.length - 1; i >= 0; i--) if (test(list[i])) return i;
  return -1;
}

/** Sends `messages` and takes what comes back. On failure the transcript
 *  goes back to `fallback`, and `returned` to the composer. */
async function send(
  messages: unknown[],
  fallback: unknown[],
  asking: string | null,
  decisions?: Record<string, boolean>,
) {
  const run = crypto.randomUUID();
  set({ run, live: [], asking, error: null, returned: null, pending: [], decisions: {} });
  let reply: AiChatReply;
  try {
    reply = await api.aiChat(run, messages, decisions);
  } catch (err) {
    if (state.run !== run) return;
    const message = err instanceof Error ? err.message : String(err);
    set({
      messages: fallback,
      live: null,
      run: null,
      asking: null,
      askingFiles: [],
      // What was attached goes back with the question.
      files: asking !== null ? state.askingFiles : state.files,
      error: message === 'Stopped.' ? null : message,
      returned: asking,
    });
    return;
  }
  if (state.run !== run) return;
  for (const p of reply.pending) titles.set(p.id, p.title);
  set({
    messages: reply.messages,
    live: null,
    run: null,
    asking: null,
    askingFiles: [],
    pending: reply.pending,
    decisions: {},
  });
  await persist();
}

/** Saves the open conversation, and refreshes the list it appears in. */
async function persist() {
  if (!state.chatId || state.messages.length === 0) return;
  try {
    await api.chatSave(state.chatId, state.title, state.messages, state.pending);
    await refreshChats();
  } catch (err) {
    set({ error: `The chat couldn't be saved: ${err instanceof Error ? err.message : String(err)}` });
  }
}

export async function refreshChats() {
  try {
    set({ chats: await api.chatList() });
  } catch {
    /* the list stays as it was */
  }
}

/** Opens a saved conversation where it was left. */
export async function openChat(id: string) {
  if (state.run || id === state.chatId) return;
  try {
    const chat = await api.chatLoad(id);
    for (const p of chat.pending) titles.set(p.id, p.title);
    set({
      chatId: chat.id,
      title: chat.title,
      messages: chat.messages,
      pending: chat.pending,
      decisions: {},
      live: null,
      asking: null,
      askingFiles: [],
      error: null,
      returned: null,
    });
  } catch (err) {
    set({ error: err instanceof Error ? err.message : String(err) });
    void refreshChats();
  }
}

export async function deleteChat(id: string) {
  await api.chatDelete(id);
  if (id === state.chatId) newChat();
  await refreshChats();
}

export function attach(paths: string[]) {
  const have = new Set(state.files);
  const added = paths.filter((p) => !have.has(p));
  if (added.length) set({ files: [...state.files, ...added] });
}

export function detach(path: string) {
  set({ files: state.files.filter((f) => f !== path) });
}

export async function ask(question: string) {
  const files = state.files;
  const q = question.trim() || (files.length > 0 ? 'Import this statement.' : '');
  if (!q || state.run || state.pending.length > 0) return;
  const before = state.messages;
  const content =
    files.length === 0
      ? q
      : [
          { type: 'text', text: q },
          { type: 'text', text: `${ATTACHED}\n${files.map((f) => `- ${f}`).join('\n')}` },
        ];
  if (!state.chatId) {
    set({ chatId: crypto.randomUUID(), title: q.replace(/\s+/g, ' ').slice(0, 80) });
  }
  set({ files: [], askingFiles: files });
  // The question goes back in the composer if this fails: nothing about it
  // reached the transcript, so asking again is asking it fresh.
  await send([...before, { role: 'user', content }], before, q);
}

/** Records the answer to one waiting change; the last answer sends them. */
export function decide(id: string, applied: boolean) {
  if (state.run || !state.pending.some((p) => p.id === id)) return;
  const decisions = { ...state.decisions, [id]: applied };
  set({ decisions });
  if (state.pending.every((p) => p.id in decisions)) void resume(decisions);
}

/** Answers every waiting change the same way at once. */
export function decideAll(applied: boolean) {
  if (state.run || state.pending.length === 0) return;
  const decisions = Object.fromEntries(state.pending.map((p) => [p.id, applied]));
  void resume(decisions);
}

async function resume(decisions: Record<string, boolean>) {
  const pending = state.pending;
  const messages = state.messages;
  await send(messages, messages, null, decisions);
  // A failed resume leaves the changes waiting, so they can be answered again.
  if (state.error && state.messages === messages && state.pending.length === 0) {
    set({ pending, decisions: {} });
  }
  // A stop or failure still leaves the transcript where it was; keep the
  // saved copy in step with what is on screen.
  if (state.messages === messages) await persist();
}

export function stop() {
  if (state.run) void api.aiChatStop(state.run).catch(() => {});
}

export function newChat() {
  if (state.run) stop();
  set({
    chatId: null,
    title: '',
    files: [],
    askingFiles: [],
    messages: [],
    live: null,
    run: null,
    asking: null,
    pending: [],
    decisions: {},
    error: null,
    returned: null,
  });
}

export function takeReturned(): string | null {
  const q = state.returned;
  if (q !== null) set({ returned: null });
  return q;
}

export function useChat() {
  startListening();
  return useSyncExternalStore(
    (f) => {
      subscribers.add(f);
      return () => subscribers.delete(f);
    },
    () => state,
  );
}

// ------------------------------------------------------------ reading it

type Block = { type: string; [k: string]: unknown };
type Message = { role: string; content: string | Block[] };
type Result = { rows?: number; error?: string; done?: string; declined?: boolean };

/** The transcript as exchanges: each question, and the text, lookups and
 *  changes of everything Claude did to answer it. Thinking stays out of
 *  sight, and so do changes still waiting on an answer. */
export function turns(messages: unknown[]): Turn[] {
  const out: Turn[] = [];
  // Results arrive in the message after the call; matched by id.
  const results = new Map<string, Result>();
  for (const m of messages as Message[]) {
    if (m.role !== 'user' || typeof m.content === 'string') continue;
    for (const b of m.content) {
      if (b.type !== 'tool_result') continue;
      const id = String(b.tool_use_id);
      const content = String(b.content);
      if (b.is_error) {
        results.set(id, { error: content });
      } else if (content.startsWith('Declined by the user')) {
        results.set(id, { declined: true });
      } else {
        try {
          const v = JSON.parse(content);
          results.set(id, {
            rows:
              typeof v?.row_count === 'number'
                ? v.row_count
                : typeof v?.rows_found === 'number'
                  ? v.rows_found
                  : Array.isArray(v)
                    ? v.length
                    : undefined,
            done: typeof v?.done === 'string' ? v.done : undefined,
          });
        } catch {
          results.set(id, {});
        }
      }
    }
  }

  for (const m of messages as Message[]) {
    if (m.role === 'user') {
      const texts =
        typeof m.content === 'string'
          ? [m.content]
          : m.content.filter((b) => b.type === 'text').map((b) => String(b.text));
      const files = texts
        .filter((t) => t.startsWith(ATTACHED))
        .flatMap((t) => t.split('\n').slice(1))
        .map((l) => l.replace(/^\s*-\s*/, '').trim())
        .filter(Boolean);
      const text = texts.filter((t) => !t.startsWith(ATTACHED)).join('\n');
      if (text || files.length) out.push({ question: text, files, answer: [] });
      continue;
    }
    const turn = out[out.length - 1];
    if (!turn || typeof m.content === 'string') continue;
    for (const b of m.content) {
      if (b.type === 'text' && b.text) {
        turn.answer.push({ kind: 'text', text: String(b.text) });
      } else if (b.type === 'tool_use') {
        const tool = String(b.name);
        const r = results.get(String(b.id));
        if (isWriteTool(tool)) {
          if (!r) continue;
          turn.answer.push({
            kind: 'change',
            tool,
            title: r.done ?? titles.get(String(b.id)) ?? changeName(tool),
            status: r.declined ? 'declined' : r.error ? 'failed' : 'applied',
            error: r.error,
          });
        } else {
          turn.answer.push({ kind: 'lookup', tool, input: b.input, done: true, rows: r?.rows, error: r?.error });
        }
      }
    }
  }
  return out;
}

function changeName(tool: string): string {
  switch (tool) {
    case 'add_transaction': return 'Add a transaction';
    case 'edit_transaction': return 'Edit a transaction';
    case 'update_transactions': return 'Change transactions';
    case 'delete_transactions': return 'Delete transactions';
    case 'add_category': return 'Add a category';
    case 'label_transactions': return 'Label transactions';
    case 'import_statement': return 'Import a statement';
    default: return tool;
  }
}
