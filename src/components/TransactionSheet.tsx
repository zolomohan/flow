import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Icon } from './Icon';
import { DateField } from './DateField';
import {
  Button, Field, IconButton, Segmented, Select, Sheet, TextInput,
  type SegmentOption, type SelectOption,
} from './ui';
import {
  SplitLinesEditor, SplitPeopleEditor, SplitMenu,
  directionFor, emptyPeople, lineFromScratch, linesFor, linesToInput,
  peopleFor, peopleToInput, restOf, shareAmounts,
  type SplitLine, type SplitPeople,
} from './SplitEditors';
import { LAST_ACCOUNT, REQUIRE_NOTE, useStore } from '../lib/store';
import {
  amountChars, money, paiseToRupeeString, rupeesToPaise, settleAmount, sumPreview,
  toLocalInput,
} from '../lib/format';
import { itemVariants, listVariants, pageVariants, spring } from '../lib/motion';
import type { Category, Transaction, TransactionInput, TxKind } from '../lib/types';

/**
 * Adding a sub-category from the sheet itself. Filing a bill is exactly when
 * you find out the category you want doesn't exist, and going to another
 * screen to make it means losing the half-typed transaction you were on.
 */
function NewSubCategory({
  group, onAdded,
}: {
  group: Category;
  onAdded: (categoryId: string) => void;
}) {
  const { saveCategory } = useStore();
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (naming) field.current?.focus();
  }, [naming]);

  const add = async () => {
    const trimmed = name.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    try {
      // A sub-category takes its group's colour whatever is asked for, and
      // there is nowhere here to pick an icon — the group's reads honestly
      // until it is given one of its own.
      const made = await saveCategory({
        id: null,
        kind: group.kind,
        name: trimmed,
        icon: group.icon,
        color: group.color,
        parentId: group.id,
      });
      onAdded(made.id);
      setName('');
      setNaming(false);
    } catch {
      /* the store has already said what went wrong */
    } finally {
      setSaving(false);
    }
  };

  if (!naming) {
    return (
      <button
        type="button"
        className="cat-sub-chip is-new"
        onClick={() => setNaming(true)}
        title={`Add a sub-category under ${group.name}`}
      >
        <Icon name="plus" size={13} strokeWidth={2.4} />
        New
      </button>
    );
  }

  return (
    <span className="cat-sub-new">
      <input
        ref={field}
        className="input"
        value={name}
        placeholder={`Under ${group.name}`}
        disabled={saving}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => !name.trim() && setNaming(false)}
        onKeyDown={(e) => {
          // Enter is the sheet's own save; here it names the category.
          e.stopPropagation();
          if (e.key === 'Enter') {
            e.preventDefault();
            void add();
          }
          if (e.key === 'Escape') {
            e.preventDefault();
            setName('');
            setNaming(false);
          }
        }}
      />
      <IconButton icon="check" label="Add it" size={28} onClick={() => void add()} />
    </span>
  );
}

/** The label that isn't there yet. Pinning is when you find out one is
 *  missing, so it can be made here rather than on the Labels screen. */
function NewLabel({ onAdded }: { onAdded: (labelId: string) => void }) {
  const { saveLabel, labels } = useStore();
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (naming) field.current?.focus();
  }, [naming]);

  const add = async () => {
    const trimmed = name.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    try {
      // Colours cycle through the palette, so a label made in a hurry still
      // comes out distinct from the ones already there.
      const made = await saveLabel({
        id: null,
        name: trimmed,
        color: LABEL_SWATCHES[labels.length % LABEL_SWATCHES.length],
      });
      onAdded(made.id);
      setName('');
      setNaming(false);
    } catch {
      /* the store has already said what went wrong */
    } finally {
      setSaving(false);
    }
  };

  if (!naming) {
    return (
      <button
        type="button"
        className="chip is-new"
        onClick={() => setNaming(true)}
        title="Make a label"
      >
        <Icon name="plus" size={12} strokeWidth={2.4} />
        New
      </button>
    );
  }

  return (
    <span className="cat-sub-new">
      <input
        ref={field}
        className="input"
        value={name}
        placeholder="Name it"
        disabled={saving}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => !name.trim() && setNaming(false)}
        onKeyDown={(e) => {
          // Enter is the sheet's own save; here it names the label.
          e.stopPropagation();
          if (e.key === 'Enter') {
            e.preventDefault();
            void add();
          }
          if (e.key === 'Escape') {
            e.preventDefault();
            setName('');
            setNaming(false);
          }
        }}
      />
      <IconButton icon="check" label="Add it" size={28} onClick={() => void add()} />
    </span>
  );
}

