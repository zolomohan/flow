import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { listen } from '@tauri-apps/api/event';
import { Icon } from './Icon';
import { TransactionSheet } from './TransactionSheet';
import { DateField } from './DateField';
import {
  Button, Chip, Empty, Field, Segmented, Select, Sheet, Switch, TextInput,
  type SegmentOption, type SelectOption,
} from './ui';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { pendingTransaction } from '../lib/pending';
import { money, shortDayLabel } from '../lib/format';
import type {
  AiReadProgress, AiRow, AiStatus, ImportPreviewRow, ImportResult, TransactionInput,
} from '../lib/types';

/**
 * Bringing statements in with Claude: a few steps rather than a
 * conversation.
 *
 * 1. **Range** — the account the statements belong to, and the dates wanted.
 * 2. **Statements** — PDFs, CSVs, spreadsheets or screenshots, as many as
 *    the range needs.
 * 3. **Reading** — Claude lists every transaction and suggests a
 *    description, a category and a note for each.
 * 4. **Review** — a table to correct, accept or skip each row. Rows already
 *    in the book are set aside by the same matching the spreadsheet
 *    importer uses, and a counterparty whose filing you confirmed before is
 *    filed the way you confirmed it, whatever Claude thought.
 * 5. **Done** — the accepted rows are records.
 *
 * Nothing touches the book before the last step.
 */

type Step = 'range' | 'files' | 'reading' | 'review' | 'done';
type Preset = 'this' | 'last' | 'three' | 'custom';
type Show = 'all' | 'look';

interface Picked {
  path: string;
  name: string;
}

interface ReviewRow {
  ai: AiRow;
  preview: ImportPreviewRow;
  input: TransactionInput;
  include: boolean;
  /** Changed by hand here. */
  edited: boolean;
  /** Whose filing this is: a rule you confirmed before, or Claude's guess. */
  source: 'remembered' | 'claude';
}

const PRESETS: SegmentOption<Preset>[] = [
  { value: 'this', label: 'This month' },
  { value: 'last', label: 'Last month' },
  { value: 'three', label: 'Last 3 months' },
  { value: 'custom', label: 'Custom' },
];

const STEPS: { step: Step; label: string }[] = [
  { step: 'range', label: 'Range' },
  { step: 'files', label: 'Statements' },
  { step: 'reading', label: 'Reading' },
  { step: 'review', label: 'Review' },
];

const EXTENSIONS = ['pdf', 'csv', 'tsv', 'txt', 'xls', 'xlsx', 'png', 'jpg', 'jpeg', 'webp'];

const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function presetRange(preset: Preset): { from: string; to: string } {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  switch (preset) {
    case 'last':
      return { from: iso(new Date(y, m - 1, 1)), to: iso(new Date(y, m, 0)) };
    case 'three':
      return { from: iso(new Date(y, m - 2, 1)), to: iso(now) };
    default:
      return { from: iso(new Date(y, m, 1)), to: iso(now) };
  }
}

/** A row Claude wasn't sure of, that nobody has touched since. These are
 *  the ones worth a look, and the ones that arrive wearing Triage. */
const needsLook = (r: ReviewRow) =>
  !r.edited &&
  r.source === 'claude' &&
  (r.ai.confidence === 'low' || (r.input.kind !== 'transfer' && !r.input.categoryId));

