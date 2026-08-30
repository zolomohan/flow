import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Icon } from './Icon';
import { DateField } from './DateField';
import {
  Button, Field, IconButton, Segmented, Select, Sheet, TextInput,
  type SegmentOption, type SelectOption,
} from './ui';
import {
  SplitLinesEditor, SplitPeopleEditor, SplitSection,
  directionFor, emptyPeople, lineFromScratch, linesFor, linesToInput,
  peopleFor, peopleToInput, restOf, shareAmounts,
  type SplitLine, type SplitPeople,
} from './SplitEditors';
import { useStore } from '../lib/store';
import {
  amountChars, money, paiseToRupeeString, rupeesToPaise, settleAmount, sumPreview,
  toLocalInput,
} from '../lib/format';
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

/** Which split panel the sheet opens showing, when it was opened to split. */
export type SplitFocus = 'people' | 'categories';

export function TransactionSheet({
  open, onClose, editing, draft, splitFocus,
}: {
  open: boolean;
  onClose: () => void;
  editing?: Transaction | null;
  draft?: TxDraft;
  /** Set when the sheet was opened by the Split action rather than by a row. */
  splitFocus?: SplitFocus | null;
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
  const [lines, setLines] = useState<SplitLine[]>([]);
  const [people, setPeople] = useState<SplitPeople>(emptyPeople);
  // Both panels can be open at once. They divide the same bill along
  // different lines — one by category, one by who owes what — so opening the
  // second is no reason to fold the first away and forget it was there.
  const [panels, setPanels] = useState<SplitFocus[]>([]);
  // True while the category rows are still the halves the panel seeded and
  // nothing has been typed into them — so merely looking never splits a bill.
  const [seeded, setSeeded] = useState(false);
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
      setLines(linesFor(editing));
      setPeople(peopleFor(editing));
      setSeeded(false);
    } else {
      setKind(draft?.kind ?? 'expense');
      setAmount('');
      setAccountId(draft?.accountId ?? live[0]?.id ?? null);
      setToAccountId(null);
      setCategoryId(draft?.categoryId ?? null);
      setMerchant('');
      setNote('');
      setOccurredAt(toLocalInput());
      setLines([]);
      setPeople(emptyPeople());
      setSeeded(false);
    }
    // A panel opens by itself when there is already something in it, or when
    // the sheet was opened by the Split action rather than by the row.
    const showing = new Set<SplitFocus>();
    if (editing?.splits.length) showing.add('categories');
    if (editing?.shares.length) showing.add('people');
    if (splitFocus) showing.add(splitFocus);
    setPanels([...showing]);
    setError(null);
    const focus = window.setTimeout(() => amountRef.current?.focus(), 220);
    return () => window.clearTimeout(focus);
  }, [open, editing, draft, live, splitFocus]);

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

  // What the editors below divide up. Typing in the amount well re-cuts the
  // shares live, which is how a split is usually arrived at: the total lands
  // first, the company second.
  const paise = rupeesToPaise(amount);
  // What the sum in the well comes to, while it is still a sum.
  const typed = sumPreview(amount);
  // The parts always come to the bill — the last one takes whatever is left —
  // so the only thing that can go wrong is the typed ones overrunning it.
  const split = lines.length > 0;
  const rest = restOf(lines, paise);
  const shares = shareAmounts(people, paise);
  const owed = people.people.reduce(
    (sum, person, i) => sum + (person.you ? 0 : shares[i]),
    0,
  );

  // With the picker hidden, the collapsed panel is the only place the split's
  // categories are named — so it names them.
  const partNames = lines
    .map((l) => palette.find((c) => c.id === l.categoryId)?.name)
    .filter(Boolean)
    .join(', ');

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

  // Opening the categories panel on an unsplit bill seeds two halves rather
  // than two empty rows, so it starts balanced and is corrected downwards.
  // Closing it again without touching them puts the bill back as it was:
  // looking inside a panel is not the same as asking for a split.
  const togglePanel = (which: SplitFocus) => {
    const closing = panels.includes(which);
    setPanels(closing ? panels.filter((p) => p !== which) : [...panels, which]);
    if (which !== 'categories') return;
    if (closing) {
      if (seeded) {
        setLines([]);
        setSeeded(false);
      }
      return;
    }
    if (lines.length === 0) {
      // An empty first part and a rest holding the whole bill: you type what
      // one part came to and watch the rest come down, rather than being
      // handed a division nobody asked for.
      setLines([{ ...lineFromScratch(), categoryId }, lineFromScratch()]);
      setSeeded(true);
    }
  };

  const editLines = (next: SplitLine[]) => {
    setLines(next);
    setSeeded(false);
  };

  const submit = async () => {
    if (!paise) return setError('Enter an amount.');
    if (!accountId) return setError('Pick an account.');
    if (kind === 'transfer' && !toAccountId) return setError('Pick a destination account.');
    if (kind === 'transfer' && toAccountId === accountId)
      return setError('A transfer needs two different accounts.');

    // A transfer moves money between your own accounts, so there is nothing to
    // file under categories and nobody to owe a part of it.
    const parts = kind === 'transfer' ? [] : linesToInput(lines, paise);
    const owing = kind === 'transfer' ? [] : peopleToInput(people, paise, kind);
    if (kind !== 'transfer' && split && rest < 0)
      return setError(`The parts run ${money(-rest)} over the ${money(paise)} bill.`);
    if (parts.length === 1) return setError('A split needs at least two parts.');
    if (owed > paise)
      return setError(`The shares come to ${money(owed)} — more than the bill.`);

    const input: TransactionInput = {
      id: editing?.id ?? null,
      kind,
      amount: paise,
      accountId,
      toAccountId: kind === 'transfer' ? toAccountId : null,
      // A split bill has no single category of its own, but the ledger row
      // still needs a colour and a glyph — so it takes the largest part's.
      categoryId:
        kind === 'transfer'
          ? null
          : parts.length
            ? (parts.reduce((big, p) => (p.amount > big.amount ? p : big)).categoryId ??
               categoryId)
            : categoryId,
      merchant: merchant.trim(),
      note: note.trim() || null,
      occurredAt,
      splits: parts,
      shares: owing,
    };

    setSaving(true);
    try {
      await saveTransaction(input);
      toast(
        owing.length
          ? `${editing ? 'Transaction updated' : 'Transaction added'} · ${owing.length} ${
              owing.length === 1 ? 'debt' : 'debts'
            } ${directionFor(kind) === 'lent' ? 'owed to you' : 'you owe'}`
          : editing
            ? 'Transaction updated'
            : 'Transaction added',
      );
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
      width={900}
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
        className="tx-form is-two-pane"
        style={{ ['--accent' as any]: accentVar }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit();
        }}
      >
        {/* What the money did, and what it was for. The two columns are the
            two halves of the question — how much, out of where, under what —
            against the detail you may or may not bother filling in. */}
        <div className="tx-pane">
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
                setAmount(amountChars(e.target.value));
                setError(null);
              }}
              onBlur={() => setAmount(settleAmount(amount))}
            />
            {/* A bill is often three things added up. The answer shows as it is
                typed, and the sum settles into it when the field is left. */}
            <AnimatePresence>
              {typed !== null && (
                <motion.span
                  className="amount-sum"
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.14 }}
                >
                  = {money(Math.round(typed * 100))}
                </motion.span>
              )}
            </AnimatePresence>
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
            {kind !== 'transfer' && !split && (
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
        </div>

        <div className="tx-pane tx-pane-detail">
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

        {/* The split editors are rows of fields rather than a column of them,
            so they run the width of the form under both panes. */}
        <div className="tx-pane-wide">
          <AnimatePresence initial={false}>
            {kind !== 'transfer' && (
              <motion.div
                key="splits"
                className="split-panels"
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                transition={spring}
              >
                <SplitSection
                  icon="split"
                  title="Split transaction"
                  summary={
                    split
                      ? `${lines.length} parts of ${money(paise)} · ${partNames || 'pick categories'}`
                      : 'File one bill under more than one category'
                  }
                  open={panels.includes('categories')}
                  onToggle={() => togglePanel('categories')}
                >
                  <SplitLinesEditor
                    amount={paise}
                    kind={kind}
                    lines={lines}
                    onChange={editLines}
                  />
                </SplitSection>

                <SplitSection
                  icon="users"
                  title="Split with people"
                  summary={
                    owed > 0
                      ? `${people.people.length - 1} ${
                          people.people.length === 2 ? 'person' : 'people'
                        } · ${money(owed)} ${
                          directionFor(kind) === 'lent' ? 'owed back to you' : 'you owe them'
                        }`
                      : kind === 'income'
                        ? 'Owe part of this to the people it was for'
                        : 'Turn everyone else’s share into a debt they owe you'
                  }
                  open={panels.includes('people')}
                  onToggle={() => togglePanel('people')}
                >
                  <SplitPeopleEditor
                    amount={paise}
                    kind={kind}
                    split={people}
                    onChange={setPeople}
                  />
                </SplitSection>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </Sheet>
  );
}
