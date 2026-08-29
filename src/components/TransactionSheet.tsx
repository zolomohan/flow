import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Icon } from './Icon';
import { DateField } from './DateField';
import {
  Button, Field, IconButton, Segmented, Select, Sheet, TextInput,
  type SegmentOption, type SelectOption,
} from './ui';
import { useStore } from '../lib/store';
import { paiseToRupeeString, rupeesToPaise, toLocalInput } from '../lib/format';
import { itemVariants, listVariants, spring } from '../lib/motion';
import type { Transaction, TransactionInput, TxKind } from '../lib/types';

const KINDS: SegmentOption<TxKind>[] = [
  { value: 'expense', label: 'Expense', icon: 'arrow-up-right', accent: 'var(--ink)' },
  { value: 'income', label: 'Income', icon: 'arrow-down-left', accent: 'var(--green)' },
  { value: 'transfer', label: 'Transfer', icon: 'arrow-left-right', accent: 'var(--blue)' },
];


export interface TxDraft {
  kind?: TxKind;
  accountId?: string;
  categoryId?: string;
}

export function TransactionSheet({
  open, onClose, editing, draft,
}: {
  open: boolean;
  onClose: () => void;
  editing?: Transaction | null;
  draft?: TxDraft;
}) {
  const { accounts, categories, saveTransaction, deleteTransaction, toast } = useStore();
  const live = useMemo(() => accounts.filter((a) => !a.archived), [accounts]);

  const [kind, setKind] = useState<TxKind>('expense');
  const [amount, setAmount] = useState('');
  const [accountId, setAccountId] = useState<string | null>(null);
  const [toAccountId, setToAccountId] = useState<string | null>(null);
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [merchant, setMerchant] = useState('');
  const [note, setNote] = useState('');
  const [occurredAt, setOccurredAt] = useState(toLocalInput());
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const amountRef = useRef<HTMLInputElement>(null);

  // Reset the form each time the sheet opens, from the edited row or the draft.
  useEffect(() => {
    if (!open) return;
    if (editing) {
      setKind(editing.kind);
      setAmount(paiseToRupeeString(editing.amount));
      setAccountId(editing.accountId);
      setToAccountId(editing.toAccountId);
      setCategoryId(editing.categoryId);
      setMerchant(editing.merchant);
      setNote(editing.note ?? '');
      setOccurredAt(editing.occurredAt.slice(0, 16));
    } else {
      setKind(draft?.kind ?? 'expense');
      setAmount('');
      setAccountId(draft?.accountId ?? live[0]?.id ?? null);
      setToAccountId(null);
      setCategoryId(draft?.categoryId ?? null);
      setMerchant('');
      setNote('');
      setOccurredAt(toLocalInput());
    }
    setError(null);
    const focus = window.setTimeout(() => amountRef.current?.focus(), 220);
    return () => window.clearTimeout(focus);
  }, [open, editing, draft, live]);

  // Categories only apply to one side of the ledger at a time.
  const palette = useMemo(
    () => categories.filter((c) => c.kind === (kind === 'income' ? 'income' : 'expense')),
    [categories, kind],
  );

  // One level of nesting: top-level groups, each with its own leaves.
  const groups = useMemo(() => {
    const tops = palette.filter((c) => !c.parentId);
    return tops.map((top) => ({
      ...top,
      children: palette.filter((c) => c.parentId === top.id),
    }));
  }, [palette]);

  const selected = palette.find((c) => c.id === categoryId) ?? null;
  const openGroupId = selected ? (selected.parentId ?? selected.id) : null;
  const openGroup = groups.find((g) => g.id === openGroupId) ?? null;

  useEffect(() => {
    if (kind === 'transfer') return;
    if (categoryId && !palette.some((c) => c.id === categoryId)) setCategoryId(null);
  }, [kind, palette, categoryId]);

  const accountOptions: SelectOption[] = live.map((a) => ({
    value: a.id,
    label: a.name,
    hint: a.institution ?? undefined,
    icon: a.icon,
    color: a.color,
  }));

  const swap = () => {
    setAccountId(toAccountId);
    setToAccountId(accountId);
  };

  const submit = async () => {
    const paise = rupeesToPaise(amount);
    if (!paise) return setError('Enter an amount.');
    if (!accountId) return setError('Pick an account.');
    if (kind === 'transfer' && !toAccountId) return setError('Pick a destination account.');
    if (kind === 'transfer' && toAccountId === accountId)
      return setError('A transfer needs two different accounts.');

    const input: TransactionInput = {
      id: editing?.id ?? null,
      kind,
      amount: paise,
      accountId,
      toAccountId: kind === 'transfer' ? toAccountId : null,
      categoryId: kind === 'transfer' ? null : categoryId,
      merchant: merchant.trim(),
      note: note.trim() || null,
      occurredAt,
    };

    setSaving(true);
    try {
      await saveTransaction(input);
      toast(editing ? 'Transaction updated' : 'Transaction added');
      onClose();
    } catch {
      /* the store already raised an error toast */
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!editing) return;
    await deleteTransaction(editing.id);
    toast('Transaction deleted');
    onClose();
  };

  const accentVar =
    kind === 'income' ? 'var(--green)' : kind === 'transfer' ? 'var(--blue)' : 'var(--ink)';

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={editing ? 'Edit transaction' : 'New transaction'}
      subtitle={
        kind === 'transfer'
          ? 'Moving money between your own accounts'
          : kind === 'income'
            ? 'Money landing in an account'
            : 'Money leaving an account'
      }
      width={560}
      footer={
        <>
          {editing ? (
            <Button tone="danger" icon="trash-2" onClick={remove}>
              Delete
            </Button>
          ) : (
            <span className="foot-hint">
              <kbd>⌘</kbd>
              <kbd>↵</kbd> to save
            </span>
          )}
          <div className="foot-actions">
            <Button tone="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button tone="primary" onClick={submit} disabled={saving}>
              {editing ? 'Save changes' : 'Add transaction'}
            </Button>
          </div>
        </>
      }
    >
      <div
        className="tx-form"
        style={{ ['--accent' as any]: accentVar }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit();
        }}
      >
        <Segmented options={KINDS} value={kind} onChange={setKind} name="tx-kind" size="lg" />

        <div className="amount-well">
          <span className="amount-symbol">₹</span>
          <input
            ref={amountRef}
            className="amount-input"
            inputMode="decimal"
            placeholder="0"
            value={amount}
            onChange={(e) => {
              setAmount(e.target.value.replace(/[^0-9.]/g, ''));
              setError(null);
            }}
          />
        </div>

        <AnimatePresence>
          {error && (
            <motion.p
              className="form-error"
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
            >
              <Icon name="alert-circle" size={14} />
              {error}
            </motion.p>
          )}
        </AnimatePresence>

        <div className="tx-accounts">
          <Field label={kind === 'income' ? 'Into account' : 'From account'}>
            <Select
              options={accountOptions}
              value={accountId}
              onChange={setAccountId}
              placeholder="Choose an account"
            />
          </Field>
          <AnimatePresence mode="popLayout">
            {kind === 'transfer' && (
              <motion.div
                key="to"
                className="tx-transfer-to"
                initial={{ opacity: 0, x: 12 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 12 }}
                transition={spring}
              >
                <IconButton icon="arrow-left-right" label="Swap accounts" onClick={swap} />
                <Field label="Into account">
                  <Select
                    options={accountOptions.filter((o) => o.value !== accountId)}
                    value={toAccountId}
                    onChange={setToAccountId}
                    placeholder="Choose an account"
                  />
                </Field>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <AnimatePresence mode="popLayout">
          {kind !== 'transfer' && (
            <motion.div
              key="category"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={spring}
              style={{ overflow: 'hidden' }}
            >
              <span className="field-label">
                Category
                {selected && <span className="field-hint">{selected.name}</span>}
              </span>
              <motion.div
                className="cat-grid"
                variants={listVariants}
                initial="initial"
                animate="animate"
              >
                {groups.map((group) => {
                  const active = group.id === categoryId;
                  const inside = group.id === openGroupId;
                  return (
                    <motion.button
                      key={group.id}
                      type="button"
                      variants={itemVariants}
                      whileTap={{ scale: 0.95 }}
                      className={`cat-chip ${active ? 'is-active' : ''} ${
                        inside && !active ? 'is-inside' : ''
                      }`}
                      style={{ ['--cat' as any]: group.color }}
                      onClick={() => setCategoryId(active ? null : group.id)}
                    >
                      <span className="cat-glyph">
                        <Icon name={group.icon} size={15} strokeWidth={2.1} />
                      </span>
                      {group.name}
                      {group.children.length > 0 && (
                        <span className="cat-count">{group.children.length}</span>
                      )}
                      {active && (
                        <motion.span
                          layoutId="cat-ring"
                          className="cat-ring"
                          transition={spring}
                        />
                      )}
                    </motion.button>
                  );
                })}
              </motion.div>

              <AnimatePresence mode="popLayout">
                {openGroup && openGroup.children.length > 0 && (
                  <motion.div
                    key={openGroup.id}
                    className="cat-sub"
                    style={{ ['--cat' as any]: openGroup.color }}
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={spring}
                  >
                    <div className="cat-sub-inner">
                      <span className="cat-sub-label">In {openGroup.name}</span>
                      <div className="cat-sub-chips">
                        {openGroup.children.map((child) => {
                          const active = child.id === categoryId;
                          return (
                            <button
                              key={child.id}
                              type="button"
                              className={`cat-sub-chip ${active ? 'is-active' : ''}`}
                              style={{ ['--cat' as any]: child.color }}
                              onClick={() => setCategoryId(active ? openGroup.id : child.id)}
                            >
                              <Icon name={child.icon} size={13} strokeWidth={2.2} />
                              {child.name}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          )}
        </AnimatePresence>

        <Field label={kind === 'transfer' ? 'Description' : 'Merchant or payee'}>
          <TextInput
            value={merchant}
            placeholder={kind === 'income' ? 'Monthly salary' : 'Swiggy'}
            onChange={(e) => setMerchant(e.target.value)}
          />
        </Field>

        <Field label="When">
          <div className="when-row">
            <DateField
              value={occurredAt.slice(0, 10)}
              onChange={(iso) => setOccurredAt(`${iso}T${occurredAt.slice(11, 16) || '12:00'}`)}
            />
            <TextInput
              type="time"
              className="time-input"
              value={occurredAt.slice(11, 16)}
              onChange={(e) =>
                setOccurredAt(`${occurredAt.slice(0, 10)}T${e.target.value || '12:00'}`)
              }
            />
          </div>
        </Field>

        <Field label="Note" hint="optional">
          <TextInput
            value={note}
            placeholder="Anything worth remembering"
            onChange={(e) => setNote(e.target.value)}
          />
        </Field>
      </div>
    </Sheet>
  );
}
