import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Icon } from './Icon';
import { DateField } from './DateField';
import { TransactionPicker } from './TransactionPicker';
import {
  Button, Confirm, Field, OptionRail, Segmented, Select, Sheet, Switch, TextInput,
  type SegmentOption, type SelectOption,
} from './ui';
import { useStore } from '../lib/store';
import { popover } from '../lib/motion';
import {
  amountChars, dayLabel, money, paiseToRupeeString, rupeesToPaise, settleAmount, toLocalInput,
} from '../lib/format';
import type { Debt, DebtDirection, DebtPayment } from '../lib/types';

/** How the money itself is accounted for, if at all. */
type RecordWay = 'none' | 'link' | 'write';

const RECORD_WAYS: SegmentOption<RecordWay>[] = [
  { value: 'none', label: 'Not recorded', icon: 'circle-dashed' },
  { value: 'link', label: 'Link a record', icon: 'link' },
  { value: 'write', label: 'Add record', icon: 'plus' },
];

const DIRECTIONS: SegmentOption<DebtDirection>[] = [
  { value: 'lent', label: 'I lent', icon: 'arrow-up-right', accent: 'var(--green)' },
  { value: 'borrowed', label: 'I borrowed', icon: 'arrow-down-left', accent: 'var(--amber)' },
];