/** The palette the Labels screen offers, so one made in passing matches. */
const LABEL_SWATCHES = [
  '#F2724F', '#42C251', '#118AE4', '#A855F7', '#F0B429', '#5A87E6',
  '#EC4899', '#8B5CF6', '#06B6D4', '#0EA5E9', '#14B8A6', '#676B89',
];

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

/**
 * Which page the sheet opens on, when it was opened to divide a bill rather
 * than to read it. `debt` is the people page with nobody's share reserved:
 * the whole of the posting becomes a debt in one person's name.
 */
export type SplitFocus = 'people' | 'categories' | 'debt';

export function TransactionSheet({
  open, onClose, editing, draft, splitFocus, onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  editing?: Transaction | null;
  draft?: TxDraft;
  /** Set when the sheet was opened by the Split action rather than by a row. */
  splitFocus?: SplitFocus | null;
  /**
   * Takes the finished input instead of the book: the sheet edits something
   * that is not a posting yet — a statement row waiting to import — and the
   * caller decides what becomes of it. Nothing is saved and nothing can be
   * deleted while this is set.
   */
  onSubmit?: (input: TransactionInput) => void;
}) {
  const {
    accounts, categories, labels, saveTransaction, deleteTransaction, toast, settings,
    saveSetting,
  } = useStore();
  const live = useMemo(() => accounts.filter((a) => !a.archived), [accounts]);
  // A book can ask for a note on everything new. What is already in it stays
  // as it is — the rule is about what you are writing down now.
  // Anything without an id of its own is being written now, whatever the
  // sheet was opened with — a statement row waiting to import is opened on
  // a pretend posting, and it is as new as anything typed from scratch.
  const isNew = !editing?.id;
  const needsNote = settings[REQUIRE_NOTE] === '1' && isNew;

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
  const [labelIds, setLabelIds] = useState<string[]>([]);
  // Dividing a bill is a job of its own — a screenful of rows, each with a
  // category or a person on it — so it gets a page of the sheet rather than a
  // drawer under the form. Null is the transaction itself.
  const [page, setPage] = useState<SplitFocus | null>(null);
  // Which way the pages should travel: in to a split, or back out of one.
  const [back, setBack] = useState(false);
  // True while the category rows are still the halves the panel seeded and
  // nothing has been typed into them — so merely looking never splits a bill.
  const [seeded, setSeeded] = useState(false);
  const amountRef = useRef<HTMLInputElement>(null);
  // Read through a ref rather than a dependency: writing the setting must
  // not re-run the reset below and wipe a form that is being filled in.
  const lastAccount = useRef<string | null>(null);
  lastAccount.current = settings[LAST_ACCOUNT] ?? null;

  // Reset the form each time the sheet opens, from the edited row or the draft.
  useEffect(() => {
    if (!open) return;
    const carried = editing ? linesFor(editing) : [];
    if (editing) {
      setKind(editing.kind);
      setAmount(paiseToRupeeString(editing.amount));
      setAccountId(editing.accountId);
      setToAccountId(editing.toAccountId);
      setCategoryId(editing.categoryId);
      setMerchant(editing.merchant);
      setNote(editing.note ?? '');
      setOccurredAt(editing.occurredAt.slice(0, 16));
      setLines(carried);
      setPeople(peopleFor(editing));
      setLabelIds(editing.labels.map((l) => l.id));
      setSeeded(false);
    } else {
      setKind(draft?.kind ?? 'expense');
      setAmount('');
      // Where it was asked for, then wherever the last one was written, then
      // whatever comes first — an account that has since gone or been
      // archived falls through rather than opening on nothing.
      const remembered = live.some((a) => a.id === lastAccount.current)
        ? lastAccount.current
        : null;
      setAccountId(draft?.accountId ?? remembered ?? live[0]?.id ?? null);
      setToAccountId(null);
      setCategoryId(draft?.categoryId ?? null);
      setMerchant('');
      setNote('');
      setOccurredAt(toLocalInput());
      setLines([]);
      setPeople(emptyPeople());
      setLabelIds([]);
      setSeeded(false);
    }
    // The sheet opens on a split page only when it was asked for by name —
    // the Split action on a row. Otherwise it opens on the transaction, with
    // whatever divisions it already carries summarised underneath.
    setBrowsing(null);
    setPage(splitFocus === 'debt' ? 'people' : splitFocus ?? null);
    setBack(false);
    // The whole of it is theirs, so no row of yours holds any of it back.
    // Only for a posting nobody owes anything on yet: one that already has
    // shares is opened as it stands.
    if (splitFocus === 'debt' && !editing?.shares.length) {
      setPeople({ ...emptyPeople(), people: [] });
    }
    // Landing straight on the categories page with nothing on it would be a
    // blank screen where a bill was expected: it gets the same two rows
    // opening the page from the form does, and they go the same way if
    // nothing is typed into them.
    if (splitFocus === 'categories' && carried.length === 0) {
      setLines([{ ...lineFromScratch(), categoryId: editing?.categoryId ?? null }, lineFromScratch()]);
      setSeeded(true);
    }
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
  // A group with something under it is a heading: tapping it opens what is
  // inside rather than filing the bill against the heading itself. The one it
  // opens follows the choice when there is one, and is remembered otherwise.
  const [browsing, setBrowsing] = useState<string | null>(null);
  const openGroupId = selected ? (selected.parentId ?? selected.id) : browsing;
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
  // Leaving the categories page having touched nothing puts the bill back as
  // it was: looking at a split is not the same as asking for one.
  const dropSeeded = () => {
    if (page === 'categories' && seeded) {
      setLines([]);
      setSeeded(false);
    }
  };

  const openPage = (which: SplitFocus) => {
    setBack(false);
    setPage(which === 'debt' ? 'people' : which);
    // Owed in full: your own row goes, so the one person picked up next takes
    // all of it rather than half. Never over shares that already exist —
    // clearing those would throw away debts somebody is repaying.
    if (which === 'debt') {
      if (owed === 0) setPeople({ ...emptyPeople(), people: [] });
      return;
    }
    // Emptied of everyone, including you, on a previous visit: start it over
    // rather than opening on a list with nothing in it.
    if (which === 'people' && people.people.length === 0) setPeople(emptyPeople());
    if (which !== 'categories') return;
    if (lines.length === 0) {
      // An empty first part and a rest holding the whole bill: you type what
      // one part came to and watch the rest come down, rather than being
      // handed a division nobody asked for.
      setLines([{ ...lineFromScratch(), categoryId }, lineFromScratch()]);
      setSeeded(true);
    }
  };

  const leavePage = () => {
    dropSeeded();
    setBack(true);
    setPage(null);
  };

  // Taking the last part off a bill, or the last person off it, is a way of
  // saying it isn't split after all — so the sheet goes back to the
  // transaction rather than leaving you on a page with nothing on it.
  const editLines = (next: SplitLine[]) => {
    setLines(next);
    setSeeded(false);
    if (lines.length > 0 && next.length === 0) leavePage();
  };

  const editPeople = (next: SplitPeople) => {
    setPeople(next);
    const had = people.people.some((person) => !person.you);
    const has = next.people.some((person) => !person.you);
    // Only the removal counts: with nobody on it yet, changing how it would
    // be divided is not a reason to be sent back.
    if (had && !has) leavePage();
  };

  const submit = async () => {
    if (!paise) return setError('Enter an amount.');
    if (!accountId) return setError('Pick an account.');
    if (needsNote && !note.trim()) return setError('Add a note — this book asks for one.');
    if (kind === 'transfer' && toAccountId === accountId)
      return setError('A transfer needs two different accounts.');

    // A transfer files under no category — it moves money rather than spending
    // it — but it can still be owed back: money out of your accounts with
    // nowhere of yours to go is lending, and the debt is the other side of it.
    const parts = kind === 'transfer' ? [] : linesToInput(lines, paise);
    const owing = peopleToInput(people, paise, kind);
    if (kind === 'transfer' && !toAccountId && !owing.length)
      return setError('Pick an account to transfer into, or say who owes it back.');
    if (kind !== 'transfer' && split && rest < 0)
      return setError(`The parts run ${money(-rest)} over the ${money(paise)} bill.`);
    if (parts.length === 1) return setError('A split needs at least two parts.');
    if (owed > paise)
      return setError(`The shares come to ${money(owed)} — more than the bill.`);

    // Lending is not spending. If none of a bill is yours — every paisa of it
    // owed back — then it is money that left your accounts and is coming
    // home, so it is saved as a transfer against the debt rather than as an
    // expense that would sit in your spending until it was repaid.
    const savedKind: TxKind = lentInFull ? 'transfer' : kind;

    const input: TransactionInput = {
      id: editing?.id ?? null,
      kind: savedKind,
      amount: paise,
      accountId,
      toAccountId: savedKind === 'transfer' ? toAccountId : null,
      // A split bill has no single category of its own, but the ledger row
      // still needs a colour and a glyph — so it takes the largest part's.
      categoryId:
        savedKind === 'transfer'
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
      labelIds,
    };

    // The caller wanted the input, not the save.
    if (onSubmit) {
      onSubmit(input);
      onClose();
      return;
    }

    setSaving(true);
    try {
      await saveTransaction(input);
      // Where the next new one will start. Only what you just added counts:
      // correcting the account on something from March says nothing about
      // where you are spending from now.
      if (isNew && accountId !== lastAccount.current) {
        void saveSetting(LAST_ACCOUNT, accountId);
      }
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

  // The right-hand column says what the money was for: the categories, and
  // the two ways of splitting it. Only a transfer has none of that — it moves
  // between your own accounts — so only a transfer drops to one column.
  const twoPane = kind !== 'transfer';

  // How wide the sheet has to be, which is not the same question: a split
  // page is two columns whatever it is dividing, so a transfer being split
  // with people needs the room even though its own form is one column.
  const wide = twoPane || page !== null;

  // Nothing of it is yours: an expense entirely owed back is lending, and the
  // sheet says so before it saves it that way.
  const lentInFull = kind === 'expense' && paise > 0 && owed === paise;

  const accentVar =
    kind === 'income' ? 'var(--green)' : kind === 'transfer' ? 'var(--blue)' : 'var(--ink)';

  // The same column on every page of the sheet: what the money did. A split
  // is a different way of reading the same bill, not a different bill, so the
  // amount and the rest of it stay where they were rather than being left
  // behind on a page you had to go back to.
  const fields = (
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
              {/* Optional once somebody owes it: money out of your accounts
                  with nowhere of yours to go is lending, and the debt is
                  where it went. */}
              <Field label="To account">
                <Select
                  options={accountOptions.filter((o) => o.value !== accountId)}
                  value={toAccountId}
                  onChange={setToAccountId}
                  placeholder={owed > 0 ? 'Owed back to you' : 'Choose an account'}
                  allowClear={owed > 0}
                />
              </Field>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

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

      <Field label="Note" hint={needsNote ? 'required' : 'optional'}>
        <TextInput
          value={note}
          placeholder={needsNote ? 'What was this for?' : 'Anything worth remembering'}
          onChange={(e) => {
            setNote(e.target.value);
            setError(null);
          }}
        />
      </Field>

    </div>
  );

  // Pins, under whatever the right-hand column is saying about the money —
  // a label is not a filing, so it sits after the categories rather than
  // among them, and it applies to a transfer as much as to a bill.
  const labelPicker = (
    <div className="tx-labels">
      <span className="field-label">
        Labels
        {labelIds.length > 0 && (
          <span className="field-hint">
            {labelIds.length} pinned
          </span>
        )}
      </span>
      <div className="chip-row">
        {labels.map((label) => (
          <Chip
            key={label.id}
            color={label.color}
            active={labelIds.includes(label.id)}
            onClick={() =>
              setLabelIds((was) =>
                was.includes(label.id)
                  ? was.filter((id) => id !== label.id)
                  : [...was, label.id],
              )
            }
          >
            {label.name}
          </Chip>
        ))}
        <NewLabel onAdded={(id) => setLabelIds((was) => [...was, id])} />
      </div>
    </div>
  );

  const partsSummary = split
    ? `${lines.length} parts of ${money(paise)} · ${partNames || 'pick categories'}`
    : 'File one bill under more than one category';
  const peopleSummary =
    owed > 0
      ? `${people.people.length - 1} ${
          people.people.length === 2 ? 'person' : 'people'
        } · ${money(owed)} ${
          directionFor(kind) === 'lent' ? 'owed back to you' : 'you owe them'
        }`
      : kind === 'income'
        ? 'Owe part of this to the people it was for'
        : 'Turn everyone else’s share into a debt they owe you';

  const heading =
    page === 'categories'
      ? {
          title: 'Split transaction',
          subtitle: split
            ? `${money(paise)} in ${lines.length} parts`
            : 'File one bill under more than one category',
        }
      : page === 'people'
        ? {
            title: 'Split with people',
            subtitle:
              owed > 0
                ? `${money(owed)} of ${money(paise)} ${
                    directionFor(kind) === 'lent' ? 'owed back to you' : 'you owe them'
                  }`
                : 'Everyone else’s share becomes a debt of its own',
          }
        : {
            title: isNew ? 'New transaction' : 'Edit transaction',
            subtitle:
              kind === 'transfer'
                ? 'Moving money between your own accounts'
                : kind === 'income'
                  ? 'Money landing in an account'
                  : 'Money leaving an account',
          };

  // Escape steps back out of a split first, since leaving the page is what it
  // means there — the sheet's own Escape only gets it once there is nothing
  // left to go back to.
  const onKeys = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape' && page) {
      e.stopPropagation();
      leavePage();
    }
  };

  // ⌘↵ saves from wherever you are in the sheet. It listens on the document
  // rather than on the form, because the footer, the header and the split
  // menu are all outside the form and the shortcut is about the sheet.
  //
  // It listens as the event bubbles, not on the way down, so a field that
  // takes Enter for itself — the box you type a name into on the people page
  // — still stops the sheet from saving out from under it.
  const shortcut = useRef<(e: KeyboardEvent) => void>(() => {});
  shortcut.current = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit();
  };
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => shortcut.current(e);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <Sheet
      open={open}
      onClose={onClose}
      onBack={page ? leavePage : undefined}
      title={heading.title}
      subtitle={heading.subtitle}
      width={wide ? 1040 : 600}
      footer={
        <>
          <div className="foot-lead">
            {editing && !page && !onSubmit && (
              <Button
                tone="danger"
                icon="trash-2"
                onClick={() => setConfirmingDelete(true)}
              >
                Delete
              </Button>
            )}
            {/* Not while you are already inside one: the way out of a split is
                back to the transaction, and the menu would only offer the way
                in again. */}
            {!page && (
              <SplitMenu
                ways={[
                  // A transfer has no category to divide it between.
                  ...(kind === 'transfer'
                    ? []
                    : [
                        {
                          which: 'categories' as const,
                          icon: 'split',
                          title: 'Split transaction',
                          summary: partsSummary,
                          on: split,
                        },
                      ]),
                  {
                    which: 'people',
                    icon: 'users',
                    title: 'Split with people',
                    summary: peopleSummary,
                    on: owed > 0,
                  },
                  // Only while nothing is owed on it yet: once it is, the
                  // people page above is where it is changed.
                  ...(owed === 0
                    ? [
                        {
                          which: 'debt' as const,
                          icon: 'user-round',
                          title: 'Owed by someone',
                          summary: 'The whole of it becomes a debt in their name',
                          on: false,
                        },
                      ]
                    : []),
                ]}
                onPick={openPage}
              />
            )}
          </div>
          <div className="foot-actions">
            {/* Cancel means the transaction, wherever you are in it. The way
                back out of a split is the arrow in the header. */}
            <Button tone="ghost" onClick={onClose}>
              Cancel
            </Button>
            {/* The shortcut belongs on the thing it presses. */}
            <Button tone="primary" onClick={submit} disabled={saving}>
              {isNew ? 'Add transaction' : 'Save changes'}
              <span className="btn-keys">
                <kbd>⌘</kbd>
                <kbd>↵</kbd>
              </span>
            </Button>
          </div>
        </>
      }
    >
      <AnimatePresence mode="wait" initial={false} custom={back ? -1 : 1}>
        {page ? (
          <motion.div
            key={page}
            className="tx-form is-two-pane"
            style={{ ['--accent' as any]: accentVar }}
            custom={back ? -1 : 1}
            variants={pageVariants}
            initial="enter"
            animate="settled"
            exit="leave"
            onKeyDown={onKeys}
          >
            {fields}

            <div className="tx-pane tx-pane-detail">
              <div className="tx-page">
                {page === 'categories' ? (
                  <SplitLinesEditor amount={paise} kind={kind} lines={lines} onChange={editLines} />
                ) : (
                  <>
                    <SplitPeopleEditor amount={paise} split={people} onChange={editPeople} />
                    {lentInFull && (
                      <p className="page-note">
                        <Icon name="arrow-left-right" size={13} />
                        None of this is yours, so it is money lent rather than money
                        spent — it will be saved as a transfer out of{' '}
                        {live.find((a) => a.id === accountId)?.name ?? 'the account'} and
                        stay out of your spending until it comes back.
                      </p>
                    )}
                  </>
                )}
              </div>
            </div>
          </motion.div>
        ) : (
          <motion.div
            key="form"
            className={`tx-form ${twoPane ? 'is-two-pane' : ''}`}
            style={{ ['--accent' as any]: accentVar }}
            custom={back ? -1 : 1}
            variants={pageVariants}
            initial="enter"
            animate="settled"
            exit="leave"
            onKeyDown={onKeys}
          >
            {/* The form on the left, the category grid on the right: a grid of
                chips reads as a block, and stacking it above the fields pushed
                the date and the note off the bottom of the sheet. */}
            {fields}

            <div className="tx-pane tx-pane-detail">
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
                            onClick={() => {
                              if (group.children.length) {
                                setCategoryId(null);
                                setBrowsing(inside ? null : group.id);
                                return;
                              }
                              setBrowsing(null);
                              setCategoryId(active ? null : group.id);
                            }}
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
                                    onClick={() => {
                                      setBrowsing(openGroup.id);
                                      setCategoryId(active ? null : child.id);
                                    }}
                                  >
                                    <Icon name={child.icon} size={13} strokeWidth={2.2} />
                                    {child.name}
                                  </button>
                                );
                              })}
                              {/* The one that isn't there yet. Filing is when
                                  you find out a category is missing, so it can
                                  be made here rather than in another screen. */}
                              <NewSubCategory
                                group={openGroup}
                                onAdded={(id) => setCategoryId(id)}
                              />
                            </div>
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* A split bill has no one category, so the picker steps aside —
                  and what it was filed under instead takes its place, rather
                  than leaving the column to say nothing at all. */}
              <AnimatePresence initial={false}>
                {kind !== 'transfer' && split && (
                  <motion.button
                    key="recap"
                    type="button"
                    className="split-recap"
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={spring}
                    onClick={() => openPage('categories')}
                  >
                    <span className="field-label">
                      Split
                      <span className="field-hint">{money(paise)} in {lines.length} parts</span>
                    </span>
                    <span className="split-recap-parts">
                      {linesToInput(lines, paise).map((part, i) => {
                        const category = palette.find((c) => c.id === part.categoryId);
                        return (
                          <span className="split-recap-part" key={i}>
                            <i style={{ background: category?.color ?? 'var(--ink-4)' }} />
                            {category?.name ?? 'Uncategorised'}
                            <em>{money(part.amount)}</em>
                          </span>
                        );
                      })}
                    </span>
                  </motion.button>
                )}
              </AnimatePresence>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </Sheet>
  );
}
