import { useEffect, useMemo, useState } from 'react';
import { Icon } from './Icon';
import { DateField } from './DateField';
import {
  Button, Confirm, Field, Segmented, Select, Sheet, TextArea, TextInput,
  type SelectOption,
} from './ui';
import { useStore } from '../lib/store';
import { CADENCES, cadenceSuffix } from '../lib/plans';
import {
  amountChars, money, paiseToRupeeString, rupeesToPaise, settleAmount,
} from '../lib/format';
import type { Plan, PlanCadence, TxKind } from '../lib/types';

/** Values a new plan can be opened with already filled in. */
export interface PlanDraft {
  name?: string;
  merchant?: string;
  kind?: TxKind;
  amount?: number;
  accountId?: string | null;
  categoryId?: string | null;
  cadence?: PlanCadence;
  anchorOn?: string;
  variable?: boolean;
  matchKey?: string | null;
}

const KINDS: { value: TxKind; label: string; icon: string; accent: string }[] = [
  { value: 'expense', label: 'Goes out', icon: 'arrow-up-right', accent: 'var(--red)' },
  { value: 'income', label: 'Comes in', icon: 'arrow-down-left', accent: 'var(--green)' },
  { value: 'transfer', label: 'Moves', icon: 'arrow-left-right', accent: 'var(--blue)' },
];

const todayIso = () => new Date().toISOString().slice(0, 10);

/**
 * Setting up a payment that comes round again.
 *
 * The form asks for the promise and nothing else — what, how much, how often,
 * from where. Whether any cycle was paid is never asked, because the ledger
 * already knows: the payee's name at the top is what the plan watches for.
 */
