import { useEffect, useMemo, useState } from 'react';
import { Icon } from './Icon';
import { DateField } from './DateField';
import { TransactionPicker } from './TransactionPicker';
import { Button, Field, Segmented, Sheet, TextInput, type SegmentOption } from './ui';
import { useStore } from '../lib/store';
import {
  amountChars, money, paiseToRupeeString, rupeesToPaise, settleAmount, toLocalInput,
} from '../lib/format';
import type { Debt, DebtDirection } from '../lib/types';

const DIRECTIONS: SegmentOption<DebtDirection>[] = [
  { value: 'lent', label: 'I lent', icon: 'arrow-up-right', accent: 'var(--green)' },
  { value: 'borrowed', label: 'I borrowed', icon: 'arrow-down-left', accent: 'var(--amber)' },
];

export function DebtSheet({
  open, onClose, editing, seedDirection,
}: {
  open: boolean;
  onClose: () => void;
  editing?: Debt | null;
  seedDirection?: DebtDirection;
}) {
  const { debts, saveDebt, deleteDebt } = useStore();

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
  const [confirming, setConfirming] = useState(false);

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
    setError(null);
    setConfirming(false);
  }, [open, editing, seedDirection]);

  /** Names already in use, so repeat counterparties autocomplete. */
  const known = useMemo(
    () => [...new Set(debts.map((d) => d.counterparty))].sort(),
    [debts],
  );

  const submit = async () => {
    const principal = rupeesToPaise(amount);
    if (!counterparty.trim()) return setError('Who is this debt with?');
    if (principal <= 0) return setError('Enter an amount.');
    await saveDebt({
      id: editing?.id ?? null,
      direction,
      counterparty: counterparty.trim(),
      principal,
      openedOn,
      dueOn: dueOn || null,
      note: note.trim() || null,
      transactionId: txId,
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
          {editing ? (
            <Button
              tone="danger"
              icon="trash-2"
              onClick={async () => {
                if (!confirming) return setConfirming(true);
                await deleteDebt(editing.id);
                onClose();
              }}
            >
              {confirming ? 'Delete with its repayments?' : 'Delete'}
            </Button>
          ) : (
            <span />
          )}
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
            <TextInput
              list="debt-counterparties"
              value={counterparty}
              placeholder="Suhruth"
              onChange={(e) => { setCounterparty(e.target.value); setError(null); }}
            />
            <datalist id="debt-counterparties">
              {known.map((name) => <option key={name} value={name} />)}
            </datalist>
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

        <div>
          <span className="field-label">
            Linked record
            <span className="field-hint">optional — leave empty for older debts</span>
          </span>
          <TransactionPicker
            value={txId}
            label={txLabel}
            title={direction === 'lent' ? 'Which record was the money you lent?' : 'Which record was the money you borrowed?'}
            subtitle="Search and filter your whole ledger"
            onChange={(id, label) => { setTxId(id); setTxLabel(label); }}
          />
        </div>

        {editing && (
          <button
            type="button"
            className={`settle-toggle ${settled ? 'is-on' : ''}`}
            onClick={() => setSettled((v) => !v)}
          >
            <span className="settle-box">{settled && <Icon name="check" size={12} />}</span>
            Mark this debt settled
            <small>
              {editing.paid > 0
                ? `${money(editing.paid)} of ${money(editing.principal)} repaid`
                : 'nothing repaid yet'}
            </small>
          </button>
        )}
      </div>
    </Sheet>
  );
}

/** Recording a repayment against an existing debt. */
export function DebtPaymentSheet({
  open, onClose, debt,
}: { open: boolean; onClose: () => void; debt: Debt | null }) {
  const { saveDebtPayment } = useStore();
  const [amount, setAmount] = useState('');
  const [occurredAt, setOccurredAt] = useState(toLocalInput().slice(0, 10));
  const [note, setNote] = useState('');
  const [txId, setTxId] = useState<string | null>(null);
  const [txLabel, setTxLabel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !debt) return;
    setAmount(paiseToRupeeString(debt.outstanding));
    setOccurredAt(toLocalInput().slice(0, 10));
    setNote('');
    setTxId(null);
    setTxLabel(null);
    setError(null);
  }, [open, debt]);

  if (!debt) return null;

  const submit = async () => {
    const value = rupeesToPaise(amount);
    if (value <= 0) return setError('Enter an amount.');
    await saveDebtPayment({
      debtId: debt.id,
      amount: value,
      occurredAt,
      note: note.trim() || null,
      transactionId: txId,
    });
    onClose();
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Record a repayment"
      subtitle={
        debt.direction === 'lent'
          ? `${debt.counterparty} paying you back · ${money(debt.outstanding)} outstanding`
          : `Paying ${debt.counterparty} back · ${money(debt.outstanding)} outstanding`
      }
      width={470}
      footer={
        <>
          <span />
          <div className="foot-actions">
            <Button tone="ghost" onClick={onClose}>Cancel</Button>
            <Button tone="primary" onClick={submit}>Record repayment</Button>
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
          />
        </div>
      </div>
    </Sheet>
  );
}