export function DebtSheet({
  open, onClose, editing, seedDirection, onOpenTransaction,
}: {
  open: boolean;
  onClose: () => void;
  editing?: Debt | null;
  seedDirection?: DebtDirection;
  /** Opens the posting this debt names, when it names one. */
  onOpenTransaction?: (id: string) => void;
}) {
  const { debts, accounts, saveDebt, saveTransaction, toast } = useStore();
  const live = useMemo(() => accounts.filter((a) => !a.archived && !a.system), [accounts]);
  const holding = useMemo(() => accounts.find((a) => a.system), [accounts]);
  const accountOptions: SelectOption[] = live.map((a) => ({
    value: a.id,
    label: a.name,
    hint: a.institution ?? undefined,
    icon: a.icon,
    color: a.color,
  }));

  const [direction, setDirection] = useState<DebtDirection>('lent');
  const [counterparty, setCounterparty] = useState('');
  const [amount, setAmount] = useState('');
  const [openedOn, setOpenedOn] = useState(toLocalInput().slice(0, 10));
  const [dueOn, setDueOn] = useState('');
  const [note, setNote] = useState('');
  const [txId, setTxId] = useState<string | null>(null);
  const [txLabel, setTxLabel] = useState<string | null>(null);
  const [settled, setSettled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // How this debt meets the ledger: not at all, by pointing at a posting that
  // is already there, or by writing one on save from what is on this form.
  const [recordWay, setRecordWay] = useState<RecordWay>('none');
  const [writeAccount, setWriteAccount] = useState<string | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);
  // Whether the names already in the book are on offer under the field.
  const [suggesting, setSuggesting] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (editing) {
      setDirection(editing.direction);
      setCounterparty(editing.counterparty);
      setAmount(paiseToRupeeString(editing.principal));
      setOpenedOn(editing.openedOn.slice(0, 10));
      setDueOn(editing.dueOn?.slice(0, 10) ?? '');
      setNote(editing.note ?? '');
      setTxId(editing.transactionId);
      setTxLabel(editing.transactionLabel);
      setSettled(!!editing.settledAt);
    } else {
      setDirection(seedDirection ?? 'lent');
      setCounterparty('');
      setAmount('');
      setOpenedOn(toLocalInput().slice(0, 10));
      setDueOn('');
      setNote('');
      setTxId(null);
      setTxLabel(null);
      setSettled(false);
    }
    setRecordWay(editing?.transactionId ? 'link' : 'none');
    setWriteAccount(null);
    setWriteError(null);
    setError(null);
  }, [open, editing, seedDirection]);

  /** Names already in use, so repeat counterparties autocomplete. */
  const known = useMemo(
    () => [...new Set(debts.map((d) => d.counterparty))].sort(),
    [debts],
  );

  // What is worth offering: the names this one could still turn into. A name
  // already typed in full is not a suggestion, it is what you have.
  const suggestions = useMemo(() => {
    const term = counterparty.trim().toLowerCase();
    return known
      .filter((name) => name.toLowerCase().includes(term) && name.toLowerCase() !== term)
      .slice(0, 6);
  }, [known, counterparty]);

  // Writing the record is for a debt being entered now: an edit that offered
  // it would write a second debt beside the one being changed, since the
  // posting carries its own.
  const ways = useMemo(
    () => (editing ? RECORD_WAYS.filter((way) => way.value !== 'write') : RECORD_WAYS),
    [editing],
  );

  const submit = async () => {
    const principal = rupeesToPaise(amount);
    if (!counterparty.trim()) return setError('Who is this debt with?');
    if (principal <= 0) return setError('Enter an amount.');
    if (recordWay === 'write' && !writeAccount)
      return setWriteError('Which account did the money move through?');

    // Written with its own record, the posting carries the debt: one save,
    // and the two cannot drift apart afterwards.
    //
    // Either way it is a transfer, never spending or earning. Money handed
    // over has not left your books — it is out with the person — and money
    // borrowed is not something you earned. Both run against the account that
    // stands for what is out with people, which the book fills in from the
    // debt itself: lending leaves this account for it, borrowing arrives from
    // it.
    if (recordWay === 'write' && writeAccount) {
      await saveTransaction({
        kind: 'transfer',
        amount: principal,
        accountId: writeAccount,
        toAccountId: null,
        categoryId: null,
        merchant: counterparty.trim(),
        note: note.trim() || null,
        occurredAt: `${openedOn}T12:00`,
        shares: [{
          direction,
          counterparty: counterparty.trim(),
          amount: principal,
          dueOn: dueOn || null,
          note: note.trim() || null,
        }],
      });
      toast('Debt added');
      onClose();
      return;
    }

    await saveDebt({
      id: editing?.id ?? null,
      direction,
      counterparty: counterparty.trim(),
      principal,
      openedOn,
      dueOn: dueOn || null,
      note: note.trim() || null,
      transactionId: recordWay === 'link' ? txId : null,
      settled,
    });
    onClose();
  };

  const accent = direction === 'lent' ? 'var(--green)' : 'var(--amber)';

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={editing ? 'Edit debt' : 'New debt'}
      subtitle={
        direction === 'lent'
          ? 'Money you are owed'
          : 'Money you owe someone else'
      }
      width={520}
      footer={
        <>
          <span />
          <div className="foot-actions">
            <Button tone="ghost" onClick={onClose}>Cancel</Button>
            <Button tone="primary" onClick={submit}>
              {editing ? 'Save changes' : 'Add debt'}
            </Button>
          </div>
        </>
      }
    >
      <div className="account-form" style={{ ['--accent' as any]: accent }}>
        <Segmented
          options={DIRECTIONS}
          value={direction}
          onChange={setDirection}
          name="debt-direction"
          size="lg"
        />

        <div className="tx-meta">
          <Field label={direction === 'lent' ? 'Lent to' : 'Borrowed from'} error={error}>
            {/* The browser's own datalist drew a menu of its own — its font,
                its colours, its idea of a highlight — which is why the names
                were barely legible against this sheet. This is the same
                listbox the rest of the app opens. */}
            <div className="suggest">
              <TextInput
                value={counterparty}
                placeholder="Suhruth"
                autoComplete="off"
                onChange={(e) => {
                  setCounterparty(e.target.value);
                  setSuggesting(true);
                  setError(null);
                }}
                onFocus={() => setSuggesting(true)}
                onBlur={() => setSuggesting(false)}
                onKeyDown={(e) => e.key === 'Escape' && setSuggesting(false)}
              />
              <AnimatePresence>
                {suggesting && suggestions.length > 0 && (
                  <motion.div
                    className="select-menu suggest-menu"
                    variants={popover}
                    initial="initial"
                    animate="animate"
                    exit="exit"
                  >
                    {suggestions.map((name) => (
                      <button
                        key={name}
                        type="button"
                        className="select-option"
                        // Taking the click without taking the focus: a blur
                        // would close the menu out from under the pointer.
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => {
                          setCounterparty(name);
                          setSuggesting(false);
                          setError(null);
                        }}
                      >
                        <Icon name="user-round" size={14} />
                        <span className="select-option-label">{name}</span>
                      </button>
                    ))}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </Field>
          <Field label="Amount">
            <div className="rupee-input">
              <span>₹</span>
              <TextInput
                inputMode="decimal"
                value={amount}
                placeholder="0"
                onChange={(e) => {
                  setAmount(amountChars(e.target.value));
                  setError(null);
                }}
                onBlur={() => setAmount(settleAmount(amount))}
              />
            </div>
          </Field>
        </div>

        <div className="tx-meta">
          <Field label="Opened on">
            <DateField value={openedOn} onChange={setOpenedOn} />
          </Field>
          <Field label="Due" hint="optional">
            <DateField value={dueOn} onChange={setDueOn} placeholder="No due date" allowClear />
          </Field>
        </div>

        <Field label="Note" hint="optional">
          <TextInput
            value={note}
            placeholder="What it was for"
            onChange={(e) => setNote(e.target.value)}
          />
        </Field>

        {/* One question with three answers, rather than a link button and a
            tick box that half contradict each other: a debt either stands
            outside the ledger, points at a posting already in it, or writes
            the one it names on the way in. */}
        <div className="debt-record">
          <span className="field-label">The money itself</span>
          <Segmented
            options={ways}
            value={recordWay}
            onChange={(next) => { setRecordWay(next); setWriteError(null); }}
            name="debt-record"
            size="sm"
          />
          {/* The three answers are different heights. The sheet carries the
              change now — its canvas is measured — so this only has to bring
              the new answer in behind it. */}
          <div>
            <motion.div
              key={recordWay}
              className="debt-record-panel"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2, delay: 0.04, ease: [0.22, 1, 0.36, 1] }}
            >
              {recordWay === 'none' && (
                <p className="page-note is-quiet">
                  <Icon name="circle-dashed" size={13} />
                  The debt is kept, and nothing goes into the ledger. For money
                  that changed hands in cash, or a debt from before you started
                  keeping this book.
                </p>
              )}

              {recordWay === 'link' && (
                <TransactionPicker
                  value={txId}
                  label={txLabel}
                  title={
                    direction === 'lent'
                      ? 'Which record was the money you lent?'
                      : 'Which record was the money you borrowed?'
                  }
                  subtitle="Search and filter your whole ledger"
                  browseLabel="Link record"
                  onChange={(id, label) => { setTxId(id); setTxLabel(label); }}
                  onOpen={onOpenTransaction}
                />
              )}

              {recordWay === 'write' && (
                <>
                  <Field
                    label={direction === 'lent' ? 'Paid from' : 'Received into'}
                    error={writeError}
                  >
                    <OptionRail
                      options={accountOptions}
                      value={writeAccount}
                      onChange={(id) => { setWriteAccount(id); setWriteError(null); }}
                      empty="No open accounts yet."
                    />
                  </Field>
                  {/* What is about to be written, in the same words the row
                      will read in — so it is checked here rather than found
                      in the ledger afterwards. Only once there is something
                      to say: a form still being filled in does not need
                      telling what it is missing. */}
                  {writeAccount && rupeesToPaise(amount) > 0 && (
                    <p className="page-note">
                      <Icon name="pencil" size={13} />
                      <span>
                        {direction === 'lent' ? (
                          <>
                            Saving this moves {money(rupeesToPaise(amount))} out of{' '}
                            {live.find((a) => a.id === writeAccount)?.name ?? 'the account'} on{' '}
                            {dayLabel(openedOn)} and into {holding?.name ?? 'Debts'} — a
                            transfer, not spending — with {counterparty.trim() || 'their'} debt
                            standing against it.
                          </>
                        ) : (
                          <>
                            Saving this brings {money(rupeesToPaise(amount))} into{' '}
                            {live.find((a) => a.id === writeAccount)?.name ?? 'the account'} on{' '}
                            {dayLabel(openedOn)} from {holding?.name ?? 'Debts'} — a transfer,
                            not earnings — with what you owe {counterparty.trim() || 'them'}{' '}
                            standing against it.
                          </>
                        )}
                      </span>
                    </p>
                  )}
                </>
              )}
            </motion.div>
          </div>
        </div>

        {editing && (
          <Switch
            on={settled}
            onChange={setSettled}
            label="Settled"
            hint={
              editing.paid > 0
                ? `${money(editing.paid)} of ${money(editing.principal)} repaid`
                : 'nothing repaid yet'
            }
          />
        )}
      </div>
    </Sheet>

  );
}

