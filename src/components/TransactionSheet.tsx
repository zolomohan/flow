import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Icon } from './Icon';
import { DateField } from './DateField';
import {
  Button, Chip, Confirm, Field, IconButton, OptionRail, Segmented, Select, Sheet,
  TextArea, TextInput,
  type SegmentOption, type SelectOption,
} from './ui';
import {
  SplitLinesEditor, SplitPeopleEditor, SplitMenu,
  directionFor, emptyPeople, lineFromScratch, linesFor, linesOf, linesToInput,
  owedInFull, peopleFor, peopleToInput, restOf, shareAmounts,
  type SplitLine, type SplitPeople,
} from './SplitEditors';
import { LAST_ACCOUNT, REQUIRE_NOTE, useStore } from '../lib/store';
import {
  amountChars, money, paiseToRupeeString, rupeesToPaise, settleAmount, sumPreview,
  toLocalInput,
} from '../lib/format';
import { itemVariants, listVariants, pageVariants, popover, press, spring } from '../lib/motion';
import { RecordPicker } from './RecordPicker';
import { asksFor, describeTemplate, spoken } from '../lib/templates';
import type {
  Account, Category, Paise, Transaction, TransactionInput, TxKind,
  TxTemplate, TxTemplateInput,
} from '../lib/types';

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

/**
 * Templates, on a menu of their own beside the sheet's other footer controls:
 * the ones you have saved, and the way to save this one.
 *
 * Applying is offered only while writing something new. Reaching for a
 * template halfway through correcting March's rent would overwrite what is
 * being corrected, and there is no way back from that.
 */
