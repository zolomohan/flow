import { useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Icon } from './Icon';
import { DateField } from './DateField';
import {
  Button, IconButton, Segmented, Select, TextInput,
  type SegmentOption, type SelectOption,
} from './ui';
import { useStore } from '../lib/store';
import { money, paiseToRupeeString, rupeesToPaise } from '../lib/format';
import { itemVariants, listVariants, spring } from '../lib/motion';
import type {
  DebtDirection, Paise, Transaction, TransactionShareInput, TransactionSplitInput, TxKind,
} from '../lib/types';

/**
 * Hands out `total` in the ratio of `weights`, to the paisa. The remainder is
 * given to the heaviest weights first, so three people splitting ₹100 come to
 * ₹33.34, ₹33.33 and ₹33.33 rather than a paisa short of the bill.
 */
export function distribute(total: Paise, weights: number[]): Paise[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) return weights.map(() => 0);
  const parts = weights.map((w) => Math.floor((total * w) / sum));
  let rest = total - parts.reduce((a, b) => a + b, 0);
  const heaviest = weights.map((_, i) => i).sort((a, b) => weights[b] - weights[a] || a - b);
  for (const i of heaviest) {
    if (rest <= 0) break;
    parts[i] += 1;
    rest -= 1;
  }
  return parts;
}

/** What a computed figure reads as inside a disabled amount box. */
const amountText = (paise: Paise) => (paise === 0 ? '0' : paiseToRupeeString(paise));