export function AiImportSheet({ open: isOpen, onClose }: { open: boolean; onClose: () => void }) {
  const { accounts, categories, commitStatementImport, toast } = useStore();
  const [step, setStep] = useState<Step>('range');
  const [accountId, setAccountId] = useState<string | null>(null);
  const [preset, setPreset] = useState<Preset>('last');
  const [from, setFrom] = useState(() => presetRange('last').from);
  const [to, setTo] = useState(() => presetRange('last').to);
  const [files, setFiles] = useState<Picked[]>([]);
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [progress, setProgress] = useState<Record<number, AiReadProgress>>({});
  const [readError, setReadError] = useState<string | null>(null);
  const [rows, setRows] = useState<ReviewRow[]>([]);
  const [matched, setMatched] = useState<ImportPreviewRow[]>([]);
  const [show, setShow] = useState<Show>('all');
  const [showMatched, setShowMatched] = useState(false);
  const [alreadyCounted, setAlreadyCounted] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const [committing, setCommitting] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  // The read in flight. A read whose run is no longer this one was
  // cancelled — its answer and its progress are both ignored.
  const run = useRef<string | null>(null);

  const banks = useMemo(() => accounts.filter((a) => !a.archived && !a.system), [accounts]);
  const account = accounts.find((a) => a.id === accountId);

  const checkStatus = async () => {
    setChecking(true);
    try {
      setStatus(await api.aiStatus());
    } catch {
      setStatus(null);
    } finally {
      setChecking(false);
    }
  };

  useEffect(() => {
    if (isOpen) void checkStatus();
  }, [isOpen]);

  useEffect(() => {
    const off = listen<AiReadProgress>('ai-read-progress', (e) => {
      if (e.payload.run !== run.current) return;
      setProgress((was) => ({ ...was, [e.payload.fileIndex]: e.payload }));
    });
    return () => {
      void off.then((f) => f());
    };
  }, []);

  const startOver = () => {
    run.current = null;
    setStep('range');
    setFiles([]);
    setProgress({});
    setReadError(null);
    setRows([]);
    setMatched([]);
    setShow('all');
    setShowMatched(false);
    setAlreadyCounted(false);
    setEditing(null);
    setResult(null);
  };

  const close = () => {
    // Escape lands on every open sheet at once; while the editor is up, the
    // review underneath stays put.
    if (editing !== null) return;
    startOver();
    onClose();
  };

  const choosePreset = (p: Preset) => {
    setPreset(p);
    if (p !== 'custom') {
      const r = presetRange(p);
      setFrom(r.from);
      setTo(r.to);
    }
  };

  const addFiles = async () => {
    const picked = await open({
      title: 'Which statements should Claude read?',
      multiple: true,
      directory: false,
      filters: [{ name: 'Statements', extensions: EXTENSIONS }],
    });
    if (!picked) return;
    const paths = Array.isArray(picked) ? picked : [picked];
    setFiles((was) => {
      const have = new Set(was.map((f) => f.path));
      const added = paths
        .filter((p) => !have.has(p))
        .map((p) => ({ path: p, name: p.split(/[\\/]/).pop() ?? p }));
      return [...was, ...added];
    });
  };

  /** The posting a row becomes if nothing is changed. */
  const inputOf = (
    ai: AiRow,
    kind: string,
    categoryId: string | null,
    transferAccountId: string | null,
    merchant: string,
  ): TransactionInput => {
    const debit = ai.row.direction === 'debit';
    const base = {
      id: null,
      amount: ai.row.amount,
      categoryId: null as string | null,
      merchant,
      note: ai.note || null,
      occurredAt: `${ai.row.date}T12:00`,
    };
    if (kind === 'transfer' && transferAccountId) {
      return {
        ...base,
        kind: 'transfer',
        accountId: debit ? accountId! : transferAccountId,
        toAccountId: debit ? transferAccountId : accountId!,
      };
    }
    return {
      ...base,
      kind: debit ? 'expense' : 'income',
      accountId: accountId!,
      toAccountId: null,
      categoryId,
    };
  };

  const read = async () => {
    if (!accountId || files.length === 0) return;
    const id = crypto.randomUUID();
    run.current = id;
    setProgress({});
    setReadError(null);
    setStep('reading');
    try {
      const found = await api.aiReadStatements(
        id, files.map((f) => f.path), accountId, from, to,
      );
      if (run.current !== id) return;
      // Two statements that overlap list the same line twice; keep one.
      const seen = new Set<string>();
      const unique = found.filter((r) => {
        const key = `${r.row.date}|${r.row.amount}|${r.row.direction}|${r.row.narration}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      const preview = await api.previewStatementImport(accountId, unique.map((r) => r.row));
      if (run.current !== id) return;

      const review: ReviewRow[] = [];
      const inBook: ImportPreviewRow[] = [];
      unique.forEach((ai, i) => {
        const p = preview[i];
        if (p.status === 'matched') {
          inBook.push(p);
          return;
        }
        const remembered = p.fromRule && p.ruleConfirmed;
        review.push({
          ai,
          preview: p,
          input: remembered
            ? inputOf(ai, p.kind, p.categoryId, p.transferAccountId, p.merchant)
            : inputOf(ai, ai.kind, ai.categoryId, ai.transferAccountId, ai.description),
          include: true,
          edited: false,
          source: remembered ? 'remembered' : 'claude',
        });
      });
      // Newest first, the way the ledger reads.
      review.sort((a, b) => b.ai.row.date.localeCompare(a.ai.row.date));
      setRows(review);
      setMatched(inBook);
      setStep('review');
    } catch (err) {
      if (run.current !== id) return;
      setReadError(err instanceof Error ? err.message : String(err));
    }
  };

  const cancelRead = () => {
    run.current = null;
    setStep('files');
  };

  const update = (i: number, patch: Partial<TransactionInput>) =>
    setRows((was) =>
      was.map((r, j) => (j === i ? { ...r, input: { ...r.input, ...patch }, edited: true } : r)),
    );

  /** A category picked for one row goes to the same counterparty's other
   *  untouched rows too, so a month of one café is one decision. */
  const setCategory = (i: number, categoryId: string | null) => {
    const r = rows[i];
    const key = r.preview.matchKey;
    const siblings = new Set(
      rows
        .map((o, j) => [o, j] as const)
        .filter(
          ([o, j]) =>
            j !== i &&
            !!key &&
            !o.edited &&
            o.preview.matchKey === key &&
            o.ai.row.direction === r.ai.row.direction &&
            o.input.kind === r.input.kind,
        )
        .map(([, j]) => j),
    );
    setRows((was) =>
      was.map((o, j) =>
        j === i || siblings.has(j)
          ? { ...o, input: { ...o.input, categoryId }, edited: true }
          : o,
      ),
    );
    if (siblings.size > 0) {
      toast(
        `Also filed ${siblings.size} more ${
          siblings.size === 1 ? 'entry' : 'entries'
        } of this counterparty the same way`,
      );
    }
  };

  const toggle = (i: number) =>
    setRows((was) => was.map((r, j) => (j === i ? { ...r, include: !r.include } : r)));

  const setAll = (include: boolean) =>
    setRows((was) => was.map((r) => ({ ...r, include })));

  /** The transaction sheet handed back a posting for one row. */
  const acceptEdit = (i: number, raw: TransactionInput) => {
    const input: TransactionInput = {
      ...raw,
      id: null,
      splits: raw.splits?.map((s) => ({ ...s, id: null })),
      shares: raw.shares?.map((s) => ({ ...s, id: null })),
    };
    setRows((was) => was.map((r, j) => (j === i ? { ...r, input, edited: true, include: true } : r)));
  };

  const taking = rows.filter((r) => r.include);
  const lookCount = rows.filter(needsLook).length;
  const shown = rows
    .map((r, i) => [r, i] as const)
    .filter(([r]) => show === 'all' || needsLook(r));

  const commit = async () => {
    if (!accountId || taking.length === 0) return;
    setCommitting(true);
    try {
      const done = await commitStatementImport(
        accountId,
        taking.map((r) => {
          // Accepting a row here is reviewing it, so it skips triage and
          // teaches its counterparty's rule — except a guess Claude wasn't
          // sure of and nobody touched, which waits in Triage for a look.
          const unsure = needsLook(r);
          return {
            row: r.ai.row,
            input: r.input,
            triage: unsure,
            learn: !unsure,
            affectsBalance: !alreadyCounted,
          };
        }),
      );
      setResult(done);
      setStep('done');
    } catch {
      /* the store has already said what went wrong */
    } finally {
      setCommitting(false);
    }
  };

  const categoryOptions = (kind: string): SelectOption[] =>
    categories
      .filter((c) => c.kind === kind)
      .map((c) => ({
        value: c.id,
        label: c.name,
        icon: c.icon,
        color: c.color,
        hint: c.parentId ? categories.find((p) => p.id === c.parentId)?.name : undefined,
      }));

  const accountName = (id: string | null) => accounts.find((a) => a.id === id)?.name ?? '?';

  const transferLabel = (input: TransactionInput) =>
    input.accountId === accountId
      ? `Transfer → ${accountName(input.toAccountId)}`
      : `Transfer ← ${accountName(input.accountId)}`;

  // ------------------------------------------------------------- render

  const subtitle: Record<Step, string> = {
    range: 'Which account, and which dates',
    files: `${account?.name ?? ''} · ${shortDayLabel(from)} – ${shortDayLabel(to)}`,
    reading: `Claude is reading ${files.length === 1 ? 'the statement' : `${files.length} statements`}`,
    review: `${account?.name ?? ''} · ${shortDayLabel(from)} – ${shortDayLabel(to)}`,
    done: 'Finished',
  };

  const back: Partial<Record<Step, () => void>> = {
    files: () => setStep('range'),
    review: () => setStep('files'),
  };

  const footer = (() => {
    switch (step) {
      case 'range':
        return (
          <div className="ai-foot">
            <span />
            <Button
              tone="primary"
              trailingIcon="arrow-right"
              onClick={() => setStep('files')}
              disabled={!accountId || !from || !to || from > to}
            >
              Next
            </Button>
          </div>
        );
      case 'files':
        return (
          <div className="ai-foot">
            <Button tone="ghost" icon="chevron-left" onClick={() => setStep('range')}>
              Back
            </Button>
            <Button
              tone="primary"
              icon="sparkles"
              onClick={read}
              disabled={files.length === 0 || !status?.source}
            >
              {`Read ${files.length > 1 ? `${files.length} statements` : 'statement'} with Claude`}
            </Button>
          </div>
        );
      case 'reading':
        return (
          <div className="ai-foot">
            <Button tone="ghost" onClick={cancelRead}>
              {readError ? 'Back' : 'Cancel'}
            </Button>
            {readError && (
              <Button tone="primary" icon="refresh-cw" onClick={read}>
                Try again
              </Button>
            )}
          </div>
        );
      case 'review':
        return (
          <div className="ai-foot">
            <Button tone="ghost" icon="chevron-left" onClick={() => setStep('files')} disabled={committing}>
              Back
            </Button>
            <Button
              tone="primary"
              icon="check"
              onClick={commit}
              disabled={committing || taking.length === 0}
            >
              {committing
                ? 'Creating…'
                : `Create ${taking.length} ${taking.length === 1 ? 'record' : 'records'}`}
            </Button>
          </div>
        );
      case 'done':
        return (
          <div className="ai-foot">
            <Button tone="ghost" icon="file-up" onClick={() => { startOver(); setStep('files'); }}>
              Read more statements
            </Button>
            <Button tone="primary" onClick={close}>
              Done
            </Button>
          </div>
        );
    }
  })();

  const editingRow = editing !== null ? rows[editing] : null;
  const progressList = Object.values(progress);
  const totalFound = progressList.reduce((s, p) => s + p.found, 0);

  return (
    <>
      <Sheet
        open={isOpen}
        onClose={close}
        title="Import with Claude"
        subtitle={subtitle[step]}
        onBack={back[step]}
        width={step === 'review' ? 980 : 620}
        full={step === 'review'}
        footer={footer}
      >
        {step !== 'done' && (
          <ol className="ai-steps" aria-label="Steps">
            {STEPS.map((s, k) => {
              const at = STEPS.findIndex((x) => x.step === step);
              return (
                <li key={s.step} className={k < at ? 'is-done' : k === at ? 'is-now' : ''}>
                  <span className="ai-step-dot">
                    {k < at ? <Icon name="check" size={11} strokeWidth={3} /> : k + 1}
                  </span>
                  {s.label}
                </li>
              );
            })}
          </ol>
        )}

        {step === 'range' && (
          <div className="ai-pane">
            <Field label="Which account are these statements for?">
              <Select
                options={banks.map((a) => ({
                  value: a.id,
                  label: a.name,
                  hint: a.institution ?? undefined,
                  icon: a.icon,
                  color: a.color,
                }))}
                value={accountId}
                onChange={setAccountId}
                placeholder="Pick an account"
              />
            </Field>
            <Field label="Which dates?" hint="Anything outside them is left out">
              <div className="ai-range">
                <Segmented options={PRESETS} value={preset} onChange={choosePreset} name="ai-range" size="sm" />
                <div className="ai-range-dates">
                  <DateField
                    value={from}
                    onChange={(d) => { setPreset('custom'); setFrom(d); }}
                    placeholder="From"
                  />
                  <span>to</span>
                  <DateField
                    value={to}
                    onChange={(d) => { setPreset('custom'); setTo(d); }}
                    placeholder="To"
                  />
                </div>
                {from > to && <p className="ai-warn">The start is after the end.</p>}
              </div>
            </Field>
          </div>
        )}

        {step === 'files' && (
          <div className="ai-pane">
            {status && !status.source && (
              <div className="ai-callout is-warn">
                <Icon name="key-round" size={16} />
                <div>
                  <strong>Claude isn't connected yet</strong>
                  <p>
                    {status.antProblem ??
                      'Open Settings → Claude to sign in with the Anthropic CLI or add an API key.'}
                  </p>
                </div>
                <Button size="sm" tone="ghost" icon="refresh-cw" onClick={checkStatus} disabled={checking}>
                  {checking ? 'Checking…' : 'Check again'}
                </Button>
              </div>
            )}

            <button type="button" className="ai-drop" onClick={addFiles}>
              <Icon name="file-up" size={22} />
              <strong>{files.length ? 'Add more statements' : 'Choose statements'}</strong>
              <span>PDF, CSV, Excel, or a screenshot. Several at once is fine.</span>
            </button>

            {files.length > 0 && (
              <ul className="ai-files">
                {files.map((f) => (
                  <li key={f.path}>
                    <Icon name="scroll-text" size={15} />
                    <span title={f.path}>{f.name}</span>
                    <button
                      type="button"
                      aria-label={`Remove ${f.name}`}
                      onClick={() => setFiles((was) => was.filter((x) => x.path !== f.path))}
                    >
                      <Icon name="x" size={14} />
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <p className="ai-hint">
              The statements go to Anthropic to be read and nothing is saved until you
              accept it. Password-protected PDFs need the password taken off first:
              open one in Preview and use File → Export as PDF.
            </p>
          </div>
        )}

        {step === 'reading' && (
          <div className="ai-pane ai-reading">
            {readError ? (
              <div className="ai-callout is-error">
                <Icon name="alert-circle" size={16} />
                <div>
                  <strong>Claude couldn't finish reading</strong>
                  <p>{readError}</p>
                </div>
              </div>
            ) : (
              <>
                <div className="ai-spinner" aria-hidden>
                  <Icon name="sparkles" size={22} />
                </div>
                <p className="ai-reading-count">
                  {totalFound > 0
                    ? `${totalFound} ${totalFound === 1 ? 'transaction' : 'transactions'} found so far`
                    : 'Reading…'}
                </p>
                <p className="ai-hint">
                  A long statement can take a minute or two. You can leave this open
                  and come back.
                </p>
              </>
            )}
            <ul className="ai-files is-progress">
              {files.map((f, k) => {
                const p = progress[k];
                const phase = (p?.phase ?? 'waiting') as AiReadProgress['phase'] | 'waiting';
                return (
                  <li key={f.path} className={`is-${phase}`}>
                    <Icon
                      name={phase === 'done' ? 'check-circle-2' : phase === 'waiting' ? 'circle-dashed' : 'sparkles'}
                      size={15}
                    />
                    <span>{f.name}</span>
                    <em>
                      {phase === 'waiting'
                        ? 'Waiting'
                        : phase === 'sending'
                          ? 'Sending'
                          : phase === 'reading'
                            ? `${p!.found} found`
                            : `${p!.found} in range`}
                    </em>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {step === 'review' && (
          <div className="ai-review">
            <div className="ai-review-bar">
              <Segmented
                size="sm"
                name="ai-show"
                value={show}
                onChange={setShow}
                options={[
                  { value: 'all', label: `All ${rows.length}` },
                  { value: 'look', label: `Needs a look ${lookCount}` },
                ]}
              />
              {matched.length > 0 && (
                <Chip active={showMatched} onClick={() => setShowMatched((s) => !s)}>
                  {matched.length} already in the book
                </Chip>
              )}
              <div className="ai-review-tools">
                <Button size="sm" tone="ghost" icon="check-check" onClick={() => setAll(true)}>
                  Accept all
                </Button>
                <Button size="sm" tone="ghost" onClick={() => setAll(false)}>
                  Skip all
                </Button>
              </div>
            </div>

            {rows.length === 0 ? (
              <Empty
                glyph="🙌"
                title="Nothing new here"
                body={
                  matched.length
                    ? 'Every transaction in these dates is already in the book.'
                    : 'Claude found no transactions in these dates.'
                }
              />
            ) : shown.length === 0 ? (
              <Empty glyph="👌" title="Nothing needs a look" body="Claude was sure of every row." />
            ) : (
              <div className="ai-table" role="table">
                <div className="ai-tr ai-th" role="row">
                  <span />
                  <span>Date</span>
                  <span>Description</span>
                  <span>Category</span>
                  <span>Note</span>
                  <span className="ai-num">Amount</span>
                  <span />
                </div>
                {shown.map(([r, i]) => {
                  const credit = r.ai.row.direction === 'credit';
                  return (
                    <div
                      key={i}
                      role="row"
                      className={`ai-tr ${r.include ? '' : 'is-off'} ${needsLook(r) ? 'is-unsure' : ''}`}
                    >
                      <button
                        type="button"
                        className={`import-check ${r.include ? 'is-on' : ''}`}
                        aria-pressed={r.include}
                        aria-label={r.include ? 'Skip this row' : 'Accept this row'}
                        onClick={() => toggle(i)}
                      >
                        <Icon name="check" size={13} strokeWidth={3} />
                      </button>
                      <span className="ai-date">{shortDayLabel(r.ai.row.date)}</span>
                      <div className="ai-desc">
                        <TextInput
                          value={r.input.merchant}
                          aria-label="Description"
                          onChange={(e) => update(i, { merchant: e.target.value })}
                        />
                        <span className="ai-narration" title={r.ai.row.narration}>
                          {r.ai.row.narration}
                        </span>
                      </div>
                      <div className="ai-cat">
                        {r.input.kind === 'transfer' || r.input.splits?.length ? (
                          <button type="button" className="ai-filed" onClick={() => setEditing(i)}>
                            {r.input.kind === 'transfer'
                              ? transferLabel(r.input)
                              : `${r.input.splits!.length} parts`}
                          </button>
                        ) : (
                          <Select
                            options={categoryOptions(r.input.kind)}
                            value={r.input.categoryId}
                            onChange={(v) => setCategory(i, v)}
                            placeholder="Uncategorised"
                            searchable
                            allowClear
                          />
                        )}
                        <Badge row={r} />
                      </div>
                      <TextInput
                        className="ai-note"
                        value={r.input.note ?? ''}
                        placeholder="Add a note"
                        aria-label="Note"
                        onChange={(e) => update(i, { note: e.target.value || null })}
                      />
                      <span className={`ai-num ai-amount ${credit ? 'is-in' : ''}`}>
                        {credit ? '+' : '−'}
                        {money(r.ai.row.amount)}
                      </span>
                      <button
                        type="button"
                        className="ai-more"
                        aria-label="Open in the full editor"
                        title="Transfer, split, labels and more"
                        onClick={() => setEditing(i)}
                      >
                        <Icon name="pencil" size={14} />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}

            {showMatched && matched.length > 0 && (
              <div className="import-rows is-matched">
                {matched.map((m, k) => (
                  <Fragment key={k}>
                    <div className="import-row is-matched">
                      <span className="import-row-tick">
                        <Icon name="check-circle-2" size={15} />
                      </span>
                      <div className="import-row-main">
                        <span className="import-row-title">{m.row.narration}</span>
                        <span className="import-row-sub">
                          already here as {m.matchedSummary}
                          {m.matchedOn && m.matchedOn !== m.row.date
                            ? ` · recorded ${shortDayLabel(m.matchedOn)}`
                            : ''}
                        </span>
                      </div>
                      <span className={`import-row-amount ${m.row.direction === 'credit' ? 'is-in' : ''}`}>
                        {m.row.direction === 'credit' ? '+' : '−'}
                        {money(m.row.amount)}
                      </span>
                    </div>
                  </Fragment>
                ))}
              </div>
            )}

            {rows.length > 0 && (
              <div className="ai-review-foot">
                <Switch
                  on={alreadyCounted}
                  onChange={setAlreadyCounted}
                  label="These are already in the account's balance"
                  hint="For filling in history: the records are added without moving any balance"
                />
                <p className="ai-hint">
                  Rows Claude wasn't sure of, and that you leave as they are, arrive
                  labelled <strong>Triage</strong> so you can check them later. Everything
                  else teaches Flow how to file that counterparty next time.
                </p>
              </div>
            )}
          </div>
        )}

        {step === 'done' && result && (
          <div className="ai-pane ai-done">
            <div className="ai-done-mark">
              <Icon name="check" size={26} strokeWidth={3} />
            </div>
            <h3>
              {result.inserted} {result.inserted === 1 ? 'record' : 'records'} created
            </h3>
            <p>
              {[
                result.triaged ? `${result.triaged} waiting in Triage` : null,
                matched.length ? `${matched.length} already in the book, skipped` : null,
                result.balanceNeutral
                  ? `${result.balanceNeutral} added without moving the balance`
                  : null,
                result.debts ? `${result.debts} ${result.debts === 1 ? 'debt' : 'debts'} opened` : null,
              ]
                .filter(Boolean)
                .join(' · ') || 'Everything is filed.'}
            </p>
          </div>
        )}
      </Sheet>

      {/* The book's own editor, opened on the pending posting. It hands the
          result back here rather than saving. Rendered beside the wizard, not
          inside it: a transformed ancestor would trap its scrim. */}
      <TransactionSheet
        open={editing !== null}
        onClose={() => setEditing(null)}
        editing={editingRow ? pendingTransaction(editingRow.input, accounts, categories) : null}
        onSubmit={(input) => acceptEdit(editing!, input)}
      />
    </>
  );
}

/** Where a row's filing came from, and how sure it is. */
function Badge({ row }: { row: ReviewRow }) {
  if (row.edited) {
    return (
      <em className="import-rule is-sure" title="Changed by you">
        <Icon name="check" size={10} />
        yours
      </em>
    );
  }
  if (row.source === 'remembered') {
    return (
      <em className="import-rule is-sure" title="Filed the way you confirmed this counterparty before">
        <Icon name="check" size={10} />
        remembered
      </em>
    );
  }
  const c = row.ai.confidence;
  return (
    <em
      className={`import-rule ai-conf is-${c}`}
      title={
        c === 'high'
          ? 'Claude is confident about this one'
          : c === 'medium'
            ? 'A reasonable guess from Claude'
            : 'Claude could not tell — worth a look'
      }
    >
      <Icon name="sparkles" size={10} />
      {c === 'high' ? 'sure' : c === 'medium' ? 'likely' : 'unsure'}
    </em>
  );
}