function TemplateMenu({
  templates, canApply, suggested, onApply, onSave,
}: {
  templates: TxTemplate[];
  /** Whether picking one is on offer at all — a new transaction, in short. */
  canApply: boolean;
  /** What to call this one, if nothing better is typed. */
  suggested: string;
  onApply: (template: TxTemplate) => void;
  /** Resolves true once it is written, so the menu knows to shut. */
  onSave: (name: string, replacing: TxTemplate | null) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) {
      setNaming(false);
      setName('');
    }
  }, [open]);

  useEffect(() => {
    if (naming) field.current?.focus();
  }, [naming]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // The sheet closes on Escape too, and the menu is the nearer thing.
      e.stopPropagation();
      setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  // Saving under a name already taken replaces that template rather than
  // refusing: it is how a template is corrected, since there is nowhere else
  // to edit one from.
  const typed = (name.trim() || suggested).trim();
  const clash = templates.find((t) => t.name.toLowerCase() === typed.toLowerCase()) ?? null;

  const save = async () => {
    if (!typed || saving) return;
    setSaving(true);
    try {
      if (await onSave(typed, clash)) setOpen(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="split-menu" ref={root}>
      <motion.button
        type="button"
        className={`split-menu-trigger ${open ? 'is-open' : ''}`}
        onClick={() => setOpen((was) => !was)}
        whileTap={press}
        transition={spring}
      >
        <Icon name="shapes" size={14} strokeWidth={2.1} />
        Templates
        <motion.span animate={{ rotate: open ? 180 : 0 }} transition={spring}>
          <Icon name="chevron-down" size={14} />
        </motion.span>
      </motion.button>

      <AnimatePresence>
        {open && (
          <motion.div
            className="split-menu-pop tpl-pop"
            variants={popover}
            initial="initial"
            animate="animate"
            exit="exit"
          >
            {canApply &&
              templates.map((template) => (
                <button
                  key={template.id}
                  type="button"
                  className="split-link"
                  onClick={() => {
                    setOpen(false);
                    onApply(template);
                  }}
                >
                  <span
                    className="split-section-glyph"
                    style={{ ['--cat' as any]: template.categoryColor ?? undefined }}
                  >
                    <Icon
                      name={template.categoryIcon ?? glyphFor(template.kind)}
                      size={15}
                      strokeWidth={2.1}
                    />
                  </span>
                  <span className="split-section-title">
                    {template.name}
                    <em>{describeTemplate(template)}</em>
                  </span>
                  <Icon name="chevron-right" size={16} />
                </button>
              ))}
            {canApply && templates.length === 0 && (
              <p className="tpl-none">
                Nothing saved yet. Fill this one in and keep it — the next one like
                it is then a single click.
              </p>
            )}
            {canApply && <span className="tpl-sep" />}

            {naming ? (
              <div className="tpl-naming">
                <input
                  ref={field}
                  className="input"
                  value={name}
                  placeholder={suggested || 'Name it'}
                  disabled={saving}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => {
                    // Enter is the sheet's own save; here it names the template.
                    e.stopPropagation();
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void save();
                    }
                    if (e.key === 'Escape') {
                      e.preventDefault();
                      setNaming(false);
                    }
                  }}
                />
                <IconButton
                  icon="check"
                  label={clash ? `Replace ${clash.name}` : 'Save it'}
                  size={30}
                  disabled={!typed || saving}
                  onClick={() => void save()}
                />
              </div>
            ) : (
              <button
                type="button"
                className="split-link"
                onClick={() => {
                  setName('');
                  setNaming(true);
                }}
              >
                <span className="split-section-glyph">
                  <Icon name="plus" size={15} strokeWidth={2.4} />
                </span>
                <span className="split-section-title">
                  Save as template
                  <em>The form as it stands, blanks and all, under a name</em>
                </span>
              </button>
            )}
            {naming && (clash || !typed) && (
              <p className="tpl-none">
                {clash
                  ? `Replaces the template already called “${clash.name}”.`
                  : 'Give it a name you will recognise in a hurry.'}
              </p>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

const glyphFor = (kind: TxKind) =>
  kind === 'transfer' ? 'arrow-left-right' : kind === 'income' ? 'arrow-down-left' : 'circle-dashed';

/**
 * The form as a template says it should be. What it carries is filled in and
 * what it was left blank stays blank — a template with no amount opens on an
 * empty well, which is how it says the figure is different every time. The
 * date it says nothing about at all: that one is always today's business.
 */
function shapeOf(template: TxTemplate, live: Account[]) {
  // An account archived or deleted since is no account at all, and blank is
  // the honest answer: better to be asked than to post somewhere unintended.
  const held = (id: string | null) => (live.some((a) => a.id === id) ? id : null);
  return {
    kind: template.kind,
    amount: template.amount ? paiseToRupeeString(template.amount) : '',
    accountId: held(template.accountId),
    toAccountId: template.kind === 'transfer' ? held(template.toAccountId) : null,
    categoryId: template.kind === 'transfer' ? null : template.categoryId,
    merchant: template.merchant,
    note: template.note ?? '',
    lines: linesOf(template.splits),
    labelIds: template.labels.map((l) => l.id),
  };
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
  /** Opened from a saved template — the sheet fills itself in from it. */
  template?: TxTemplate;
  /** Opened to give a posting back: the sheet arrives as the other side of
   *  it, for whatever is still standing on it. */
  refund?: Transaction;
}

/**
 * The posting a refund gives back to, as the form needs it: enough to say
 * what is being undone and to check that it isn't handing back more than was
 * there.
 */
interface RefundTarget {
  id: string;
  merchant: string;
  /** Which way the posting being refunded ran. */
  kind: TxKind;
  amount: Paise;
  /** What is still standing on it, other refunds already taken off. */
  remaining: Paise;
}

/** A refund runs the other way from what it undoes: money spent comes back
 *  in, money earned goes back out. */
/**
 * A posting's id, and a way to take it with you. Two rows can read the same on
 * screen — same day, same merchant, same amount — and still be different rows,
 * so naming one to somebody else only works if the id comes along.
 */
function TransactionId({ id }: { id: string }) {
  const { toast } = useStore();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const done = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(done);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(id);
    } catch {
      // A webview without clipboard permission, or a window that has lost
      // focus: the selection route asks for nothing and works either way.
      const carrier = document.createElement('textarea');
      carrier.value = id;
      carrier.style.cssText = 'position:fixed;top:-100px;opacity:0';
      document.body.appendChild(carrier);
      carrier.select();
      document.execCommand('copy');
      carrier.remove();
    }
    setCopied(true);
    toast('Transaction ID copied');
  };

  return (
    <button type="button" className="tx-id" onClick={copy} title="Copy this transaction's ID">
      <span className="tx-id-tag">ID</span>
      <span className="tx-id-value">{id}</span>
      <Icon name={copied ? 'check' : 'copy'} size={13} />
    </button>
  );
}

const refundKind = (target: TxKind): TxKind => (target === 'income' ? 'expense' : 'income');

const targetOf = (tx: Transaction): RefundTarget => ({
  id: tx.id,
  merchant: tx.merchant || tx.categoryName || 'that transaction',
  kind: tx.kind,
  amount: tx.amount,
  remaining: tx.amount - tx.refunded,
});

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
    saveSetting, templates, saveTemplate, markTemplateUsed,
  } = useStore();
  const live = useMemo(() => accounts.filter((a) => !a.archived && !a.system), [accounts]);
  // The account every debt runs through, named by the book itself.
  const holding = useMemo(() => accounts.find((a) => a.system), [accounts]);
  // Read by the reset below rather than watched by it. Every write anywhere in
  // the app hands the store a fresh accounts array, and a reset that listed
  // that array as a reason to run would empty the form under whoever was
  // filling it in — adding a sub-category from this very sheet does exactly
  // that.
  const liveRef = useRef(live);
  liveRef.current = live;
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
  // What is wrong with the parts of a split, kept apart from the form's own
  // error: it is said under the rows it is about, not beside the amount.
  const [partsError, setPartsError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [lines, setLines] = useState<SplitLine[]>([]);
  const [people, setPeople] = useState<SplitPeople>(emptyPeople);
  const [labelIds, setLabelIds] = useState<string[]>([]);
  // What this posting gives back, when it is a refund. A refund undoes one
  // posting rather than being money of its own: neither of them is counted
  // as earned or spent, and the balance keeps both, because the money did
  // leave and it did come back.
  const [refund, setRefund] = useState<RefundTarget | null>(null);
  // The ledger, opened from the footer to name what this gives back.
  const [refundPicking, setRefundPicking] = useState(false);
  const debtorRef = useRef<HTMLInputElement>(null);
  // Which template this one was filled in from: what it asks for is still
  // owed, its name belongs in the heading, and the count against it goes up
  // once the posting is actually written — not before.
  const [fromTemplate, setFromTemplate] = useState<TxTemplate | null>(null);
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

  // Where a refund files itself. It counts for nothing either way — a refund
  // is netted off the posting it undoes — but the row still wants a colour
  // and a glyph, and money coming back belongs under Refunds when the book
  // still has the category it was seeded with.
  const refundFiling = (of: TxKind) =>
    refundKind(of) === 'income'
      ? (categories.find((c) => c.kind === 'income' && !c.parentId && c.name === 'Refunds')?.id ??
         null)
      : null;

  // Reset the form each time the sheet opens, from the edited row or the draft.
  useEffect(() => {
    if (!open) return;
    const carried = editing ? linesFor(editing) : [];
    // A split bill has no note of its own any more — the parts carry them. A
    // posting written before that moves its note onto its first part rather
    // than losing it the next time it is saved.
    if (editing?.note && carried.length && !carried[0].note) {
      carried[0] = { ...carried[0], note: editing.note };
    }
    if (editing) {
      setKind(editing.kind);
      setAmount(paiseToRupeeString(editing.amount));
      setAccountId(editing.accountId);
      setToAccountId(editing.toAccountId);
      setCategoryId(editing.categoryId);
      setMerchant(editing.merchant);
      setNote(carried.length ? '' : (editing.note ?? ''));
      setOccurredAt(editing.occurredAt.slice(0, 16));
      setLines(carried);
      setPeople(peopleFor(editing));
      setLabelIds(editing.labels.map((l) => l.id));
      setSeeded(false);
      setFromTemplate(null);
      // What it refunds, as far as the row knows it. How much of the bill is
      // still standing takes any other refund into account, which this side
      // cannot see — the book is the referee, and says so on save.
      setRefund(
        editing.refundOf
          ? {
              id: editing.refundOf,
              merchant: editing.refundOfMerchant || 'that transaction',
              kind: refundKind(editing.kind),
              amount: editing.refundOfAmount ?? editing.amount,
              remaining: editing.refundOfAmount ?? editing.amount,
            }
          : null,
      );
    } else {
      // Where it was asked for, then wherever the last one was written, then
      // whatever comes first — an account that has since gone or been
      // archived falls through rather than opening on nothing.
      const remembered = liveRef.current.some((a) => a.id === lastAccount.current)
        ? lastAccount.current
        : null;
      const fallback = draft?.accountId ?? remembered ?? liveRef.current[0]?.id ?? null;
      // Opened on a template — from the Templates screen, say — the form
      // arrives filled in, on today's date.
      const shape = draft?.template ? shapeOf(draft.template, liveRef.current) : null;
      // A blank in the shape is a question the template means to ask, so it
      // is set as it stands rather than fallen back over.
      setKind(shape ? shape.kind : (draft?.kind ?? 'expense'));
      setAmount(shape ? shape.amount : '');
      setAccountId(shape ? shape.accountId : fallback);
      setToAccountId(shape ? shape.toAccountId : null);
      setCategoryId(shape ? shape.categoryId : (draft?.categoryId ?? null));
      setMerchant(shape ? shape.merchant : '');
      setNote(shape ? shape.note : '');
      setOccurredAt(toLocalInput());
      setLines(shape ? shape.lines : []);
      setPeople(emptyPeople());
      setLabelIds(shape ? shape.labelIds : []);
      setSeeded(false);
      setFromTemplate(draft?.template ?? null);
      // Opened to give a posting back — the Refund action on a row. The form
      // arrives as the other side of it, for whatever is still standing.
      const giving = draft?.refund ? targetOf(draft.refund) : null;
      setRefund(giving);
      if (giving) {
        setKind(refundKind(giving.kind));
        setAmount(paiseToRupeeString(giving.remaining));
        setMerchant(draft!.refund!.merchant);
        setCategoryId(refundFiling(giving.kind));
        setLines([]);
      }
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
    setPartsError(null);
    const focus = window.setTimeout(() => amountRef.current?.focus(), 220);
    return () => window.clearTimeout(focus);
  }, [open, editing, draft, splitFocus]);

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

  // Switching sides drops a filing that belongs to the other one. Only a
  // category the book actually knows is dropped, though: one just made from
  // the panel below is chosen the moment it is saved, a breath before the
  // store has finished re-reading the list, and it is not to be thrown away
  // in that gap.
  useEffect(() => {
    if (kind === 'transfer' || !categoryId) return;
    const known = categories.some((c) => c.id === categoryId);
    if (known && !palette.some((c) => c.id === categoryId)) setCategoryId(null);
  }, [kind, palette, categories, categoryId]);

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

  // Naming what this gives back. The form turns round to face it: a refund
  // of a bill is money coming in, for what is still standing on the bill.
  const attachRefund = (tx: Transaction) => {
    if (tx.id === editing?.id) return setError('A posting cannot refund itself.');
    if (tx.kind === 'transfer')
      return setError(
        'A transfer moves money between your own accounts, so there is nothing to refund.',
      );
    // A refund is money coming home, so it is always income and always undoes
    // something spent. Money going back out is not a refund of anything — it
    // is spending, or it is a debt.
    if (tx.kind === 'income')
      return setError('Only something you spent can be given back to you.');
    if (tx.refundOf) return setError('That posting is itself a refund.');
    const target = targetOf(tx);
    setRefund(target);
    setKind(refundKind(target.kind));
    setAmount(paiseToRupeeString(target.remaining));
    setCategoryId(refundFiling(target.kind));
    if (!merchant.trim()) setMerchant(tx.merchant);
    setError(null);
  };

  // A refund runs the other way from what it undoes, so choosing the side it
  // no longer runs against is choosing for it not to be one.
  const chooseKind = (next: TxKind) => {
    setKind(next);
    // Only money landing in an account gives anything back.
    if (refund && next !== 'income') setRefund(null);
  };

  // Opening the categories panel on an unsplit bill seeds two halves rather
  // than two empty rows, so it starts balanced and is corrected downwards.
  // Closing it again without touching them puts the bill back as it was:
  // looking inside a panel is not the same as asking for a split.
  // Leaving the categories page having touched nothing puts the bill back as
  // it was: looking at a split is not the same as asking for one.
  const dropSeeded = () => {
    if (page === 'categories' && seeded) {
      // The bill's own note went onto the first part on the way in. Walking
      // back out without splitting hands it back.
      if (!note.trim() && lines[0]?.note.trim()) setNote(lines[0].note.trim());
      setLines([]);
      setSeeded(false);
    }
  };

  const openPage = (which: 'categories' | 'people') => {
    setBack(false);
    setPage(which);
    // Emptied of everyone, including you, on a previous visit: start it over
    // rather than opening on a list with nothing in it.
    if (which === 'people' && people.people.length === 0) setPeople(emptyPeople());
    if (which !== 'categories') return;
    if (lines.length === 0) {
      // An empty first part and a rest holding the whole bill: you type what
      // one part came to and watch the rest come down, rather than being
      // handed a division nobody asked for. Whatever was written about the
      // bill as a whole belongs to the first part now.
      setLines([
        { ...lineFromScratch(), categoryId, note: note.trim() },
        lineFromScratch(),
      ]);
      setNote('');
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
    setPartsError(null);
    if (lines.length > 0 && next.length === 0) {
      // Un-splitting a bill gives it back its note, which has been living on
      // the first part while it was in pieces.
      if (!note.trim() && lines[0]?.note.trim()) setNote(lines[0].note.trim());
      leavePage();
    }
  };

  const editPeople = (next: SplitPeople) => {
    setPeople(next);
    const had = people.people.some((person) => !person.you);
    const has = next.people.some((person) => !person.you);
    // Only the removal counts: with nobody on it yet, changing how it would
    // be divided is not a reason to be sent back.
    if (had && !has) leavePage();
  };

  // Filling the form in from one that was saved. It touches everything a
  // template speaks for and nothing else: the date stays where it is, and so
  // does anyone already down for a share of the bill.
  const applyTemplate = (template: TxTemplate) => {
    const shape = shapeOf(template, live);
    setKind(shape.kind);
    setAmount(shape.amount);
    setAccountId(shape.accountId);
    setToAccountId(shape.toAccountId);
    setCategoryId(shape.categoryId);
    setMerchant(shape.merchant);
    setNote(shape.note);
    setLines(shape.lines);
    setLabelIds(shape.labelIds);
    setSeeded(false);
    setBrowsing(null);
    setFromTemplate(template);
    setError(null);
    // Into whatever it left blank, when that is the amount — the well the
    // sheet opens on anyway, and what most templates leave for you.
    if (!template.amount) window.setTimeout(() => amountRef.current?.focus(), 60);
    // A template's blanks are the questions it means to ask, so it says which
    // ones on the way in rather than as a refusal on the way out.
    const asks = asksFor(template);
    toast(
      asks.length
        ? `Filled in from “${template.name}” — it asks for ${spoken(asks)}`
        : `Filled in from “${template.name}”`,
    );
  };

  /** Keeping this one under a name: the form as it stands, less the date.
   *  A field left blank is kept blank, and comes out blank every time. */
  const keepAsTemplate = async (name: string, replacing: TxTemplate | null) => {
    if (kind !== 'transfer' && split && rest < 0) {
      setError(`The parts run ${money(-rest)} over the ${money(paise)} bill.`);
      return false;
    }
    const input: TxTemplateInput = {
      id: replacing?.id ?? null,
      name,
      kind,
      amount: paise,
      accountId,
      toAccountId: kind === 'transfer' ? toAccountId : null,
      categoryId: kind === 'transfer' ? null : categoryId,
      merchant: merchant.trim(),
      note: note.trim() || null,
      // Parts are shares of a figure, so they only go in when there is one
      // to divide. Everything else about the template is kept either way.
      splits: kind !== 'transfer' && paise > 0 ? linesToInput(lines, paise) : [],
      labelIds,
    };
    try {
      const saved = await saveTemplate(input);
      // What it was just saved as is what this form now stands for.
      setFromTemplate(saved);
      return true;
    } catch {
      /* the store has already said what went wrong */
      return false;
    }
  };

  const submit = async () => {
    if (!paise) return setError('Enter an amount.');
    if (!accountId) return setError('Pick an account.');
    if (needsNote && !split && !note.trim())
      return setError('Add a note — this book asks for one.');
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
    // The note is asked of the parts, since the bill itself no longer has one.
    // Said on the parts page, and the sheet opens it: a message about rows
    // nobody can see is no message at all.
    if (needsNote && parts.length && parts.some((part) => !part.note)) {
      setBack(false);
      setPage('categories');
      return setPartsError('Every part needs a note — this book asks for one.');
    }
    if (owed > paise)
      return setError(`The shares come to ${money(owed)} — more than the bill.`);
    // A refund can only hand back what is still standing, and money lent is
    // not money given back: a posting is one or the other.
    if (refund && paise > refund.remaining)
      return setError(`${refund.merchant} has ${money(refund.remaining)} left to give back.`);
    if (refund && lentInFull)
      return setError('A refund comes home to you, so it cannot be owed back as well.');

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
      // Split into parts, the note belongs to the parts: one note standing
      // for a bill that was several things is a note about none of them.
      note: parts.length ? null : (note.trim() || null),
      occurredAt,
      splits: parts,
      shares: owing,
      labelIds,
      refundOf: refund?.id ?? null,
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
      // A template counts as used once something has actually been written
      // from it — opening one and thinking better of it is not a use.
      if (isNew && fromTemplate) void markTemplateUsed(fromTemplate.id);
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

  // Armed by the footer button, answered in a dialog: the delete itself only
  // runs once the second, deliberate click lands somewhere else on screen.
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const remove = async () => {
    if (!editing) return;
    setConfirmingDelete(false);
    await deleteTransaction(editing.id);
    toast('Transaction deleted');
    onClose();
  };

  // Two columns, whatever is being written. The right-hand one says what the
  // money was for — the categories on a bill, the pins on anything — and a
  // transfer has pins like everything else. Dropping it to one column meant
  // the sheet changed shape under whoever switched kinds, and left a transfer
  // with nowhere to put its labels.

  // Nothing of it is yours: an expense entirely owed back is lending, and the
  // sheet says so before it saves it that way.
  const lentInFull = kind === 'expense' && paise > 0 && owed === paise;

  // A transfer marked as a debt: one name, holding the whole of it. There is
  // no share to work out and no row for you, so it is not a division of the
  // posting and does not open the page that divides one — it is a question
  // with one answer, asked beside the form.
  const debtor =
    kind === 'transfer' && people.people.length === 1 && !people.people[0].you
      ? people.people[0]
      : null;
  const nameDebt = (name: string) =>
    setPeople((was) => ({ ...was, people: [{ ...was.people[0], name }] }));
  const markAsDebt = () => {
    setPeople(owedInFull());
    // Owed back is where it went: there is no account of yours to land in.
    setToAccountId(null);
    window.setTimeout(() => debtorRef.current?.focus(), 60);
  };

  const accentVar =
    kind === 'income' ? 'var(--green)' : kind === 'transfer' ? 'var(--blue)' : 'var(--ink)';

  // The same column on every page of the sheet: what the money did. A split
  // is a different way of reading the same bill, not a different bill, so the
  // amount and the rest of it stay where they were rather than being left
  // behind on a page you had to go back to.
  const fields = (
    <div className="tx-pane">
      <Segmented options={KINDS} value={kind} onChange={chooseKind} name="tx-kind" size="lg" />

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
              = {money(Math.round(typed * 100), { plain: true })}
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

      {/* One account to pick, and the row to pick it from: the rail reads
          left to right and costs no clicks. Two of them side by side is a
          different question — half the width each, and the answer to one
          narrows the other — so a transfer asks the way a form asks, with a
          menu apiece. */}
      <div className={`tx-accounts ${kind === 'transfer' ? 'is-transfer' : ''}`}>
        <Field label={kind === 'income' ? 'Into account' : 'From account'}>
          {kind === 'transfer' ? (
            <Select
              options={accountOptions}
              value={accountId}
              onChange={setAccountId}
              placeholder="Choose an account"
            />
          ) : (
            <OptionRail
              options={accountOptions}
              value={accountId}
              onChange={setAccountId}
              empty="No open accounts yet."
            />
          )}
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
              <IconButton
                icon="arrow-left-right"
                label="Swap accounts"
                onClick={swap}
                disabled={!!debtor}
              />
              {/* Marked as a debt, the far side is settled: it is out with
                  the person, and the book files that against the account
                  that stands for what is out with people. There is nothing
                  left to choose, so nothing is offered. */}
              <Field label="To account">
                {debtor ? (
                  <div className="field-fixed">
                    <Icon name="users" size={15} />
                    {holding?.name ?? 'Debts'}
                  </div>
                ) : (
                  <Select
                    options={accountOptions.filter((o) => o.value !== accountId)}
                    value={toAccountId}
                    onChange={setToAccountId}
                    placeholder="Choose an account"
                  />
                )}
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

      {/* One bill cut into parts is several things, and each says what it
          was for on its own row. A note over the top of them would be a note
          about none of them. */}
      {!split && (
        <Field
          label="Note"
          hint={needsNote ? 'required' : 'optional'}
        >
          <TextArea
            value={note}
            placeholder={needsNote ? 'What was this for?' : 'Anything worth remembering'}
            onChange={(e) => {
              setNote(e.target.value);
              setError(null);
            }}
          />
        </Field>
      )}

    </div>
  );

  // Pins, under whatever the right-hand column is saying about the money —
  // a label is not a filing, so it sits after the categories rather than
  // among them, and it applies to a transfer as much as to a bill. Silent
  // labels are pinned from here like any other: this is where you say what
  // is on a posting, and a silent one is only quiet on the way out.
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
            {label.silent && (
              <Icon name="eye-off" size={10.5} strokeWidth={2.2} className="chip-quiet" />
            )}
            {label.name}
          </Chip>
        ))}
        <NewLabel onAdded={(id) => setLabelIds((was) => [...was, id])} />
      </div>
    </div>
  );

  // Who owes the whole of it, asked as one field rather than as a page about
  // dividing something that is not being divided.
  const debtBlock = debtor && (
    <div className="tx-debt">
      <span className="field-label">
        Owed back by
        {owed > 0 && <span className="field-hint">{money(owed)}</span>}
      </span>
      <TextInput
        ref={debtorRef}
        value={debtor.name}
        placeholder="Suhruth"
        onChange={(e) => nameDebt(e.target.value)}
      />
      <Field label="Due" hint="optional">
        <DateField
          value={people.dueOn}
          onChange={(value) => setPeople((was) => ({ ...was, dueOn: value }))}
          placeholder="No due date"
          allowClear
        />
      </Field>
      <p className="page-note">
        <Icon name="arrow-left-right" size={13} />
        {debtor.name.trim()
          ? `The whole ${money(paise)} is ${debtor.name.trim()}'s to pay back. It leaves ${
              live.find((a) => a.id === accountId)?.name ?? 'the account'
            } and stays out of your spending until it comes home.`
          : 'Say whose it is and the whole of it becomes their debt — money out of your account with nowhere of yours to go.'}
      </p>
    </div>
  );

  // What this posting undoes, when it undoes one. A transfer has nothing to
  // give back — it moves money between your own accounts rather than earning
  // or spending it — so it is never asked.
  // Nor is a statement row waiting to import: it is not in the book yet, and
  // a posting that isn't there can neither give anything back nor be given.
  // Only an income posting can be one: a refund is what comes back, and the
  // bill it undoes is something spent. Nor can a statement row waiting to
  // import be one — it is not in the book yet.
  const canRefund = kind === 'income' && !onSubmit;

  // What attaching one does to the two postings, said where it is decided.
  const refundNote = canRefund && refund && (
    <p className="page-note tx-note-refund">
      <Icon name="undo-2" size={13} />
      {paise >= refund.remaining
        ? `Nothing of ${refund.merchant} is left standing: it drops out of your ${
            refund.kind === 'expense' ? 'spending' : 'income'
          } and this drops out with it. The money still moved, so both accounts keep it.`
        : `${money(paise)} of ${money(refund.amount)} comes off ${refund.merchant} — ${money(
            refund.remaining - paise,
          )} of it still stands.`}
    </p>
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
            // Opened from a template, the heading says which one.
            subtitle: fromTemplate
              ? `From “${fromTemplate.name}”`
              : refund
                ? `Giving back ${refund.merchant} — neither will count as ${
                    refund.kind === 'expense' ? 'spending' : 'income'
                  }`
                : kind === 'transfer'
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
      // The posting's own id, in the header. Two rows can read the same on
      // screen and still be different rows, so when one has to be named — a
      // duplicate to merge, a row to point somebody at — the id is the only
      // thing that says which. It belongs to the sheet rather than to the
      // form, so it rides with the sheet's own chrome.
      aside={editing?.id && !onSubmit ? <TransactionId id={editing.id} /> : undefined}
      title={heading.title}
      subtitle={heading.subtitle}
      width={1040}
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
            {/* Templates are about a posting of your own. The importer's copy
                of the sheet is editing a statement row, where filling the
                form in from something else would throw the row away. */}
            {!page && !onSubmit && (
              <TemplateMenu
                templates={templates}
                canApply={isNew}
                suggested={merchant.trim() || selected?.name || ''}
                onApply={applyTemplate}
                onSave={keepAsTemplate}
              />
            )}
            {/* Neither of these while you are already inside a page: the way
                out is back to the transaction, and they would only offer the
                way in again.

                A transfer moves money between your own accounts, so there is
                nothing to divide it between — but money that left with
                nowhere of yours to go is money somebody owes back. One way
                in, one button, where the menu of two ways stands on a bill. */}
            {!page && kind === 'transfer' && (
              <>
                <button
                  type="button"
                  className={`split-menu-trigger ${debtor || owed > 0 ? 'is-on' : ''}`}
                  // Already owed by several people — an older posting divided
                  // between them — so that one opens the page that divides it
                  // rather than being flattened back to a single name.
                  onClick={() =>
                    debtor
                      ? debtorRef.current?.focus()
                      : owed > 0
                        ? openPage('people')
                        : markAsDebt()
                  }
                  title="Whoever this money went to owes it back"
                >
                  <span><Icon name="user-round" size={14} strokeWidth={2.1} /></span>
                  {owed > 0 ? `${money(owed)} owed back` : debtor ? 'Owed back by…' : 'Mark as debt'}
                </button>
                {(debtor || owed > 0) && (
                  <IconButton
                    icon="x"
                    label="Not a debt"
                    size={30}
                    onClick={() => setPeople(emptyPeople())}
                  />
                )}
              </>
            )}

            {!page && kind !== 'transfer' && (
              <SplitMenu
                ways={[
                  {
                    which: 'categories' as const,
                    icon: 'split',
                    title: 'Split transaction',
                    summary: partsSummary,
                    on: split,
                  },
                  {
                    which: 'people',
                    icon: 'users',
                    title: 'Split with people',
                    summary: peopleSummary,
                    on: owed > 0,
                  },
                ]}
                onPick={openPage}
              />
            )}

            {/* Naming what this gives back is the same size of decision as
                splitting it, so it stands beside it rather than as a field
                halfway down the form. */}
            {!page && canRefund && (
              <>
                <button
                  type="button"
                  className={`split-menu-trigger ${refund ? 'is-on' : ''}`}
                  onClick={() => setRefundPicking(true)}
                  title={refund ? 'Choose a different posting' : 'Say what this gives back'}
                >
                  <span><Icon name="undo-2" size={14} strokeWidth={2.1} /></span>
                  {refund ? `Refund of ${refund.merchant}` : 'Mark as refund'}
                </button>
                {refund && (
                  <IconButton
                    icon="x"
                    label="Not a refund"
                    size={30}
                    onClick={() => setRefund(null)}
                  />
                )}
              </>
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
                  <SplitLinesEditor
                    amount={paise}
                    kind={kind}
                    lines={lines}
                    onChange={editLines}
                    needsNote={needsNote}
                    error={partsError}
                  />
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

              {/* The pins belong to the posting, not to the page you are on:
                  cutting a bill into parts is exactly when you reach for
                  one, and it used to leave with the form. */}
              {labelPicker}
            </div>
          </motion.div>
        ) : (
          <motion.div
            key="form"
            className="tx-form is-two-pane"
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
                            <span className="split-recap-what">
                              {category?.name ?? 'Uncategorised'}
                              {/* What the part was for, under what it was
                                  filed as. On a split bill the note is the
                                  only thing telling two parts of the same
                                  category apart, so hiding it here left the
                                  column saying less than the row does. */}
                              {part.note && <em>{part.note}</em>}
                            </span>
                            <em className="split-recap-amount">{money(part.amount)}</em>
                          </span>
                        );
                      })}
                    </span>
                  </motion.button>
                )}
              </AnimatePresence>

              {debtBlock}
              {refundNote}
              {labelPicker}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <RecordPicker
        open={refundPicking}
        onClose={() => setRefundPicking(false)}
        title="What is this giving back?"
        subtitle="The posting it undoes. Neither of them will count toward what you earned or spent."
        onPick={(tx) => {
          attachRefund(tx);
          setRefundPicking(false);
        }}
      />
      <Confirm
        stacked
        open={confirmingDelete}
        title="Delete this transaction?"
        confirmLabel="Delete"
        onConfirm={remove}
        onCancel={() => setConfirmingDelete(false)}
      >
        {editing
          ? `${money(editing.amount)}${editing.merchant ? ` to ${editing.merchant}` : ''} \u2014 this cannot be undone.`
          : 'This cannot be undone.'}
      </Confirm>
    </Sheet>
  );
}