export function PlanSheet({
  open, onClose, editing, draft,
}: {
  open: boolean;
  onClose: () => void;
  editing: Plan | null;
  draft?: PlanDraft;
}) {
  const { accounts, categories, savePlan, deletePlan, setPlanArchived } = useStore();
  const [kind, setKind] = useState<TxKind>('expense');
  const [name, setName] = useState('');
  const [merchant, setMerchant] = useState('');
  const [amount, setAmount] = useState('');
  const [variable, setVariable] = useState(false);
  const [automatic, setAutomatic] = useState(true);
  const [cadence, setCadence] = useState<PlanCadence>('monthly');
  const [every, setEvery] = useState('1');
  const [anchorOn, setAnchorOn] = useState(todayIso);
  const [endsOn, setEndsOn] = useState('');
  const [accountId, setAccountId] = useState<string | null>(null);
  const [toAccountId, setToAccountId] = useState<string | null>(null);
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const live = useMemo(() => accounts.filter((a) => !a.archived), [accounts]);

  // Every opening starts from what it is about: the plan being changed, the
  // rhythm being adopted, or an empty form.
  useEffect(() => {
    if (!open) return;
    setError(null);
    setConfirming(false);
    if (editing) {
      setKind(editing.kind);
      setName(editing.name);
      setMerchant(editing.merchant);
      setAmount(paiseToRupeeString(editing.amount));
      setVariable(editing.variable);
      setAutomatic(editing.automatic);
      setCadence(editing.cadence);
      setEvery(String(editing.every));
      setAnchorOn(editing.anchorOn);
      setEndsOn(editing.endsOn ?? '');
      setAccountId(editing.accountId);
      setToAccountId(editing.toAccountId);
      setCategoryId(editing.categoryId);
      setNote(editing.note ?? '');
      return;
    }
    setKind(draft?.kind ?? 'expense');
    setName(draft?.name ?? '');
    setMerchant(draft?.merchant ?? draft?.name ?? '');
    setAmount(draft?.amount ? paiseToRupeeString(draft.amount) : '');
    setVariable(draft?.variable ?? false);
    setAutomatic(true);
    setCadence(draft?.cadence ?? 'monthly');
    setEvery('1');
    setAnchorOn(draft?.anchorOn ?? todayIso());
    setEndsOn('');
    setAccountId(draft?.accountId ?? live[0]?.id ?? null);
    setToAccountId(null);
    setCategoryId(draft?.categoryId ?? null);
    setNote('');
  }, [open, editing, draft, live]);

  const palette = useMemo(
    () => categories.filter((c) => c.kind === (kind === 'income' ? 'income' : 'expense')),
    [categories, kind],
  );

  // Groups stay headings; only what sits under one can be filed against.
  const categoryOptions: SelectOption[] = useMemo(() => {
    const tops = palette.filter((c) => !c.parentId);
    return tops.flatMap((top) => {
      const children = palette.filter((c) => c.parentId === top.id);
      const head: SelectOption = {
        value: top.id,
        label: top.name,
        icon: top.icon,
        color: top.color,
        heading: children.length > 0,
      };
      return [
        head,
        ...children.map<SelectOption>((child) => ({
          value: child.id,
          label: child.name,
          icon: child.icon,
          color: child.color,
          child: true,
          under: top.name,
        })),
      ];
    });
  }, [palette]);

  const accountOptions: SelectOption[] = live.map((a) => ({
    value: a.id,
    label: a.name,
    hint: a.institution ?? undefined,
    icon: a.icon,
    color: a.color,
  }));

  useEffect(() => {
    if (kind === 'transfer') return;
    if (categoryId && !palette.some((c) => c.id === categoryId)) setCategoryId(null);
  }, [kind, palette, categoryId]);

  const paise = rupeesToPaise(amount);
  const times = Math.max(1, Number(every) || 1);

  const submit = async () => {
    if (!name.trim()) return setError('What should this be called?');
    if (paise <= 0 && !variable) return setError('How much is it, roughly?');
    if (!accountId) return setError('Which account does this come out of?');
    if (kind === 'transfer' && !toAccountId) return setError('And where does it land?');
    try {
      await savePlan({
        id: editing?.id ?? null,
        name: name.trim(),
        kind,
        amount: paise,
        accountId,
        toAccountId: kind === 'transfer' ? toAccountId : null,
        categoryId: kind === 'transfer' ? null : categoryId,
        merchant: merchant.trim(),
        note: note.trim() || null,
        cadence,
        every: times,
        anchorOn,
        endsOn: endsOn || null,
        automatic,
        variable,
        matchKey: editing?.matchKey ?? draft?.matchKey ?? null,
        archived: editing?.archived ?? false,
      });
      onClose();
    } catch {
      /* the store has already said so */
    }
  };

  const remove = async () => {
    if (!editing) return;
    await deletePlan(editing.id);
    setConfirming(false);
    onClose();
  };

  return (
    <>
      <Sheet
        open={open}
        onClose={onClose}
        width={560}
        title={editing ? editing.name : 'New planned payment'}
        subtitle={
          editing
            ? `${money(editing.amount)} ${cadenceSuffix(editing.cadence, editing.every)}`
            : 'Something that comes round again — a rent, a subscription, a salary.'
        }
        footer={
          <>
            <div className="foot-lead">
              {editing && (
                <>
                  <Button tone="danger" icon="trash-2" onClick={() => setConfirming(true)}>
                    Delete
                  </Button>
                  <Button
                    tone="ghost"
                    icon={editing.archived ? 'undo-2' : 'circle-dashed'}
                    onClick={async () => {
                      await setPlanArchived(editing.id, !editing.archived);
                      onClose();
                    }}
                  >
                    {editing.archived ? 'Bring back' : 'Put away'}
                  </Button>
                </>
              )}
            </div>
            <div className="foot-actions">
              <Button tone="ghost" onClick={onClose}>Cancel</Button>
              <Button tone="primary" onClick={submit}>
                {editing ? 'Save changes' : 'Start tracking'}
              </Button>
            </div>
          </>
        }
      >
        <div className="account-form">
          <Segmented options={KINDS} value={kind} onChange={setKind} name="plan-kind" />

          <div className="tx-meta">
            <Field label="Name" error={error}>
              <TextInput
                autoFocus
                value={name}
                placeholder="Netflix"
                onChange={(e) => {
                  const next = e.target.value;
                  // On a new plan the payee starts out following the name,
                  // which saves typing the same word twice. It stops the
                  // moment either is touched on its own, and on a plan that
                  // already exists it never happens at all: the name is a
                  // label, and nothing about a plan should turn on it.
                  if (!editing && merchant === name) setMerchant(next);
                  setName(next);
                  setError(null);
                }}
              />
            </Field>
            <Field label="Amount" hint={variable ? 'roughly' : undefined}>
              <div className="rupee-input">
                <span>₹</span>
                <TextInput
                  inputMode="decimal"
                  value={amount}
                  placeholder="0"
                  onChange={(e) => { setAmount(amountChars(e.target.value)); setError(null); }}
                  onBlur={() => setAmount(settleAmount(amount))}
                />
              </div>
            </Field>
          </div>

          <div className="tx-meta">
            <Field label="How often">
              <Select
                options={CADENCES.map((c) => ({
                  value: c.value,
                  label: c.label,
                  icon: 'repeat',
                  color: 'var(--ink-3)',
                }))}
                value={cadence}
                onChange={(v) => setCadence((v as PlanCadence) ?? 'monthly')}
              />
            </Field>
            <Field label="Every" hint={`${CADENCES.find((c) => c.value === cadence)?.noun ?? ''}s`}>
              <TextInput
                inputMode="numeric"
                value={every}
                onChange={(e) => setEvery(e.target.value.replace(/[^0-9]/g, ''))}
                onBlur={() => setEvery(String(times))}
              />
            </Field>
          </div>

          <div className="tx-meta">
            <Field label="Falls due on" hint="any date it lands on; the rest follow">
              <DateField value={anchorOn} onChange={setAnchorOn} />
            </Field>
            <Field label="Until" hint="optional">
              <DateField
                value={endsOn}
                onChange={setEndsOn}
                placeholder="Runs on"
                allowClear
              />
            </Field>
          </div>

          <div className="tx-meta">
            <Field
              label={kind === 'income' ? 'Usually lands in' : 'Usually paid from'}
              hint={kind === 'transfer' ? undefined : 'payments count from any account'}
            >
              <Select
                options={accountOptions}
                value={accountId}
                onChange={setAccountId}
                placeholder="Pick an account"
              />
            </Field>
            {kind === 'transfer' ? (
              <Field label="Into">
                <Select
                  options={accountOptions.filter((o) => o.value !== accountId)}
                  value={toAccountId}
                  onChange={setToAccountId}
                  placeholder="Pick an account"
                />
              </Field>
            ) : (
              <Field label="Category">
                <Select
                  options={categoryOptions}
                  value={categoryId}
                  onChange={setCategoryId}
                  placeholder="Uncategorised"
                  allowClear
                  searchable
                />
              </Field>
            )}
          </div>

          <Field
            label="Payee"
            hint="written on payments this plan makes"
          >
            <TextInput
              value={merchant}
              placeholder={name || 'Netflix'}
              onChange={(e) => setMerchant(e.target.value)}
            />
            <p className="plan-matches">
              What this plan has been paid is whatever you link to it — the
              payee only shapes which postings it offers you first.
            </p>
          </Field>

          <div className="plan-flags">
            <button
              type="button"
              className={`settle-toggle ${automatic ? 'is-on' : ''}`}
              onClick={() => setAutomatic((v) => !v)}
            >
              <span className="settle-box">{automatic && <Icon name="check" size={12} />}</span>
              It pays itself
              <small>{automatic ? 'a mandate or standing instruction' : 'you go and pay it'}</small>
            </button>
            <button
              type="button"
              className={`settle-toggle ${variable ? 'is-on' : ''}`}
              onClick={() => setVariable((v) => !v)}
            >
              <span className="settle-box">{variable && <Icon name="check" size={12} />}</span>
              The amount moves
              <small>{variable ? 'a bill, not a fixed price' : 'the same every time'}</small>
            </button>
          </div>

          <Field label="Note" hint="optional">
            <TextArea
              value={note}
              placeholder="Family plan, renews in March"
              onChange={(e) => setNote(e.target.value)}
            />
          </Field>
        </div>
      </Sheet>

      <Confirm
        stacked
        open={confirming}
        onCancel={() => setConfirming(false)}
        onConfirm={remove}
        title={`Delete ${editing?.name ?? 'this plan'}?`}
        confirmLabel="Delete plan"
      >
        The plan goes. Every payment it has been watching stays exactly where
        it is in the ledger — this only stops Midas expecting the next one.
      </Confirm>
    </>
  );
}