/** A number typed into a weight, share-count or percent box. */
const weightOf = (text: string) => {
  const n = Number(text);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

const nextKey = (() => {
  let n = 0;
  return () => `row-${++n}`;
})();

/* ============================================================ line items */

export interface SplitLine {
  key: string;
  amount: string;
  categoryId: string | null;
  note: string;
}

export const lineFromScratch = (): SplitLine => ({
  key: nextKey(),
  amount: '',
  categoryId: null,
  note: '',
});

/** The rows a saved bill reopens with — its own parts, or a blank pair. */
export function linesFor(tx: Transaction | null | undefined): SplitLine[] {
  if (!tx?.splits.length) return [];
  return tx.splits.map((s) => ({
    key: nextKey(),
    amount: paiseToRupeeString(s.amount),
    categoryId: s.categoryId,
    note: s.note ?? '',
  }));
}

/**
 * What each part actually comes to. Every row but the last is what was typed
 * into it; the last one is whatever is left of the bill, so the parts always
 * add up to it and there is never a remainder to chase.
 */
export function resolvedLines(lines: SplitLine[], amount: Paise): Paise[] {
  if (!lines.length) return [];
  const typed = lines.map((l) => rupeesToPaise(l.amount));
  const before = typed.slice(0, -1).reduce((a, b) => a + b, 0);
  return [...typed.slice(0, -1), amount - before];
}

/** What is left for the last part. Negative means the rest overran the bill. */
export function restOf(lines: SplitLine[], amount: Paise) {
  const amounts = resolvedLines(lines, amount);
  return amounts.length ? amounts[amounts.length - 1] : 0;
}

export const linesToInput = (
  lines: SplitLine[],
  amount: Paise,
): TransactionSplitInput[] => {
  const amounts = resolvedLines(lines, amount);
  return lines
    .map((l, i) => ({ line: l, amount: amounts[i] }))
    .filter((p) => p.amount > 0)
    .map((p) => ({
      amount: p.amount,
      categoryId: p.line.categoryId,
      note: p.line.note.trim() || null,
    }));
};

/**
 * One bill filed under several categories. The posting itself never moves —
 * only the attribution does — so the parts have to come to exactly what was
 * spent. Rather than police that, the last part simply takes whatever is
 * left: there is no remainder to reconcile and no way to be out of balance.
 */
export function SplitLinesEditor({
  amount, kind, lines, onChange,
}: {
  amount: Paise;
  kind: TxKind;
  lines: SplitLine[];
  onChange: (lines: SplitLine[]) => void;
}) {
  const { categories } = useStore();

  // The whole tree, one level deep: each group, then its own leaves indented
  // beneath it. A leaf carries its parent's name too, so typing the group's
  // name turns up everything filed under it rather than the group alone.
  const options: SelectOption[] = useMemo(() => {
    const side = categories.filter((c) => c.kind === (kind === 'income' ? 'income' : 'expense'));
    return side
      .filter((c) => !c.parentId)
      .flatMap((top) => [
        { value: top.id, label: top.name, icon: top.icon, color: top.color },
        ...side
          .filter((c) => c.parentId === top.id)
          .map((c) => ({
            value: c.id,
            label: c.name,
            icon: c.icon,
            color: c.color,
            child: true,
            under: top.name,
          })),
      ]);
  }, [categories, kind]);

  const rest = restOf(lines, amount);
  const last = lines.length - 1;
  const amounts = resolvedLines(lines, amount);
  // Each part borrows its category's colour, the way a ledger row does, so the
  // split can be read by colour before it is read by figure.
  const tintOf = (id: string | null) =>
    categories.find((c) => c.id === id)?.color ?? 'var(--ink-4)';

  const patch = (key: string, next: Partial<SplitLine>) =>
    onChange(lines.map((l) => (l.key === key ? { ...l, ...next } : l)));

  // A new part goes in *above* the one taking the rest, never into it: the row
  // you just asked for is the row you are about to type into, so it has to be
  // one you can type into. The rest stays at the bottom and shrinks as you do.
  const add = () =>
    onChange(
      lines.length
        ? [...lines.slice(0, last), lineFromScratch(), lines[last]]
        : [lineFromScratch(), lineFromScratch()],
    );

  const even = () => {
    const parts = distribute(amount, lines.map(() => 1));
    onChange(lines.map((l, i) => ({ ...l, amount: paiseToRupeeString(parts[i]) })));
  };

  return (
    <div className="split-lines">
      {lines.length > 1 && amount > 0 && (
        <div className="split-bar" aria-hidden>
          {amounts.map((part, i) => (
            <motion.span
              key={lines[i].key}
              layout
              transition={spring}
              className={part <= 0 ? 'is-empty' : ''}
              style={{
                flexGrow: Math.max(part, 0),
                ['--cat' as any]: tintOf(lines[i].categoryId),
              }}
            />
          ))}
        </div>
      )}

      <div className="split-block">
      <motion.div variants={listVariants} initial="initial" animate="animate">
        <AnimatePresence initial={false}>
          {lines.map((line, i) => (
            <motion.div
              key={line.key}
              className={`split-line ${i === last && rest < 0 ? 'is-over' : ''}`}
              style={{ ['--cat' as any]: tintOf(line.categoryId) }}
              variants={itemVariants}
              layout
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={spring}
            >
              <div className="split-line-row">
                <span className="split-line-index">{i + 1}</span>
                <Select
                  options={options}
                  value={line.categoryId}
                  onChange={(id) => patch(line.key, { categoryId: id })}
                  placeholder="Category"
                  searchPlaceholder="Find a category…"
                  searchable
                  allowClear
                />
                <div className="rupee-input split-line-amount">
                  <span>₹</span>
                  <TextInput
                    inputMode="decimal"
                    value={i === last ? amountText(rest) : line.amount}
                    placeholder="0"
                    disabled={i === last}
                    title={
                      i === last ? 'Whatever is left of the bill, filled in for you' : undefined
                    }
                    onChange={(e) =>
                      patch(line.key, { amount: e.target.value.replace(/[^0-9.]/g, '') })
                    }
                  />
                </div>
                <IconButton
                  icon="x"
                  label="Remove this part"
                  onClick={() => onChange(lines.filter((l) => l.key !== line.key))}
                />
              </div>
              <div className="split-line-foot">
                <TextInput
                  className="split-line-note"
                  value={line.note}
                  placeholder="Note — optional"
                  onChange={(e) => patch(line.key, { note: e.target.value })}
                />
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
      </motion.div>

        <div className="split-foot">
          <Button size="sm" icon="plus" onClick={add}>
            Add a part
          </Button>
          {lines.length > 1 && (
            <Button size="sm" tone="ghost" icon="equal" onClick={even}>
              Even
            </Button>
          )}
          <span className="split-foot-gap" />
          {lines.length > 0 && (
            <Button size="sm" tone="ghost" icon="undo-2" onClick={() => onChange([])}>
              Don’t split
            </Button>
          )}
        </div>
      </div>

      {rest < 0 && (
        <p className="split-tally is-over">
          <Icon name="alert-circle" size={13} />
          The parts run {money(-rest)} over the {money(amount)} bill.
        </p>
      )}
    </div>
  );
}

/* ================================================================ people */

type Method = 'equal' | 'shares' | 'exact' | 'percent';

const METHODS: SegmentOption<Method>[] = [
  { value: 'equal', label: 'Equally', icon: 'equal' },
  { value: 'shares', label: 'Shares', icon: 'scale' },
  { value: 'exact', label: 'Amounts', icon: 'coins' },
  { value: 'percent', label: 'Percent', icon: 'percent' },
];

/**
 * Which way a share runs, which is never a choice: money you spent on other
 * people is money they owe you, and money that landed in your account on
 * their behalf is money you owe them.
 */
export const directionFor = (kind: TxKind): DebtDirection =>
  kind === 'income' ? 'borrowed' : 'lent';

export interface Person {
  key: string;
  /** The debt this share already is, so a repayment survives an edit. */
  debtId: string | null;
  name: string;
  /** You are on every bill you paid, and are never a debt to yourself. */
  you: boolean;
  /** Shares for `shares`, percent for `percent`, ignored otherwise. */
  weight: string;
  /** Rupees typed against this person under `exact`. */
  exact: string;
  /** What has already been repaid, when this share is a saved debt. */
  paid: Paise;
}

export interface SplitPeople {
  method: Method;
  dueOn: string;
  people: Person[];
}

const you = (): Person => ({
  key: nextKey(),
  debtId: null,
  name: 'You',
  you: true,
  weight: '1',
  exact: '',
  paid: 0,
});

/** You sit at the end of the list, because that is where the rest is taken. */
export const emptyPeople = (): SplitPeople => ({
  method: 'equal',
  dueOn: '',
  people: [you()],
});

/**
 * The rows a saved bill reopens with. Everyone's share is read back as an
 * exact amount whatever it was typed as, because that is the only reading
 * that survives the bill's total being corrected afterwards.
 */
export function peopleFor(tx: Transaction | null | undefined): SplitPeople {
  if (!tx?.shares.length) return emptyPeople();
  const mine = tx.amount - tx.shares.reduce((sum, s) => sum + s.amount, 0);
  return {
    method: 'exact',
    dueOn: tx.shares[0].dueOn?.slice(0, 10) ?? '',
    people: [
      ...tx.shares.map((s) => ({
        key: nextKey(),
        debtId: s.debtId,
        name: s.counterparty,
        you: false,
        weight: '1',
        exact: paiseToRupeeString(s.amount),
        paid: s.paid,
      })),
      { ...you(), exact: paiseToRupeeString(Math.max(mine, 0)) },
    ],
  };
}

/**
 * What each person owes, in the order they are listed. Everyone else's share
 * comes from the method; yours is whatever is left of the bill afterwards.
 *
 * That is the same bargain the parts of a split bill strike, and it holds in
 * every method rather than only in some — under `equally` and `shares` the
 * remainder works out to exactly the share the ratio would have given you
 * anyway, so nothing is lost by never asking you to type it.
 */
export function shareAmounts(split: SplitPeople, amount: Paise): Paise[] {
  const { method, people } = split;
  // Equally and shares are the same sum with different weights, and both
  // divide the whole bill — your own row included, which is what makes the
  // leftover come out right.
  const ratio =
    method === 'equal'
      ? distribute(amount, people.map(() => 1))
      : method === 'shares'
        ? distribute(amount, people.map((p) => weightOf(p.weight)))
        : null;

  const others = people.map((person, i) => {
    if (person.you) return 0;
    if (ratio) return ratio[i];
    if (method === 'percent') return Math.round((amount * weightOf(person.weight)) / 100);
    return rupeesToPaise(person.exact);
  });

  const owed = others.reduce((a, b) => a + b, 0);
  return people.map((person, i) => (person.you ? amount - owed : others[i]));
}

export function peopleToInput(
  split: SplitPeople,
  amount: Paise,
  kind: TxKind,
): TransactionShareInput[] {
  const amounts = shareAmounts(split, amount);
  return split.people
    .map((p, i) => ({ p, amount: amounts[i] }))
    .filter(({ p, amount: a }) => !p.you && a > 0 && p.name.trim())
    .map(({ p, amount: a }) => ({
      id: p.debtId,
      direction: directionFor(kind),
      counterparty: p.name.trim(),
      amount: a,
      dueOn: split.dueOn || null,
      note: null,
    }));
}

/**
 * Splitting a bill with the people who were on it. Each share becomes a debt
 * of its own — it lands on the Debts screen, takes repayments and counts
 * towards net worth — while the posting itself is untouched: the money really
 * did leave your account, and being owed some of it back is a separate fact.
 *
 * Which way those debts run is not asked, because it is not a choice — see
 * `directionFor`.
 */
export function SplitPeopleEditor({
  amount, kind, split, onChange,
}: {
  amount: Paise;
  kind: TxKind;
  split: SplitPeople;
  onChange: (split: SplitPeople) => void;
}) {
  const { debts } = useStore();
  const [name, setName] = useState('');

  /** Names already in the book, so repeat company autocompletes. */
  const known = useMemo(
    () => [...new Set(debts.map((d) => d.counterparty))].sort(),
    [debts],
  );

  const amounts = shareAmounts(split, amount);
  const owed = split.people.reduce((sum, p, i) => sum + (p.you ? 0 : amounts[i]), 0);
  const mine = amount - owed;
  // Shares and percent are both "everyone states a weight"; the other two ask
  // for nothing, so every row's figure is worked out and shown disabled.
  const weighted = split.method === 'shares' || split.method === 'percent';
  const claimed = split.people.reduce(
    (sum, p) => sum + (p.you ? 0 : weightOf(p.weight)),
    0,
  );
  const leftoverPercent = String(Math.round((100 - claimed) * 10) / 10);
  const set = (next: Partial<SplitPeople>) => onChange({ ...split, ...next });
  const patch = (key: string, next: Partial<Person>) =>
    set({ people: split.people.map((p) => (p.key === key ? { ...p, ...next } : p)) });

  const add = (who: string) => {
    const trimmed = who.trim();
    if (!trimmed) return;
    const fresh: Person = {
      key: nextKey(), debtId: null, name: trimmed, you: false, weight: '1', exact: '', paid: 0,
    };
    // Above your own row, never below it — the rest is always taken last.
    set({ people: [...split.people.slice(0, -1), fresh, split.people[split.people.length - 1]] });
    setName('');
  };

  // Who you have split with before, minus whoever is already on this bill and
  // narrowed by whatever has been typed. Offered as chips rather than a native
  // dropdown, which neither matched the app nor behaved.
  const term = name.trim().toLowerCase();
  const suggestions = known
    .filter((who) => !split.people.some((p) => p.name.toLowerCase() === who.toLowerCase()))
    .filter((who) => !term || who.toLowerCase().includes(term))
    .slice(0, 6);

  return (
    <div className="split-people">
      <Segmented
        options={METHODS}
        value={split.method}
        onChange={(method) => set({ method })}
        name="split-method"
        size="sm"
      />

      <div className="split-block">
      <motion.div
        className={`person-list ${weighted ? 'is-weighted' : ''}`}
        variants={listVariants}
        initial="initial"
        animate="animate"
      >
        <AnimatePresence initial={false}>
          {split.people.map((person, i) => (
            <motion.div
              key={person.key}
              className={`person-row ${person.you ? 'is-you' : ''} ${
                person.you && mine < 0 ? 'is-over' : ''
              }`}
              variants={itemVariants}
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={spring}
            >
              <span className="person-name">
                {person.you ? 'You' : person.name}
                {person.paid > 0 && <em>{money(person.paid)} repaid</em>}
              </span>

              {weighted && (
                <div className="person-weight">
                  <TextInput
                    inputMode={split.method === 'percent' ? 'decimal' : 'numeric'}
                    value={
                      person.you && split.method === 'percent'
                        ? leftoverPercent
                        : person.weight
                    }
                    disabled={person.you && split.method === 'percent'}
                    onChange={(e) =>
                      patch(person.key, { weight: e.target.value.replace(/[^0-9.]/g, '') })
                    }
                  />
                  <span>{split.method === 'percent' ? '%' : 'shares'}</span>
                </div>
              )}

              <div className="rupee-input person-amount">
                <span>₹</span>
                <TextInput
                  inputMode="decimal"
                  value={
                    split.method === 'exact' && !person.you ? person.exact : amountText(amounts[i])
                  }
                  placeholder="0"
                  disabled={split.method !== 'exact' || person.you}
                  title={
                    person.you
                      ? 'Whatever is left of the bill, filled in for you'
                      : split.method !== 'exact'
                        ? 'Worked out from how the bill is being split'
                        : undefined
                  }
                  onChange={(e) =>
                    patch(person.key, { exact: e.target.value.replace(/[^0-9.]/g, '') })
                  }
                />
              </div>

              {person.you ? (
                <span className="person-spacer" />
              ) : (
                <IconButton
                  icon="x"
                  label={`Remove ${person.name}`}
                  onClick={() => set({ people: split.people.filter((p) => p.key !== person.key) })}
                />
              )}
            </motion.div>
          ))}
        </AnimatePresence>
      </motion.div>

      <div className="person-add">
        <TextInput
          value={name}
          placeholder="Add someone — Suhruth"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            e.stopPropagation();
            add(name);
          }}
        />
        <Button size="sm" onClick={() => add(name)} disabled={!name.trim()}>
          Add
        </Button>
      </div>

      {suggestions.length > 0 && (
        <div className="person-suggest">
          {suggestions.map((who) => (
            <button
              key={who}
              type="button"
              className="person-suggest-chip"
              onClick={() => add(who)}
            >
              <Icon name="plus" size={11} strokeWidth={2.4} />
              {who}
            </button>
          ))}
        </div>
      )}
      </div>

      {split.people.length > 1 && (
        <>
          <div className="split-due">
            <span className="field-label">
              Due <span className="field-hint">optional — the same date for everyone</span>
            </span>
            <DateField
              value={split.dueOn}
              onChange={(dueOn) => set({ dueOn })}
              placeholder="No due date"
              allowClear
            />
          </div>
          <p className={`split-tally ${mine < 0 ? 'is-over' : ''}`}>
            {mine < 0 ? (
              <>
                <Icon name="alert-circle" size={13} />
                The others come to {money(owed)} — more than the {money(amount)} bill, so
                there is nothing left for your own share.
              </>
            ) : (
              <>
                <Icon name="users" size={13} />
                {money(owed)}{' '}
                {directionFor(kind) === 'lent' ? 'owed back to you' : 'you owe them'} — saved
                as {split.people.length - 1}{' '}
                {split.people.length === 2 ? 'debt' : 'debts'} on the Debts screen.
              </>
            )}
          </p>
        </>
      )}
    </div>
  );
}

/* --------------------------------------------------------------- section */

/**
 * One of the two split panels: a header that says what is set up when it is
 * closed, and the editor itself when it is open.
 */
export function SplitSection({
  icon, title, summary, open, onToggle, children,
}: {
  icon: string;
  title: string;
  summary: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <section className={`split-section ${open ? 'is-open' : ''}`}>
      <button type="button" className="split-section-head" onClick={onToggle}>
        <span className="split-section-glyph">
          <Icon name={icon} size={15} strokeWidth={2.1} />
        </span>
        <span className="split-section-title">
          {title}
          <em>{summary}</em>
        </span>
        <motion.span animate={{ rotate: open ? 90 : 0 }} transition={spring}>
          <Icon name="chevron-right" size={16} />
        </motion.span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            className="split-section-body"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={spring}
          >
            <div className="split-section-inner">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}
