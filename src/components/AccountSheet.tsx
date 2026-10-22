import { useCallback, useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { DateField, DayField, ordinalDay } from './DateField';
import { ACCOUNT_ICONS, Icon } from './Icon';
import {
  Button, Confirm, Field, IconButton, Segmented, Sheet, TextInput, type SegmentOption,
} from './ui';
import { useStore } from '../lib/store';
import {
  amountChars, dayLabel, money, paiseToRupeeString, rupeesToPaise, settleAmount,
} from '../lib/format';
import { itemVariants, listVariants, spring } from '../lib/motion';
import type { Account, AccountKind, CardTerm, Paise } from '../lib/types';

const KINDS: SegmentOption<AccountKind>[] = [
  { value: 'bank', label: 'Bank' },
  { value: 'credit', label: 'Credit' },
  { value: 'cash', label: 'Cash' },
  { value: 'wallet', label: 'Wallet' },
  { value: 'investment', label: 'Invest' },
];

const SWATCHES = [
  '#20294C', '#118AE4', '#42C251', '#7C3AED', '#F0B429', '#E0433D',
  '#0EA5E9', '#14B8A6', '#EC4899', '#F2724F', '#5A87E6', '#676B89',
];

const DEFAULT_ICON: Record<AccountKind, string> = {
  bank: 'landmark',
  credit: 'credit-card',
  cash: 'wallet',
  wallet: 'smartphone',
  investment: 'trending-up',
};

/** One line of the record: a change as the table shows it, whether it is in
 *  the book yet or only held against a card being made. */
interface TermRow {
  key: string;
  on: string;
  creditLimit: Paise | null;
  statementDay: number | null;
  dueDay: number | null;
  /** Whether that due day falls in the month after the bill is cut, which it
   *  does whenever it is not later in the month than the closing day. */
  nextMonth?: boolean;
}

/** A change recorded against a card that has no id to hang it on yet. */
interface PendingTerm {
  effectiveOn: string;
  creditLimit: Paise | null;
  statementDay: number | null;
  dueDay: number | null;
}

/** What a change says, in the order a card is read in. A term it says nothing
 *  about is left out: silence means carry on as before. */
function termWords(term: {
  creditLimit: Paise | null; statementDay: number | null; dueDay: number | null;
}) {
  return [
    term.creditLimit ? money(term.creditLimit) : null,
    term.statementDay ? `closes the ${ordinalDay(term.statementDay)}` : null,
    term.dueDay ? `due the ${ordinalDay(term.dueDay)}` : null,
  ].filter(Boolean).join(' · ');
}

/** Today as a plain ISO day, by the wall clock rather than UTC. */
function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${
    String(d.getDate()).padStart(2, '0')}`;
}

export function AccountSheet({
  open, onClose, editing,
}: { open: boolean; onClose: () => void; editing?: Account | null }) {
  const {
    saveAccount, deleteAccount, setAccountArchived,
    cardTerms, saveCardTerm, deleteCardTerm,
  } = useStore();

  const [name, setName] = useState('');
  const [kind, setKind] = useState<AccountKind>('bank');
  const [institution, setInstitution] = useState('');
  const [opening, setOpening] = useState('');
  const [color, setColor] = useState(SWATCHES[0]);
  const [icon, setIcon] = useState('landmark');
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  // The days the card's terms changed, and the change being written now. A
  // limit, a statement day and a due day are none of them one number: they
  // are runs of them, and an old cycle reads wrong until the book knows
  // which was in force when.
  const [terms, setTerms] = useState<CardTerm[]>([]);
  // The same changes for a card that has no id yet, kept until it has one.
  const [pending, setPending] = useState<PendingTerm[]>([]);
  const [termOn, setTermOn] = useState('');
  const [termLimit, setTermLimit] = useState('');
  const [termStatement, setTermStatement] = useState(0);
  const [termDue, setTermDue] = useState(0);
  const [termError, setTermError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    if (editing) {
      setName(editing.name);
      setKind(editing.kind);
      setInstitution(editing.institution ?? '');
      setOpening(paiseToRupeeString(editing.openingBalance));
      setColor(editing.color);
      setIcon(editing.icon);
    } else {
      setName('');
      setKind('bank');
      setInstitution('');
      setOpening('');
      setColor(SWATCHES[0]);
      setIcon('landmark');
    }
    setError(null);
    setConfirming(false);
    setTermOn('');
    setTermLimit('');
    setTermStatement(0);
    setTermDue(0);
    setTermError(null);
    setPending([]);
  }, [open, editing]);

  // What the card's terms have been. Only an account already in the book can
  // carry a history — there is nothing to hang one on until it is saved.
  const loadTerms = useCallback(() => {
    if (!open || !editing || editing.kind !== 'credit') return setTerms([]);
    cardTerms(editing.id)
      .then(setTerms)
      .catch(() => setTerms([]));
  }, [open, editing?.id, editing?.kind, cardTerms]);

  useEffect(loadTerms, [loadTerms]);

  // Follow the account type unless the user has chosen a glyph themselves.
  const chooseKind = (next: AccountKind) => {
    if (icon === DEFAULT_ICON[kind]) setIcon(DEFAULT_ICON[next]);
    setKind(next);
  };

  /** Records what the terms became on a day. A card already in the book has
   *  it written straight away; one being made holds its changes until it has
   *  an id to hang them on. */
  const recordTerm = async () => {
    if (!termOn) return setTermError('Pick the day it changed.');
    const limit = termLimit.trim() ? rupeesToPaise(termLimit) : null;
    const change = {
      creditLimit: limit && limit > 0 ? limit : null,
      statementDay: termStatement || null,
      dueDay: termDue || null,
    };
    if (!change.creditLimit && !change.statementDay && !change.dueDay) {
      return setTermError('Nothing changed on that day.');
    }
    if (editing) {
      await saveCardTerm(editing.id, termOn, change);
      loadTerms();
    } else {
      setPending((rows) => [
        ...rows.filter((r) => r.effectiveOn !== termOn),
        { effectiveOn: termOn, ...change },
      ].sort((a, b) => a.effectiveOn.localeCompare(b.effectiveOn)));
    }
    clearTerm();
  };

  /** Opens a recorded change in the form beside it, so a day mistyped or a
   *  limit misremembered is corrected where it was written rather than
   *  deleted and typed again. Saving it back writes over the same day. */
  const editTerm = (row: TermRow) => {
    setTermOn(row.on);
    setTermLimit(row.creditLimit ? paiseToRupeeString(row.creditLimit) : '');
    setTermStatement(row.statementDay ?? 0);
    setTermDue(row.dueDay ?? 0);
    setTermError(null);
  };

  /** Back to a blank change. */
  const clearTerm = () => {
    setTermOn('');
    setTermLimit('');
    setTermStatement(0);
    setTermDue(0);
    setTermError(null);
  };

  /** Takes a change back out. Whatever is left standing on today is what the
   *  card is on, which the book works out for itself. */
  const forgetTerm = async (id: string) => {
    if (editing) {
      await deleteCardTerm(id);
      loadTerms();
    } else {
      setPending((rows) => rows.filter((r) => r.effectiveOn !== id));
    }
  };

  // The changes on show, whether they are in the book yet or not — and which
  // of them the card is actually on.
  const written: TermRow[] = editing
    ? terms.map((t) => ({
      key: t.id,
      on: t.effectiveOn,
      creditLimit: t.creditLimit,
      statementDay: t.statementDay,
      dueDay: t.dueDay,
    }))
    : pending.map((r) => ({ key: r.effectiveOn, on: r.effectiveOn, ...r }));
  // A due day at or before the closing day belongs to the month after — so
  // each change is read against the closing day standing when it was made,
  // which is its own or the one carried forward to it.
  let closingSoFar = editing?.statementDay || 0;
  const rows: TermRow[] = written.map((r) => {
    closingSoFar = r.statementDay ?? closingSoFar;
    return { ...r, nextMonth: !!r.dueDay && !!closingSoFar && r.dueDay <= closingSoFar };
  });
  // Writing over a day already recorded is an edit of it, not a second one.
  const editingTerm = rows.some((r) => r.on === termOn);
  // The day being written, read the same way: due on or before closing is
  // the month after.
  const closingThen = termStatement || closingSoFar;
  const dueNextMonth = !!termDue && !!closingThen && termDue <= closingThen;
  const standing = [...rows].filter((r) => r.on <= todayISO()).pop();
  // What the card is actually on today: every change up to now folded over
  // the terms the account itself carries, exactly as the book folds them.
  const inForce = rows
    .filter((r) => r.on <= todayISO())
    .reduce(
      (held, r) => ({
        creditLimit: r.creditLimit ?? held.creditLimit,
        statementDay: r.statementDay ?? held.statementDay,
        dueDay: r.dueDay ?? held.dueDay,
      }),
      editing && editing.kind === 'credit'
        ? {
          creditLimit: editing.creditLimit || null,
          statementDay: editing.statementDay || null,
          dueDay: editing.dueDay || null,
        }
        : { creditLimit: null as Paise | null, statementDay: null as number | null, dueDay: null as number | null },
    );

  const submit = async () => {
    if (!name.trim()) return setError('Give the account a name.');
    const saved = await saveAccount({
      id: editing?.id ?? null,
      name: name.trim(),
      kind,
      institution: institution.trim() || null,
      openingBalance: rupeesToPaise(opening),
      color,
      icon,
    });
    // The changes a new card was given while it had no id to hang them on.
    // Oldest first, so the newest is the one it ends up on.
    if (!editing && kind === 'credit') {
      for (const row of pending) {
        await saveCardTerm(saved.id, row.effectiveOn, row);
      }
    }
    onClose();
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={editing ? 'Edit account' : 'New account'}
      subtitle={
        editing
          ? `Live balance ${money(editing.balance)}`
          : 'Where the money sits: a bank, a card, a wallet, a fund'
      }
      width={kind === 'credit' ? 760 : 520}
      footer={
        <>
          {editing ? (
            <div className="foot-actions">
              <Button
                tone="ghost"
                icon={editing.archived ? 'undo-2' : 'inbox'}
                onClick={async () => {
                  await setAccountArchived(editing.id, !editing.archived);
                  onClose();
                }}
              >
                {editing.archived ? 'Restore' : 'Archive'}
              </Button>
              <Button tone="danger" icon="trash-2" onClick={() => setConfirming(true)}>
                Delete
              </Button>
            </div>
          ) : (
            <span />
          )}
          <div className="foot-actions">
            <Button tone="ghost" onClick={onClose}>Cancel</Button>
            <Button tone="primary" onClick={submit}>
              {editing ? 'Save changes' : 'Add account'}
            </Button>
          </div>
        </>
      }
    >
      <div className="account-form">
        <motion.div className="account-preview" style={{ background: color }} layout>
          <span className="account-preview-glyph">
            <Icon name={icon} size={20} />
          </span>
          <div>
            <strong>{name || 'Account name'}</strong>
            <span>{institution || KINDS.find((k) => k.value === kind)?.label}</span>
          </div>
          <span className="account-preview-balance">
            {money(rupeesToPaise(opening))}
          </span>
        </motion.div>

        <Segmented options={KINDS} value={kind} onChange={chooseKind} name="acct-kind" size="sm" />

        <div className="tx-meta">
          <Field label="Name" error={error}>
            <TextInput
              value={name}
              placeholder="Savings"
              onChange={(e) => { setName(e.target.value); setError(null); }}
            />
          </Field>
          <Field label="Institution" hint="optional">
            <TextInput
              value={institution}
              placeholder="HDFC Bank"
              onChange={(e) => setInstitution(e.target.value)}
            />
          </Field>
        </div>

        <div className="tx-meta">
          <Field
            label="Opening balance"
            hint={kind === 'credit' ? 'owed when tracking began' : 'before any transactions'}
          >
            <div className="rupee-input">
              <span>₹</span>
              <TextInput
                inputMode="decimal"
                value={opening}
                placeholder="0"
                // A leading minus is allowed: an account can start overdrawn,
                // and an imported opening balance often is. So is a sum —
                // an opening balance is often several things added up.
                onChange={(e) => setOpening(amountChars(e.target.value))}
                onBlur={() => setOpening(settleAmount(opening))}
              />
            </div>
          </Field>
        </div>

        {/* Everything a card's terms are made of, and every day they
            changed. None of the three holds still: a limit gets raised, a
            bank moves the closing day, a due day shifts with it — and a card
            taken to have always been as it is now reads every old cycle
            wrong.

            Two panes, because there are two jobs here and they are not the
            same one: reading what the card has been on, and writing down a
            change. The record is a table; the change is a form with its
            fields named, and a row clicked opens in it. */}
        <AnimatePresence initial={false}>
          {kind === 'credit' && (
            <motion.div
              key="terms"
              className="terms-block"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={spring}
              style={{ overflow: 'hidden' }}
            >
              <span className="field-label">
                Card terms
                <em>
                  {termWords(inForce)
                    ? `${termWords(inForce)} now`
                    : 'nothing recorded yet'}
                </em>
              </span>

              <div className="terms-panes">
                <section className="terms-pane terms-record">
                  <header>
                    <h4>Changes</h4>
                    {rows.length > 0 && <span>{rows.length}</span>}
                  </header>

                  {rows.length ? (
                    <div className="terms-scroll">
                      <table className="terms-table">
                        <thead>
                          <tr>
                            <th scope="col">From</th>
                            <th scope="col" className="is-num">Limit</th>
                            <th scope="col" className="is-day">Closes</th>
                            <th scope="col" className="is-day">Due</th>
                            <th scope="col" className="is-act">
                              <span className="sr-only">Remove</span>
                            </th>
                          </tr>
                        </thead>
                        {/* A dash is a term the change said nothing about,
                            which carries on as it was. */}
                        <tbody>
                          {[...rows].reverse().map((row) => (
                            <tr
                              key={row.key}
                              className={[
                                row.key === standing?.key ? 'is-standing' : '',
                                row.on > todayISO() ? 'is-future' : '',
                                row.on === termOn ? 'is-editing' : '',
                              ].filter(Boolean).join(' ')}
                            >
                              <th scope="row">
                                <button type="button" onClick={() => editTerm(row)}>
                                  {dayLabel(row.on)}
                                  <small>
                                    {row.on > todayISO()
                                      ? 'not in force yet'
                                      : row.key === standing?.key
                                        ? 'in force now'
                                        : 'until the next change'}
                                  </small>
                                </button>
                              </th>
                              <td className="is-num">
                                {row.creditLimit ? money(row.creditLimit) : <em>—</em>}
                              </td>
                              <td className="is-day">
                                {row.statementDay ? ordinalDay(row.statementDay) : <em>—</em>}
                              </td>
                              <td className="is-day">
                                {row.dueDay ? (
                                  <>
                                    {ordinalDay(row.dueDay)}
                                    {row.nextMonth && <small>next mo.</small>}
                                  </>
                                ) : <em>—</em>}
                              </td>
                              <td className="is-act">
                                <IconButton
                                  icon="trash-2"
                                  label={`Remove the change on ${dayLabel(row.on)}`}
                                  size={26}
                                  onClick={() => forgetTerm(row.key)}
                                />
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className="terms-none">Nothing recorded yet.</p>
                  )}
                </section>

                <section className="terms-pane terms-write">
                  <header>
                    <h4>{editingTerm ? `Editing ${dayLabel(termOn)}` : 'New change'}</h4>
                    {editingTerm && (
                      <button type="button" className="terms-cancel" onClick={clearTerm}>
                        Cancel
                      </button>
                    )}
                  </header>

                  <Field label="From">
                    <DateField
                      value={termOn}
                      onChange={(iso) => { setTermOn(iso); setTermError(null); }}
                      placeholder="Pick a day"
                    />
                  </Field>

                  <Field label="Credit limit">
                    <div className="rupee-input">
                      <span>₹</span>
                      <TextInput
                        inputMode="decimal"
                        value={termLimit}
                        placeholder="Unchanged"
                        onChange={(e) => {
                          setTermLimit(amountChars(e.target.value));
                          setTermError(null);
                        }}
                        onBlur={() => setTermLimit(settleAmount(termLimit))}
                      />
                    </div>
                  </Field>

                  <Field label="Statement day">
                    <DayField
                      value={termStatement}
                      onChange={(day) => { setTermStatement(day); setTermError(null); }}
                      placeholder="Unchanged"
                    />
                  </Field>

                  <Field label="Payment due day" hint={dueNextMonth ? 'of the next month' : undefined}>
                    <DayField
                      value={termDue}
                      onChange={(day) => { setTermDue(day); setTermError(null); }}
                      placeholder="Unchanged"
                    />
                  </Field>

                  <Button tone="primary" icon={editingTerm ? 'check' : 'plus'} block onClick={recordTerm}>
                    {editingTerm ? 'Save' : 'Record'}
                  </Button>

                  {(termError || (!editing && pending.length > 0)) && (
                    <p className={`terms-foot ${termError ? 'is-error' : ''}`}>
                      {termError ?? `${pending.length} saved with the card`}
                    </p>
                  )}
                </section>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <div>
          <span className="field-label">Colour</span>
          <div className="swatch-row">
            {SWATCHES.map((s) => (
              <motion.button
                key={s}
                type="button"
                whileTap={{ scale: 0.9 }}
                className={`swatch-pick ${s === color ? 'is-active' : ''}`}
                style={{ background: s }}
                onClick={() => setColor(s)}
                aria-label={`Colour ${s}`}
              >
                {s === color && (
                  <motion.span layoutId="swatch-ring" className="swatch-ring" transition={spring} />
                )}
              </motion.button>
            ))}
          </div>
        </div>

        <div>
          <span className="field-label">Icon</span>
          <motion.div
            className="icon-row"
            variants={listVariants}
            initial="initial"
            animate="animate"
          >
            {ACCOUNT_ICONS.map((name) => (
              <motion.button
                key={name}
                type="button"
                variants={itemVariants}
                whileTap={{ scale: 0.92 }}
                className={`icon-pick ${name === icon ? 'is-active' : ''}`}
                style={name === icon ? { ['--pick' as any]: color } : undefined}
                onClick={() => setIcon(name)}
                aria-label={name}
              >
                <Icon name={name} size={17} />
              </motion.button>
            ))}
          </motion.div>
        </div>
      </div>

      <Confirm
        stacked
        open={confirming}
        title="Delete this account?"
        onConfirm={async () => {
          if (!editing) return;
          setConfirming(false);
          await deleteAccount(editing.id);
          onClose();
        }}
        onCancel={() => setConfirming(false)}
      >
        {editing?.name
          ? `${editing.name} goes, and every transaction in it goes too. This cannot be undone. Archive it instead to keep the history.`
          : 'Every transaction in it goes too. This cannot be undone.'}
      </Confirm>
    </Sheet>
  );
}
