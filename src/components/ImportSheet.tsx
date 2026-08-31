import { Fragment, useMemo, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { Icon } from './Icon';
import { TransactionSheet } from './TransactionSheet';
import { Button, Chip, Empty, Field, Select, Sheet } from './ui';
import { DateField } from './DateField';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { dayLabel, money, shortDayLabel } from '../lib/format';
import type {
  ImportPreviewRow, Transaction, TransactionInput,
} from '../lib/types';

/**
 * Bringing a bank statement into the book.
 *
 * Pick the file and the account it describes; every row is then held against
 * what the book already has. Rows that pair with an existing posting are set
 * aside; the new ones arrive read-only, each carrying the importer's best
 * guess at the posting it should become — remembered from the last time the
 * counterparty was confirmed, or a plain expense/income otherwise.
 *
 * Changing a row goes through the transaction sheet itself, opened on the
 * pending posting: the same editor every posting in the book uses, with the
 * same categories, transfers, splits and people. What it hands back is held
 * as that row's draft; nothing touches the book until Import.
 */

export function ImportSheet({ open: isOpen, onClose }: { open: boolean; onClose: () => void }) {
  const { accounts, categories, labels, commitStatementImport, toast } = useStore();
  const [accountId, setAccountId] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  // Kept so a partial import can hold the rest of the statement against the
  // book again, with what just went in recognised rather than offered twice.
  const [filePath, setFilePath] = useState<string | null>(null);
  const [rows, setRows] = useState<ImportPreviewRow[] | null>(null);
  // Where the account's own record ends. Rows on or before this date are
  // backfilled history; with the toggle on they leave every balance alone.
  // Which rows the current balance has yet to see. Everything counts by
  // default; `balanceFrom` moves the line in one go, and a row toggled by
  // hand overrides whatever the line says. Nothing about a statement reveals
  // what was already counted, so it is asked rather than guessed.
  const [balanceFrom, setBalanceFrom] = useState('');
  const [balanceOverrides, setBalanceOverrides] = useState<Record<number, boolean>>({});
  // Rows the sheet has rewritten, by index into the preview. Everything else
  // imports as suggested.
  const [drafts, setDrafts] = useState<Record<number, TransactionInput>>({});
  const [skipped, setSkipped] = useState<Set<number>>(new Set());
  // The last checkbox clicked — shift+click sets everything between it and
  // the next click to the same state, the way checkboxes are expected to.
  const [anchor, setAnchor] = useState<number | null>(null);
  // The "import until" cutoff, kept only to show in the field — the skip
  // set it writes is what actually decides.
  const [until, setUntil] = useState('');
  const [showMatched, setShowMatched] = useState(false);
  // The row open in the transaction sheet, when one is.
  const [editing, setEditing] = useState<number | null>(null);
  const [busy, setBusy] = useState<'parsing' | 'importing' | null>(null);

  const banks = useMemo(() => accounts.filter((a) => !a.archived), [accounts]);

  const reset = () => {
    setFileName(null);
    setFilePath(null);
    setRows(null);
    setBalanceFrom('');
    setBalanceOverrides({});
    setDrafts({});
    setSkipped(new Set());
    setUntil('');
    setShowMatched(false);
    setAnchor(null);
    setEditing(null);
  };

  const close = () => {
    // Escape lands on every open sheet at once; while the editor is up, the
    // review underneath stays put.
    if (editing !== null) return;
    reset();
    setAccountId(null);
    onClose();
  };

  const pickFile = async () => {
    if (!accountId) return;
    const path = await open({
      title: 'Which statement should be read?',
      multiple: false,
      directory: false,
      filters: [{ name: 'Bank statement', extensions: ['xls', 'xlsx'] }],
    });
    if (typeof path !== 'string') return;
    setBusy('parsing');
    try {
      const parsed = await api.parseStatement(path);
      const preview = await api.previewStatementImport(accountId, parsed);
      setFileName(path.split('/').pop() ?? path);
      setFilePath(path);
      setRows(preview);
      setDrafts({});
      setSkipped(new Set());
      setUntil('');
      setAnchor(null);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(null);
    }
  };

  // Newest first, the way the ledger reads. The sort is stable, so rows
  // within one day keep the statement's own order.
  const fresh = useMemo(
    () =>
      (rows ?? [])
        .map((r, i) => [r, i] as const)
        .filter(([r]) => r.status === 'new')
        .sort((a, b) => b[0].row.date.localeCompare(a[0].row.date)),
    [rows],
  );
  const matched = useMemo(
    () =>
      (rows ?? [])
        .map((r, i) => [r, i] as const)
        .filter(([r]) => r.status === 'matched')
        .sort((a, b) => b[0].row.date.localeCompare(a[0].row.date)),
    [rows],
  );
  const taking = fresh.filter(([, i]) => !skipped.has(i));

  /** Consecutive rows of one day, under one date heading. */
  const byDay = (list: (readonly [ImportPreviewRow, number])[]) => {
    const days: { date: string; items: (readonly [ImportPreviewRow, number])[] }[] = [];
    for (const entry of list) {
      const last = days[days.length - 1];
      if (last && last.date === entry[0].row.date) last.items.push(entry);
      else days.push({ date: entry[0].row.date, items: [entry] });
    }
    return days;
  };

  /** One checkbox, or — with shift held — the whole run between the last
   *  click and this one, all set to the state this click produces. */
  const toggleRow = (i: number, range: boolean) => {
    const include = skipped.has(i);
    let targets = [i];
    if (range && anchor !== null && anchor !== i) {
      const a = fresh.findIndex(([, j]) => j === anchor);
      const b = fresh.findIndex(([, j]) => j === i);
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        targets = fresh.slice(lo, hi + 1).map(([, j]) => j);
      }
    }
    setSkipped((was) => {
      const next = new Set(was);
      for (const j of targets) {
        if (include) next.delete(j);
        else next.add(j);
      }
      return next;
    });
    setAnchor(i);
  };

  /** Include everything up to (and on) a date; skip what came after. The
   *  statement runs oldest → newest, so "until" is where the import stops. */
  const applyUntil = (date: string) => {
    setUntil(date);
    if (!date) {
      setSkipped(new Set());
      return;
    }
    setSkipped(new Set(fresh.filter(([r]) => r.row.date > date).map(([, i]) => i)));
  };

  /** The posting a row becomes if nothing is changed: the suggestion, in the
   *  transaction sheet's own terms. */
  const defaultInput = (r: ImportPreviewRow): TransactionInput => {
    const debit = r.row.direction === 'debit';
    if (r.kind === 'transfer' && r.transferAccountId) {
      return {
        id: null,
        kind: 'transfer',
        amount: r.row.amount,
        accountId: debit ? accountId! : r.transferAccountId,
        toAccountId: debit ? r.transferAccountId : accountId!,
        categoryId: null,
        merchant: r.merchant,
        // The bank's own words, shown rather than filled in behind your
        // back — the commit would use them anyway if this were left empty.
        note: r.row.narration,
        occurredAt: `${r.row.date}T12:00`,
      };
    }
    return {
      id: null,
      kind: debit ? 'expense' : 'income',
      amount: r.row.amount,
      accountId: accountId!,
      toAccountId: null,
      categoryId: r.categoryId,
      merchant: r.merchant,
      note: r.row.narration,
      occurredAt: `${r.row.date}T12:00`,
    };
  };

  const inputFor = (i: number, r: ImportPreviewRow) => drafts[i] ?? defaultInput(r);

  const accountName = (id: string | null | undefined) =>
    accounts.find((a) => a.id === id)?.name ?? '?';

  /** What the row will post as, in a phrase: the summary the pill shows. */
  const filedAs = (input: TransactionInput) => {
    const shares = input.shares?.length
      ? ` · ${input.shares.map((s) => s.counterparty).join(', ')} ${
          input.shares[0].direction === 'lent' ? 'owe this back' : 'to be repaid'
        }`
      : '';
    if (input.kind === 'transfer') {
      const arrow =
        input.accountId === accountId
          ? `Transfer → ${input.toAccountId ? accountName(input.toAccountId) : 'owed back'}`
          : `Transfer ← ${accountName(input.accountId)}`;
      return arrow + shares;
    }
    if (input.splits?.length) {
      const names = input.splits
        .map((s) => categories.find((c) => c.id === s.categoryId)?.name)
        .filter(Boolean)
        .join(', ');
      return `${input.splits.length} parts${names ? ` · ${names}` : ''}${shares}`;
    }
    const cat = categories.find((c) => c.id === input.categoryId)?.name;
    return (cat ?? (input.kind === 'income' ? 'Income' : 'Uncategorised')) + shares;
  };

  /** The pending posting dressed as a transaction, so the sheet opens on it
   *  exactly as it opens on a real one. Denormalised names are looked up
   *  here; ids invented here are stripped again on the way back. */
  const asEditing = (input: TransactionInput): Transaction => {
    const acc = accounts.find((a) => a.id === input.accountId);
    const cat = categories.find((c) => c.id === input.categoryId);
    const catName = (id: string | null) =>
      categories.find((c) => c.id === id)?.name ?? null;
    return {
      id: '',
      kind: input.kind,
      amount: input.amount,
      accountId: input.accountId,
      toAccountId: input.toAccountId ?? null,
      categoryId: input.categoryId ?? null,
      merchant: input.merchant,
      note: input.note ?? null,
      occurredAt: input.occurredAt,
      createdAt: '',
      accountName: acc?.name ?? '',
      accountColor: acc?.color ?? 'var(--ink-3)',
      toAccountName: accounts.find((a) => a.id === input.toAccountId)?.name ?? null,
      categoryName: cat?.name ?? null,
      categoryIcon: cat?.icon ?? null,
      categoryColor: cat?.color ?? null,
      categoryGroupId: cat ? (cat.parentId ?? cat.id) : null,
      categoryGroupName: cat
        ? (categories.find((p) => p.id === cat.parentId)?.name ?? cat.name)
        : null,
      splits: (input.splits ?? []).map((s, k) => ({
        id: `pending-part-${k}`,
        transactionId: '',
        amount: s.amount,
        categoryId: s.categoryId,
        note: s.note ?? null,
        sortOrder: k,
        categoryName: catName(s.categoryId),
        categoryIcon: null,
        categoryColor: null,
        categoryGroupId: null,
        categoryGroupName: null,
      })),
      shares: (input.shares ?? []).map((s, k) => ({
        debtId: `pending-share-${k}`,
        direction: s.direction,
        counterparty: s.counterparty,
        amount: s.amount,
        dueOn: s.dueOn ?? null,
        note: s.note ?? null,
        paid: 0,
        outstanding: s.amount,
        settled: false,
      })),
      labels: [],
      // A row waiting to import gives nothing back and has had nothing
      // given back to it: it is not in the book yet to be refunded.
      refundOf: null,
      refundOfMerchant: null,
      refundOfAmount: null,
      refunded: 0,
    };
  };

  /** The sheet handed back a posting for one row. Simple filings — no parts,
   *  nobody owing — spread to the counterparty's other untouched rows, so
   *  forty SIP debits are one decision. */
  const acceptEdit = (i: number, raw: TransactionInput) => {
    const input: TransactionInput = {
      ...raw,
      id: null,
      splits: raw.splits?.map((s) => ({ ...s, id: null })),
      shares: raw.shares?.map((s) => ({ ...s, id: null })),
    };
    const r = rows![i];
    const simple = !input.splits?.length && !input.shares?.length;
    const siblings =
      simple && r.matchKey
        ? fresh.filter(
            ([o, j]) =>
              j !== i &&
              o.matchKey === r.matchKey &&
              o.row.direction === r.row.direction &&
              !(j in drafts),
          )
        : [];
    setDrafts((was) => {
      const next = { ...was, [i]: input };
      for (const [o, j] of siblings) {
        next[j] = {
          ...defaultInput(o),
          kind: input.kind,
          accountId: input.accountId,
          toAccountId: input.toAccountId,
          categoryId: input.categoryId,
        };
      }
      return next;
    });
    if (siblings.length > 0) {
      toast(
        `Also filed ${siblings.length} more ${
          siblings.length === 1 ? 'entry' : 'entries'
        } of this counterparty the same way`,
      );
    }
  };

  /** Whether a row should move the balances it touches: what was set on the
   *  row itself, else what the date line says. */
  const affectsBalance = (r: ImportPreviewRow, i: number) =>
    i in balanceOverrides
      ? balanceOverrides[i]
      : !balanceFrom || r.row.date >= balanceFrom;

  // What is being recorded without moving anything, and what the openings
  // absorb to keep it that way.
  const neutral = taking.filter(([r, i]) => !affectsBalance(r, i));
  const openingShift = neutral.reduce(
    (sum, [r]) => sum + (r.row.direction === 'debit' ? r.row.amount : -r.row.amount),
    0,
  );

  // Rows that need no further checking: filed by hand here, or by a rule a
  // person confirmed earlier. Exactly the ones that would not land in
  // triage — which is what makes "reviewed" worth importing on its own.
  const reviewed = taking.filter(([r, i]) => i in drafts || r.ruleConfirmed);
  const allReviewed = reviewed.length === taking.length;

  const doImport = async (which: 'reviewed' | 'all') => {
    if (!accountId || !rows) return;
    const chosen = which === 'reviewed' ? reviewed : taking;
    if (chosen.length === 0) return;
    setBusy('importing');
    try {
      const commit = chosen.map(([r, i]) => {
        // Shaping a row here is reviewing it: it skips triage, and teaches
        // its counterparty's rule on the way in. So does a row filed by a
        // rule that was already confirmed. What is left is guesswork, and
        // that is what triage is for.
        const edited = i in drafts;
        return {
          row: r.row,
          input: inputFor(i, r),
          triage: !edited && !r.ruleConfirmed,
          learn: edited,
          affectsBalance: affectsBalance(r, i),
        };
      });
      const done = await commitStatementImport(accountId, commit);
      const said = [
        `${done.inserted} imported`,
        done.debts ? `${done.debts} ${done.debts === 1 ? 'debt' : 'debts'} opened` : null,
        done.triaged ? `${done.triaged} waiting in triage` : null,
        done.balanceNeutral
          ? `${done.balanceNeutral} recorded without moving a balance`
          : null,
      ].filter(Boolean);
      toast(said.join(' · '));
      setEditing(null);

      // Some of the statement is still on the table: hold what is left
      // against the book again, so what just went in shows as recognised
      // rather than being offered a second time.
      const left = taking.length - chosen.length;
      if (left > 0 && filePath && accountId) {
        const parsed = await api.parseStatement(filePath);
        const preview = await api.previewStatementImport(accountId, parsed);
        setRows(preview);
        // The indices these were keyed by belong to the old list.
        setDrafts({});
        setBalanceFrom('');
        setBalanceOverrides({});
        setSkipped(new Set());
        setUntil('');
        setAnchor(null);
        return;
      }

      reset();
      setAccountId(null);
      onClose();
    } catch {
      /* the store has already said what went wrong */
    } finally {
      setBusy(null);
    }
  };

  const account = accounts.find((a) => a.id === accountId);
  const triageLabel = labels.find((l) => l.name === 'Triage');
  const editingRow = editing !== null && rows ? rows[editing] : null;

  return (
    <>
    <Sheet
      open={isOpen}
      onClose={close}
      title="Import a statement"
      subtitle={
        rows
          ? `${fileName} → ${account?.name ?? ''}`
          : 'A bank export, held against what the book already has'
      }
      width={760}
      full={!!rows}
      footer={
        rows ? (
          <div className="import-foot">
            <Button tone="ghost" onClick={() => { reset(); }} disabled={busy !== null}>
              Another file
            </Button>
            <div className="import-foot-actions">
              {/* Only offered while the two differ — with everything
                  reviewed, "all" and "reviewed" are the same button. */}
              {!allReviewed && (
                <Button
                  onClick={() => doImport('all')}
                  disabled={busy !== null || taking.length === 0}
                  title="Bring in the unreviewed ones too — they arrive labelled Triage"
                >
                  {`Import all ${taking.length}`}
                </Button>
              )}
              <Button
                tone="primary"
                icon="download"
                onClick={() => doImport(allReviewed ? 'all' : 'reviewed')}
                disabled={busy !== null || reviewed.length === 0}
                title={
                  allReviewed
                    ? undefined
                    : 'Filed by hand here, or by a rule you confirmed before — nothing left to check'
                }
              >
                {busy === 'importing'
                  ? 'Importing…'
                  : allReviewed
                    ? `Import ${taking.length} ${taking.length === 1 ? 'entry' : 'entries'}`
                    : `Import ${reviewed.length} reviewed`}
              </Button>
            </div>
          </div>
        ) : undefined
      }
    >
      {!rows ? (
        <div className="import-start">
          <Field label="Which account is this a statement of?">
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
          <Button
            tone="primary"
            icon="file-up"
            onClick={pickFile}
            disabled={!accountId || busy !== null}
          >
            {busy === 'parsing' ? 'Reading…' : 'Choose the statement file'}
          </Button>
          <p className="import-hint">
            Rows already in the book are recognised and left alone, so a statement
            can be imported again without doubling anything. New entries come in
            marked <strong>Triage</strong>{triageLabel && triageLabel.count > 0
              ? ` (${triageLabel.count} waiting now)`
              : ''} until you confirm how they are filed — and once confirmed, the
            next statement files that counterparty by itself.
          </p>
        </div>
      ) : (
        <div className="import-preview">
          <div className="import-counts">
            <Chip active color="var(--green-bright)">
              {fresh.length} new
            </Chip>
            <Chip active={showMatched} onClick={() => setShowMatched((s) => !s)}>
              {matched.length} already in the book
            </Chip>
            {skipped.size > 0 && <Chip>{skipped.size} skipped</Chip>}

            <div className="import-tools">
              <span className="import-tools-label">Import</span>
              <Button
                size="sm"
                tone="ghost"
                onClick={() => applyUntil('')}
                disabled={skipped.size === 0}
              >
                All
              </Button>
              <Button
                size="sm"
                tone="ghost"
                onClick={() => {
                  setUntil('');
                  setSkipped(new Set(fresh.map(([, i]) => i)));
                }}
                disabled={taking.length === 0}
              >
                None
              </Button>
              <span className="import-tools-label">or until</span>
              <div className="import-until">
                <DateField value={until} onChange={applyUntil} placeholder="a date" allowClear />
              </div>
            </div>
          </div>

          {/* Which of these the balance has yet to see. Only you know: the
              statement says what the bank did, not what you had already
              written down. Anything left out is still recorded — the
              opening balances it touches absorb it, so nothing moves. */}
          <div className="import-balance">
            <div className="import-balance-head">
              <span className="import-tools-label">Moves the balance</span>
              <Button
                size="sm"
                tone="ghost"
                onClick={() => { setBalanceFrom(''); setBalanceOverrides({}); }}
                disabled={neutral.length === 0}
              >
                All
              </Button>
              <Button
                size="sm"
                tone="ghost"
                onClick={() => {
                  setBalanceFrom('');
                  setBalanceOverrides(
                    Object.fromEntries(fresh.map(([, i]) => [i, false])),
                  );
                }}
                disabled={neutral.length === taking.length}
              >
                None
              </Button>
              <span className="import-tools-label">or from</span>
              <div className="import-until">
                <DateField
                  value={balanceFrom}
                  onChange={(date) => {
                    setBalanceFrom(date);
                    // The line is the new answer for every row; a row set by
                    // hand before it was drawn is no longer an exception.
                    setBalanceOverrides({});
                  }}
                  placeholder="a date"
                  allowClear
                />
              </div>
            </div>
            <p>
              {neutral.length === 0
                ? 'Every entry moves the balance, as new money does.'
                : `${neutral.length} of ${taking.length} recorded without moving anything — the opening balance absorbs ${money(openingShift, { sign: true })}.`}
            </p>
          </div>

          {fresh.length === 0 ? (
            <Empty
              icon="check-circle-2"
              title="Nothing new here"
              body="Every row of this statement is already in the book."
            />
          ) : (
            <div className="import-rows">
              {byDay(fresh).map((day) => (
                <Fragment key={day.date}>
                  <div className="import-day">{dayLabel(day.date)}</div>
                  {day.items.map(([r, i]) => {
                    const off = skipped.has(i);
                    const input = inputFor(i, r);
                    const edited = i in drafts;
                    return (
                      <div
                        key={i}
                        className={`import-row is-openable ${off ? 'is-off' : ''}`}
                        role="button"
                        tabIndex={off ? -1 : 0}
                        onClick={() => !off && setEditing(i)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !off) setEditing(i);
                        }}
                      >
                        <button
                          type="button"
                          className={`import-check ${off ? '' : 'is-on'}`}
                          aria-pressed={!off}
                          aria-label={off ? 'Include this row' : 'Skip this row'}
                          onClick={(e) => {
                            // The box decides inclusion; the row behind it
                            // opens the editor. One click, one meaning.
                            e.stopPropagation();
                            toggleRow(i, e.shiftKey);
                          }}
                        >
                          <Icon name="check" size={13} strokeWidth={3} />
                        </button>
                        <div className="import-row-main">
                          <span className="import-row-title">
                            {input.merchant || r.row.narration}
                            {edited ? (
                              <em
                                className="import-rule is-sure"
                                title="Filed by hand here — it skips triage, and the next statement files this counterparty the same way"
                              >
                                <Icon name="check" size={10} />
                                reviewed
                              </em>
                            ) : r.fromRule ? (
                              <em
                                className={`import-rule ${r.ruleConfirmed ? 'is-sure' : ''}`}
                                title={
                                  r.ruleConfirmed
                                    ? 'Filed the way you confirmed it last time'
                                    : 'A guess from your history — lands in triage'
                                }
                              >
                                <Icon name={r.ruleConfirmed ? 'check' : 'sparkles'} size={10} />
                                {r.ruleConfirmed ? 'remembered' : 'guessed'}
                              </em>
                            ) : null}
                          </span>
                          <span className="import-row-sub" title={r.row.narration}>
                            {r.row.narration}
                          </span>
                        </div>
                        <span className="import-filed">{filedAs(input)}</span>
                        {/* Whether this one moves the balance, overriding
                            the date line above for this row alone. */}
                        <button
                          type="button"
                          className={`import-moves ${
                            affectsBalance(r, i) ? 'is-on' : ''
                          }`}
                          disabled={off}
                          aria-pressed={affectsBalance(r, i)}
                          title={
                            affectsBalance(r, i)
                              ? 'Moves the balance — click if this is already counted'
                              : 'Already counted: recorded, but the balance stays put'
                          }
                          onClick={(e) => {
                            e.stopPropagation();
                            setBalanceOverrides((was) => ({
                              ...was,
                              [i]: !affectsBalance(r, i),
                            }));
                          }}
                        >
                          <Icon
                            name={affectsBalance(r, i) ? 'wallet' : 'circle-dashed'}
                            size={13}
                          />
                        </button>
                        <span
                          className={`import-row-amount ${
                            r.row.direction === 'credit' ? 'is-in' : ''
                          }`}
                        >
                          {r.row.direction === 'credit' ? '+' : '−'}
                          {money(r.row.amount)}
                        </span>
                      </div>
                    );
                  })}
                </Fragment>
              ))}
            </div>
          )}

          {showMatched && matched.length > 0 && (
            <div className="import-rows is-matched">
              {byDay(matched).map((day) => (
                <Fragment key={day.date}>
                  <div className="import-day">{dayLabel(day.date)}</div>
                  {day.items.map(([r, i]) => (
                    <div key={i} className="import-row is-matched">
                      <span className="import-row-tick">
                        <Icon name="check-circle-2" size={15} />
                      </span>
                      <div className="import-row-main">
                        <span className="import-row-title">{r.row.narration}</span>
                        <span className="import-row-sub">
                          already here as {r.matchedSummary}
                          {r.matchedOn && r.matchedOn !== r.row.date
                            ? ` · recorded ${shortDayLabel(r.matchedOn)}`
                            : ''}
                        </span>
                      </div>
                      <span
                        className={`import-row-amount ${
                          r.row.direction === 'credit' ? 'is-in' : ''
                        }`}
                      >
                        {r.row.direction === 'credit' ? '+' : '−'}
                        {money(r.row.amount)}
                      </span>
                    </div>
                  ))}
                </Fragment>
              ))}
            </div>
          )}
        </div>
      )}

    </Sheet>

    {/* The book's own editor, opened on the pending posting. It hands the
        result back here rather than saving — the row is not in the book
        yet, and won't be until Import says so. Rendered beside the review
        sheet, not inside it: a transformed ancestor would trap its scrim. */}
    <TransactionSheet
      open={editing !== null}
      onClose={() => setEditing(null)}
      editing={editingRow ? asEditing(inputFor(editing!, editingRow)) : null}
      onSubmit={(input) => acceptEdit(editing!, input)}
    />
    </>
  );
}