/** Recording a repayment against an existing debt. */
export function DebtPaymentSheet({
  open, onClose, debt, editing, onOpenTransaction,
}: {
  open: boolean;
  onClose: () => void;
  debt: Debt | null;
  /** The repayment being changed, when one is. */
  editing?: DebtPayment | null;
  /** Opens the posting this repayment names, when it names one. */
  onOpenTransaction?: (id: string) => void;
}) {
  const { accounts, saveDebtPayment, deleteDebtPayment } = useStore();
  const [amount, setAmount] = useState('');
  const [occurredAt, setOccurredAt] = useState(toLocalInput().slice(0, 10));
  const [note, setNote] = useState('');
  const [txId, setTxId] = useState<string | null>(null);
  const [txLabel, setTxLabel] = useState<string | null>(null);
  // The account the money moved through, when the repayment should post a
  // transfer of its own rather than name one already in the book.
  const [cashId, setCashId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!open || !debt) return;
    // A repayment being changed opens as it stands; a new one opens on what
    // is left, which is what is usually being paid.
    setAmount(paiseToRupeeString(editing ? editing.amount : debt.outstanding));
    setOccurredAt((editing?.occurredAt ?? toLocalInput()).slice(0, 10));
    setNote(editing?.note ?? '');
    setTxId(editing?.transactionId ?? null);
    setTxLabel(editing?.transactionLabel ?? null);
    setCashId(editing?.cashAccountId ?? null);
    setError(null);
  }, [open, debt, editing]);

  if (!debt) return null;

  const submit = async () => {
    const value = rupeesToPaise(amount);
    if (value <= 0) return setError('Enter an amount.');
    await saveDebtPayment({
      id: editing?.id ?? null,
      debtId: debt.id,
      amount: value,
      occurredAt,
      note: note.trim() || null,
      transactionId: txId,
      cashAccountId: txId ? null : cashId,
    });
    onClose();
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={editing ? 'Edit repayment' : 'Record a repayment'}
      subtitle={
        editing
          ? `${debt.counterparty} · recorded ${dayLabel(editing.occurredAt)}`
          : debt.direction === 'lent'
            ? `${debt.counterparty} paying you back · ${money(debt.outstanding)} outstanding`
            : `Paying ${debt.counterparty} back · ${money(debt.outstanding)} outstanding`
      }
      width={470}
      footer={
        <>
          {editing ? (
            <Button tone="danger" icon="trash-2" onClick={() => setConfirming(true)}>
              Delete
            </Button>
          ) : (
            <span />
          )}
          <div className="foot-actions">
            <Button tone="ghost" onClick={onClose}>Cancel</Button>
            <Button tone="primary" onClick={submit}>
              {editing ? 'Save changes' : 'Record repayment'}
            </Button>
          </div>
        </>
      }
    >
      <div className="account-form">
        <div className="tx-meta">
          <Field label="Amount" error={error}>
            <div className="rupee-input">
              <span>₹</span>
              <TextInput
                autoFocus
                inputMode="decimal"
                value={amount}
                placeholder="0"
                onChange={(e) => {
                  setAmount(amountChars(e.target.value));
                  setError(null);
                }}
                onBlur={() => setAmount(settleAmount(amount))}
              />
            </div>
          </Field>
          <Field label="When">
            <DateField value={occurredAt} onChange={setOccurredAt} />
          </Field>
        </div>

        <Field label="Note" hint="optional">
          <TextInput
            value={note}
            placeholder="Anything worth remembering"
            onChange={(e) => setNote(e.target.value)}
          />
        </Field>

        {/* Where the money went, in one of two ways: post a transfer for it
            now, or name the posting that already recorded it. Both would be
            the same money twice, so choosing one puts the other away. */}
        {!txId && (
          <Field
            label={debt.direction === 'lent' ? 'Money came into' : 'Money went out of'}
            hint="optional"
          >
            <Select
              options={accounts
                .filter((a) => !a.archived)
                .map((a) => ({
                  value: a.id,
                  label: a.name,
                  hint: a.institution ?? undefined,
                  icon: a.icon,
                  color: a.color,
                }))}
              value={cashId}
              onChange={setCashId}
              placeholder="Nothing posted to the ledger"
              allowClear
              searchable
              searchPlaceholder="Find an account"
            />
          </Field>
        )}

        {!cashId && (
          <div>
            <span className="field-label">
              Linked record
              <span className="field-hint">optional</span>
            </span>
            <TransactionPicker
              value={txId}
              label={txLabel}
              title="Which record was this repayment?"
              subtitle={`${debt.counterparty} · search and filter your whole ledger`}
              onChange={(id, label) => { setTxId(id); setTxLabel(label); }}
              onOpen={onOpenTransaction}
            />
          </div>
        )}
      </div>

      <Confirm
        stacked
        open={confirming}
        title="Delete this repayment?"
        onConfirm={async () => {
          if (!editing) return;
          setConfirming(false);
          await deleteDebtPayment(editing.id);
          onClose();
        }}
        onCancel={() => setConfirming(false)}
      >
        {editing
          ? `${money(editing.amount)} comes off what has been repaid, and the debt stands that much higher again. Any posting behind it stays in your ledger.`
          : 'The debt stands that much higher again.'}
      </Confirm>
    </Sheet>
  );
}
