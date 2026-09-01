import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Icon } from '../components/Icon';
import { ImportSheet } from '../components/ImportSheet';
import { TransactionRow } from '../components/TransactionRow';
import {
  Button, Card, Chip, Confirm, Empty, Segmented, Select, TextInput,
  type SegmentOption, type SelectOption,
} from '../components/ui';
import { MonthNav, periodLabel } from '../components/MonthNav';
import { useStore } from '../lib/store';
import { dayKey, dayLabel, money, shiftMonth } from '../lib/format';
import { itemVariants, listVariants, popover, spring } from '../lib/motion';
import type {
  Transaction, TransactionPatch, TransactionSummary, TxKind,
} from '../lib/types';

type KindFilter = 'all' | TxKind;
/** The windows the strip names outright. */
type NamedRange = 'month' | 'quarter' | 'year' | 'all';
/** …plus the one it grows when a breakdown arrives on a period none of them
 *  name — the dashboard can be set to any number of months. */
type Range = NamedRange | 'window';
type Side = 'either' | 'from' | 'to';

/** Which end of a posting the chosen accounts sit on. Only transfers have two. */
const SIDES: SegmentOption<Side>[] = [
  { value: 'either', label: 'Either way' },
  { value: 'from', label: 'Out of', icon: 'arrow-up-right' },
  { value: 'to', label: 'Into', icon: 'arrow-down-left' },
];

const KIND_FILTERS: SegmentOption<KindFilter>[] = [
  { value: 'all', label: 'All' },
  { value: 'expense', label: 'Out', icon: 'arrow-up-right' },
  { value: 'income', label: 'In', icon: 'arrow-down-left' },
  { value: 'transfer', label: 'Moved', icon: 'arrow-left-right' },
];

const RANGES: SegmentOption<Range>[] = [
  { value: 'month', label: 'Month' },
  { value: 'quarter', label: '3 months' },
  { value: 'year', label: 'Year' },
  { value: 'all', label: 'All time' },
];

/** How many months each named range covers. Zero means unbounded. */
const RANGE_SPAN: Record<NamedRange, number> = { month: 1, quarter: 3, year: 12, all: 0 };

/** Which range a window of `span` months goes by, when one of them names it.
 *  No span at all is a question about the whole book. */
function rangeFor(span: number | undefined): Range {
  if (!span) return 'all';
  const named = (Object.keys(RANGE_SPAN) as NamedRange[]).find((r) => RANGE_SPAN[r] === span);
  return named ?? 'window';
}

/**
 * Rows loaded at a time. Each one animates in on a stagger, so a whole six-year
 * ledger arriving at once would spend minutes doing it — the page is what keeps
 * the list quick, not a cap on what you can reach.
 */
const PAGE = 300;

/**
 * Past a certain length the stagger stops being a flourish and becomes a wait —
 * five thousand rows at 28ms apart is over two minutes of animation. Long lists
 * simply appear.
 */
const STAGGER_UP_TO = 120;
const PLAIN_LIST = { initial: {}, animate: { transition: { staggerChildren: 0 } } };

/** The first and last day a window of `span` months ending at `month` covers.
 *  A span of nothing is all of time, which has no bounds to give. */
function rangeBounds(span: number, month: string) {
  if (span <= 0) return { from: null, to: null };
  const back = span - 1;
  const [y, m] = shiftMonth(month, -back).split('-').map(Number);
  const [ey, em] = month.split('-').map(Number);
  const end = new Date(ey, em, 0);
  return {
    from: `${y}-${String(m).padStart(2, '0')}-01`,
    to: `${ey}-${String(em).padStart(2, '0')}-${String(end.getDate()).padStart(2, '0')}`,
  };
}

export function Transactions({
  onOpenTransaction, onSplitTransaction, onOweTransaction, onRefundTransaction,
  onAddTransaction, accountFocus, categoryFocus, labelFocus,
  picking, pickMany, initialSearch,
}: {
  onOpenTransaction: (tx: Transaction) => void;
  /** Opens a row straight into its split editor. Absent while picking. */
  onSplitTransaction?: (tx: Transaction) => void;
  /** Makes the whole of a row a debt in someone's name. Absent while picking. */
  onOweTransaction?: (tx: Transaction) => void;
  /** Opens a new posting that gives a row back. Absent while picking. */
  onRefundTransaction?: (tx: Transaction) => void;
  onAddTransaction?: () => void;
  /** Set when arriving from an account elsewhere in the app. */
  accountFocus?: { ids: string[]; token: number };
  /** Set when arriving from a category on a breakdown. `span` is how many
   *  months that breakdown was about, when it was about a period at all. */
  categoryFocus?: { ids: string[]; token: number; span?: number };
  /** Set when arriving from a label on the Labels screen. */
  labelFocus?: { ids: string[]; token: number };
  /**
   * Rendered inside the link-a-record modal. The screen's own title and the
   * running totals belong to the page rather than the task, and choosing a row
   * picks it instead of opening it for editing — everything else, the search,
   * the filters and the date ranges, works exactly as it does on the page.
   */
  picking?: boolean;
  /**
   * Picking several at once rather than one — attaching a run of payments to
   * a planned payment, say. The ledger's own selection does the work, so
   * shift-ranges, the day headers and the filters all behave as they do on
   * the page; only what sits in the bar at the bottom changes. The selection
   * outlives a change of search, so a run can be gathered a few at a time.
   */
  pickMany?: { label: string; onConfirm: (ids: string[]) => void };
  /** What the search box starts with, for a picker opened about something. */
  initialSearch?: string;
}) {
  const {
    accounts, categories, labels, month, setMonth, listTransactions, transactionSummary,
    revision, updateTransactions, deleteTransactions, confirmTriage, toast,
  } = useStore();
  const [search, setSearch] = useState(initialSearch ?? '');
  const [debounced, setDebounced] = useState(initialSearch ?? '');
  const [kind, setKind] = useState<KindFilter>('all');
  // Picking a run of past payments is nearly always about more than the
  // month in view, so that picker opens on the whole book.
  const [range, setRange] = useState<Range>(pickMany ? 'all' : 'month');
  // How many months the unnamed window covers, when the strip is on it.
  const [windowSpan, setWindowSpan] = useState(1);
  const [accountIds, setAccountIds] = useState<string[]>([]);
  const [side, setSide] = useState<Side>('either');
  const [categoryIds, setCategoryIds] = useState<string[]>([]);
  const [labelIds, setLabelIds] = useState<string[]>([]);
  const [importOpen, setImportOpen] = useState(false);
  const [catQuery, setCatQuery] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  const [rows, setRows] = useState<Transaction[]>([]);
  const [summary, setSummary] = useState<TransactionSummary | null>(null);
  const [shown, setShown] = useState(PAGE);
  const [loading, setLoading] = useState(true);
  // Rows picked out for one change over all of them. Held by id, so a row
  // stays picked while the list re-queries underneath it.
  const [picked, setPicked] = useState<string[]>([]);
  const [anchor, setAnchor] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const filterAnchor = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(search), 160);
    return () => window.clearTimeout(timer);
  }, [search]);

  // Arriving from an account card: apply its filter. The chips under the
  // toolbar say the list is narrowed rather than mysteriously short.
  useEffect(() => {
    if (!accountFocus?.token) return;
    setAccountIds(accountFocus.ids);
  }, [accountFocus?.token]);

  // Arriving from a breakdown. One that was about a period — the dashboard's
  // — is asking "what was in here in August", so the ledger opens on that same
  // window; one that stands for the whole book sends no period, and every
  // entry filed under the category is the answer.
  useEffect(() => {
    if (!categoryFocus?.token) return;
    setCategoryIds(categoryFocus.ids);
    if (categoryFocus.span) setWindowSpan(categoryFocus.span);
    setRange(rangeFor(categoryFocus.span));
    // Whatever the ledger was last narrowed by is not part of the question
    // being asked, and would quietly leave entries out of the answer.
    setKind('all');
    setAccountIds([]);
    setSearch('');
    setDebounced('');
  }, [categoryFocus?.token]);

  // Arriving from a label: the same idea, over all time and with nothing
  // else narrowing what wears it.
  useEffect(() => {
    if (!labelFocus?.token) return;
    setLabelIds(labelFocus.ids);
    setRange('all');
    setKind('all');
    setAccountIds([]);
    setCategoryIds([]);
    setSearch('');
    setDebounced('');
  }, [labelFocus?.token]);

  // A selected group stands for itself plus every category filed under it.
  const expandedCategoryIds = useMemo(() => {
    if (!categoryIds.length) return null;
    const out = new Set(categoryIds);
    for (const c of categories) {
      if (c.parentId && categoryIds.includes(c.parentId)) out.add(c.id);
    }
    return [...out];
  }, [categoryIds, categories]);

  // How many months the ledger is looking at. Zero is all of time.
  const months = range === 'window' ? windowSpan : RANGE_SPAN[range];

  // The strip only offers the window it arrived on while it is on it: a
  // "6 months" button that nothing on the page put there would be a mystery.
  const ranges = useMemo<SegmentOption<Range>[]>(
    () =>
      range === 'window'
        ? [...RANGES.slice(0, 3), { value: 'window', label: `${windowSpan} months` }, RANGES[3]]
        : RANGES,
    [range, windowSpan],
  );

  useEffect(() => {
    setShown(PAGE);
  }, [debounced, kind, months, accountIds, side, expandedCategoryIds, labelIds, month]);

  useEffect(() => {
    const bounds = rangeBounds(months, month);
    setLoading(true);
    const query = {
      search: debounced || null,
      kinds: kind === 'all' ? null : [kind],
      accountIds: accountIds.length ? accountIds : null,
      accountSide: accountIds.length ? side : null,
      categoryIds: expandedCategoryIds,
      labelIds: labelIds.length ? labelIds : null,
      from: bounds.from,
      to: bounds.to,
    };
    // The totals and the count come from the filter, not from the page: they
    // have to describe the whole match even when only part of it is on screen.
    Promise.all([
      listTransactions({ ...query, limit: shown }),
      transactionSummary(query),
    ])
      .then(([nextRows, nextSummary]) => {
        setRows(nextRows);
        setSummary(nextSummary);
      })
      .catch(() => {
        setRows([]);
        setSummary(null);
      })
      .finally(() => setLoading(false));
  }, [
    debounced, kind, months, accountIds, side, expandedCategoryIds, labelIds, month, shown,
    listTransactions, transactionSummary, revision,
  ]);


  /** Where each row sits in the whole list, so the cascade can run across
   *  the day groups rather than restarting inside each one. */
  const orderOf = useMemo(() => {
    const at = new Map<string, number>();
    rows.forEach((tx, i) => at.set(tx.id, i));
    return at;
  }, [rows]);

  // Day buckets, each with its own net, so the list reads like a statement.
  const days = useMemo(() => {
    const map = new Map<string, Transaction[]>();
    for (const tx of rows) {
      const key = dayKey(tx.occurredAt);
      const bucket = map.get(key);
      if (bucket) bucket.push(tx);
      else map.set(key, [tx]);
    }
    return [...map.entries()].map(([key, items]) => ({
      key,
      items,
      net: items.reduce(
        (sum, tx) =>
          sum + (tx.kind === 'income' ? tx.amount : tx.kind === 'expense' ? -tx.amount : 0),
        0,
      ),
    }));
  }, [rows]);

  // The tree, narrowed by the category search. A group survives if it matches
  // or if any of its children do, and then only the matching children show.
  const visibleGroups = useMemo(() => {
    const term = catQuery.trim().toLowerCase();
    return categories
      .filter((c) => !c.parentId)
      .map((group) => {
        const children = categories.filter((c) => c.parentId === group.id);
        if (!term) return { group, children, matched: false };
        const hits = children.filter((c) => c.name.toLowerCase().includes(term));
        const groupHit = group.name.toLowerCase().includes(term);
        return {
          group,
          children: groupHit ? children : hits,
          matched: groupHit || hits.length > 0,
        };
      })
      .filter((g) => !term || g.matched);
  }, [categories, catQuery]);

  const toggle = (list: string[], id: string) =>
    list.includes(id) ? list.filter((x) => x !== id) : [...list, id];

  // Only what is actually on screen can stay picked: narrowing the filters
  // until a row is gone should not leave it in a change you make afterwards.
  const pickedSet = useMemo(() => {
    const here = new Set(rows.map((r) => r.id));
    return new Set(picked.filter((id) => here.has(id)));
  }, [picked, rows]);

  const pick = (tx: Transaction, range: boolean) => {
    // Shift picks the run between the last one and this, which is how a
    // month of one merchant gets filed in a single go.
    if (range && anchor) {
      const from = rows.findIndex((r) => r.id === anchor);
      const to = rows.findIndex((r) => r.id === tx.id);
      if (from >= 0 && to >= 0) {
        const [a, b] = from < to ? [from, to] : [to, from];
        const run = rows.slice(a, b + 1).map((r) => r.id);
        setPicked((was) => [...new Set([...was, ...run])]);
        setAnchor(tx.id);
        return;
      }
    }
    setPicked((was) => toggle(was, tx.id));
    setAnchor(tx.id);
  };

  // Only the side of the ledger the picked rows are on: filing an expense
  // under an income category is not a thing that can be meant.
  const bulkCategories = useMemo<SelectOption[]>(() => {
    const kinds = new Set(
      rows.filter((r) => pickedSet.has(r.id) && r.kind !== 'transfer').map((r) => r.kind),
    );
    const wanted = kinds.size === 1 ? [...kinds][0] : null;
    return categories
      .filter((c) => !wanted || c.kind === wanted)
      .map((c) => ({
        value: c.id,
        label: c.name,
        icon: c.icon,
        color: c.color,
        child: !!c.parentId,
        // A group names what is under it; things are filed on the leaves.
        heading: !c.parentId && categories.some((k) => k.parentId === c.id),
        under: c.parentId
          ? categories.find((p) => p.id === c.parentId)?.name ?? undefined
          : undefined,
      }));
  }, [categories, rows, pickedSet]);

  const bulkAccounts = useMemo<SelectOption[]>(
    () =>
      accounts
        .filter((a) => !a.archived)
        .map((a) => ({
          value: a.id,
          label: a.name,
          hint: a.institution ?? undefined,
          icon: a.icon,
          color: a.color,
        })),
    [accounts],
  );

  const clearPicked = () => {
    setPicked([]);
    setAnchor(null);
  };

  // The popup dismisses like any other: a click elsewhere, or Escape.
  useEffect(() => {
    if (!showFilters) return;
    const onDown = (e: MouseEvent) => {
      if (!filterAnchor.current?.contains(e.target as Node)) setShowFilters(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setShowFilters(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [showFilters]);

  const clearFilters = () => {
    setAccountIds([]);
    setCategoryIds([]);
    setLabelIds([]);
    setSide('either');
  };

  // Escape drops a selection, the way it dismisses everything else.
  useEffect(() => {
    if (!picked.length) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && clearPicked();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [picked.length]);

  // What a change can be applied to, which is not always everything picked:
  // a transfer has no category, and a split bill takes its own from its parts.
  const chosen = rows.filter((r) => pickedSet.has(r.id));
  const categorisable = chosen.filter((r) => r.kind !== 'transfer' && !r.splits.length).length;

  const applyToPicked = async (patch: TransactionPatch, said: string) => {
    setWorking(true);
    try {
      const done = await updateTransactions([...pickedSet], patch);
      toast(
        done.skipped
          ? `${said} · ${done.skipped} left alone`
          : `${said}`,
      );
      clearPicked();
    } catch {
      /* the store has already said what went wrong */
    } finally {
      setWorking(false);
    }
  };

  // A bulk delete is the one action here with no way back, so it is asked
  // for twice: once on the toolbar, once in a dialog that says how many.
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const removePicked = async () => {
    setConfirmingDelete(false);
    setWorking(true);
    try {
      const gone = await deleteTransactions([...pickedSet]);
      toast(`${gone} ${gone === 1 ? 'entry' : 'entries'} deleted`);
      clearPicked();
    } catch {
      /* the store has already said what went wrong */
    } finally {
      setWorking(false);
    }
  };

  // The imported entries waiting to be looked over, and whether the list is
  // already showing them.
  const triage = labels.find((l) => l.name === 'Triage');
  const triageActive = !!triage && labelIds.includes(triage.id);
  const reviewTriage = () => {
    if (!triage) return;
    setLabelIds([triage.id]);
    setRange('all');
    setKind('all');
    setAccountIds([]);
    setCategoryIds([]);
    setSearch('');
    setDebounced('');
  };

  // "These are filed right" — Triage comes off, and how each was filed is
  // remembered against its counterparty for the next import.
  const reviewable =
    chosenHaveTriage(rows, pickedSet) && pickedSet.size > 0;
  const confirmPicked = async () => {
    setWorking(true);
    try {
      const done = await confirmTriage([...pickedSet]);
      toast(`${done} reviewed · how they're filed is remembered`);
      clearPicked();
    } catch {
      /* the store has already said what went wrong */
    } finally {
      setWorking(false);
    }
  };

  const activeFilters =
    accountIds.length + categoryIds.length + labelIds.length + (side === 'either' ? 0 : 1);
  const total = summary?.count ?? rows.length;
  const remaining = Math.max(total - rows.length, 0);
  const listing = rows.length > STAGGER_UP_TO ? PLAIN_LIST : listVariants;
  // Closed accounts keep their history, and some of it is the only history
  // there is — the Wallet import parks orphaned transfer legs against an
  // archived "Unlinked" account. Leaving them out made those unfindable.
  const live = accounts.filter((a) => !a.archived && !a.system);
  const closed = accounts.filter((a) => a.archived);

  return (
    <div className={`screen ${picking ? 'is-picking' : ''}`}>
      <header className="screen-head">
        {picking ? (
          <p className="picking-count">
            {total} {total === 1 ? 'entry' : 'entries'}
            {months ? ` · ${periodLabel(month, months)}` : ' · all time'}
          </p>
        ) : (
          <div>
            <h1>Transactions</h1>
            <p>
              {total} {total === 1 ? 'entry' : 'entries'}
              {months ? ` · ${periodLabel(month, months)}` : ' · all time'}
            </p>
          </div>
        )}
        <div className="head-actions">
          {months > 0 && <MonthNav month={month} onChange={setMonth} span={months} />}
          {!picking && (
            <>
              <Button icon="file-up" onClick={() => setImportOpen(true)}>
                Import
              </Button>
              <Button tone="primary" icon="plus" onClick={onAddTransaction}>
                Add transaction
              </Button>
            </>
          )}
        </div>
      </header>

      <div className="tx-toolbar">
        <div className="search-box">
          <Icon name="search" size={16} />
          <TextInput
            value={search}
            placeholder="Search merchant, note, account or category…"
            onChange={(e) => setSearch(e.target.value)}
          />
          {search && (
            <button className="search-clear" onClick={() => setSearch('')} aria-label="Clear">
              <Icon name="x" size={14} />
            </button>
          )}
        </div>
        <Segmented options={KIND_FILTERS} value={kind} onChange={setKind} name="tx-filter" size="sm" />
        <Segmented options={ranges} value={range} onChange={setRange} name="tx-range" size="sm" />
        <div className="filter-anchor" ref={filterAnchor}>
          <Button
            tone={showFilters || activeFilters ? 'primary' : 'secondary'}
            size="sm"
            icon="list-filter"
            onClick={() => setShowFilters((s) => !s)}
          >
            {activeFilters ? `Filters · ${activeFilters}` : 'Filters'}
          </Button>

          {/* The filters live in a popup off the button rather than a tray in
              the page, so opening them doesn't shove the ledger around. */}
          <AnimatePresence>
            {showFilters && (
              <motion.div
                className="filter-pop"
                variants={popover}
                initial="initial"
                animate="animate"
                exit="exit"
              >
                <div className="filter-group">
                  <div className="filter-head">
                    <span>Accounts</span>
                    {accountIds.length > 0 && (
                      <Segmented
                        options={SIDES}
                        value={side}
                        onChange={setSide}
                        name="tx-side"
                        size="sm"
                      />
                    )}
                  </div>
                  <div className="chip-row">
                    {live.map((a) => (
                      <Chip
                        key={a.id}
                        color={a.color}
                        active={accountIds.includes(a.id)}
                        onClick={() => setAccountIds((l) => toggle(l, a.id))}
                      >
                        {a.name}
                      </Chip>
                    ))}
                    {closed.length > 0 && (
                      <span className="chip-closed">
                        {closed.map((a) => (
                          <Chip
                            key={a.id}
                            color={a.color}
                            active={accountIds.includes(a.id)}
                            onClick={() => setAccountIds((l) => toggle(l, a.id))}
                          >
                            {a.name}
                            <em>closed</em>
                          </Chip>
                        ))}
                      </span>
                    )}
                  </div>
                  {accountIds.length > 0 && side !== 'either' && (
                    <p className="filter-note">
                      {side === 'from' ? 'Money leaving' : 'Money arriving in'}{' '}
                      {accountIds.length === 1 ? 'that account' : 'those accounts'} — which only
                      narrows transfers, since income and expenses touch one side.
                    </p>
                  )}
                </div>

                {kind === 'transfer' ? (
                  <div className="filter-group">
                    <span>Categories</span>
                    <p className="filter-note">
                      Transfers move money between your own accounts, so they are never
                      categorised. Filter them by account instead.
                    </p>
                  </div>
                ) : (
                  <div className="filter-group">
                    <div className="filter-head">
                      <span>Categories</span>
                      <div className="filter-search">
                        <Icon name="search" size={13} />
                        <TextInput
                          value={catQuery}
                          placeholder="Find a category"
                          onChange={(e) => setCatQuery(e.target.value)}
                        />
                        {catQuery && (
                          <button onClick={() => setCatQuery('')} aria-label="Clear">
                            <Icon name="x" size={12} />
                          </button>
                        )}
                      </div>
                    </div>
                    <div className="chip-tree">
                      {visibleGroups.length === 0 && (
                        <p className="filter-note">Nothing matches “{catQuery}”.</p>
                      )}
                      {visibleGroups.map(({ group, children }) => {
                        const groupOn = categoryIds.includes(group.id);
                        return (
                          <div key={group.id} className="cat-branch">
                            <Chip
                              color={group.color}
                              active={groupOn}
                              onClick={() => setCategoryIds((l) => toggle(l, group.id))}
                            >
                              {group.name}
                            </Chip>
                            {children.length > 0 && (
                              <div className="cat-children">
                                {children.map((child) => (
                                  <Chip
                                    key={child.id}
                                    color={child.color}
                                    active={groupOn || categoryIds.includes(child.id)}
                                    onClick={() =>
                                      // Picking one out of a selected group narrows
                                      // to it, rather than adding a redundant filter.
                                      setCategoryIds((l) =>
                                        groupOn
                                          ? [...l.filter((id) => id !== group.id), child.id]
                                          : toggle(l, child.id),
                                      )
                                    }
                                  >
                                    {child.name}
                                  </Chip>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {labels.length > 0 && (
                  <div className="filter-group">
                    <span>Labels</span>
                    <div className="chip-row">
                      {labels.map((label) => (
                        <Chip
                          key={label.id}
                          color={label.color}
                          count={label.count}
                          active={labelIds.includes(label.id)}
                          onClick={() => setLabelIds((l) => toggle(l, label.id))}
                        >
                          {label.name}
                        </Chip>
                      ))}
                    </div>
                  </div>
                )}

                {activeFilters > 0 && (
                  <button className="filter-clear" onClick={clearFilters}>
                    <Icon name="x" size={13} /> Clear filters
                  </button>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* With the popup closed, what the list is narrowed by stays in view —
          one chip per filter, and any of them a click to lift off. */}
      {!showFilters && activeFilters > 0 && (
        <div className="filter-summary">
          {side !== 'either' && (
            <Chip active onClick={() => setSide('either')}>
              <Icon name={side === 'from' ? 'arrow-up-right' : 'arrow-down-left'} size={12} />
              {side === 'from' ? 'Out of' : 'Into'}
              <Icon name="x" size={11} />
            </Chip>
          )}
          {accountIds.map((id) => {
            const a = accounts.find((x) => x.id === id);
            return a && (
              <Chip
                key={id}
                color={a.color}
                active
                onClick={() => setAccountIds((l) => l.filter((x) => x !== id))}
              >
                {a.name}
                <Icon name="x" size={11} />
              </Chip>
            );
          })}
          {categoryIds.map((id) => {
            const c = categories.find((x) => x.id === id);
            return c && (
              <Chip
                key={id}
                color={c.color}
                active
                onClick={() => setCategoryIds((l) => l.filter((x) => x !== id))}
              >
                {c.name}
                <Icon name="x" size={11} />
              </Chip>
            );
          })}
          {labelIds.map((id) => {
            const label = labels.find((x) => x.id === id);
            return label && (
              <Chip
                key={id}
                color={label.color}
                active
                onClick={() => setLabelIds((l) => l.filter((x) => x !== id))}
              >
                {label.name}
                <Icon name="x" size={11} />
              </Chip>
            );
          })}
          <button className="filter-clear" onClick={clearFilters}>
            <Icon name="x" size={13} /> Clear filters
          </button>
        </div>
      )}

      {/* Imported entries queue up under one label until a person has looked
          them over; the banner is the way into that queue. */}
      <AnimatePresence initial={false}>
        {!picking && triage && triage.count > 0 && !triageActive && (
          <motion.div
            className="triage-banner"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={spring}
          >
            <span className="triage-banner-text">
              <Icon name="inbox" size={15} />
              <strong>{triage.count}</strong> imported {triage.count === 1 ? 'entry' : 'entries'} waiting
              for a look — confirm how they're filed and future imports will file them alike.
            </span>
            <Button size="sm" tone="primary" onClick={reviewTriage}>
              Review
            </Button>
          </motion.div>
        )}
      </AnimatePresence>

      {!picking && <div className="totals-strip">
        <Total label="Money in" value={summary?.income ?? 0} tone="in" />
        <Total label="Money out" value={summary?.expense ?? 0} tone="out" />
        <Total
          label="Net"
          value={(summary?.income ?? 0) - (summary?.expense ?? 0)}
          tone="net"
          signed
        />
      </div>}

      <Card padded={false} className="ledger">
        {loading && rows.length === 0 ? (
          <div className="skeletons">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="skeleton-row" style={{ animationDelay: `${i * 60}ms` }} />
            ))}
          </div>
        ) : days.length === 0 ? (
          <div className="card-pad">
            <Empty
              icon="search"
              title="Nothing matches"
              body={
                months
                  ? `No entries in ${periodLabel(month, months)} that fit these filters — there may be some further back.`
                  : 'Nothing here fits those filters.'
              }
              action={
                <div className="welcome-actions">
                  {months > 0 && (
                    <Button tone="primary" onClick={() => setRange('all')}>
                      Search all time
                    </Button>
                  )}
                  <Button
                    tone="secondary"
                    onClick={() => {
                      setSearch(''); setKind('all'); setRange('all');
                      setAccountIds([]); setCategoryIds([]); setLabelIds([]);
                    }}
                  >
                    Clear filters
                  </Button>
                </div>
              }
            />
          </div>
        ) : (
          <motion.div
            // Rows that can be ticked get a column for their boxes, which the
            // day heads and the split strips line up with.
            className={`ledger-days ${picking && !pickMany ? '' : 'is-selectable'}`}
            variants={listing}
            initial="initial"
            animate="animate"
          >
            {days.map((day) => (
              <section key={day.key} className="day-group">
                <header className="day-head">
                  <span>{dayLabel(day.key)}</span>
                  <span className={`day-net ${day.net >= 0 ? 'is-up' : ''}`}>
                    {money(day.net, { sign: day.net > 0 })}
                  </span>
                </header>
                <motion.div
                  className={`tx-list ${pickedSet.size ? 'is-picking' : ''}`}
                  variants={listing}
                >
                  {day.items.map((tx) => (
                    <TransactionRow
                      key={tx.id}
                      tx={tx}
                      onClick={
                        pickMany ? () => pick(tx, false) : () => onOpenTransaction(tx)
                      }
                      onSplit={
                        picking || !onSplitTransaction
                          ? undefined
                          : () => onSplitTransaction(tx)
                      }
                      onDebt={
                        picking || !onOweTransaction
                          ? undefined
                          : () => onOweTransaction(tx)
                      }
                      onRefund={
                        picking || !onRefundTransaction
                          ? undefined
                          : () => onRefundTransaction(tx)
                      }
                      selected={pickedSet.has(tx.id)}
                      enterDelay={
                        // Long lists simply appear; past a point the stagger
                        // stops being a flourish and becomes a wait.
                        rows.length > STAGGER_UP_TO
                          ? 0
                          : (orderOf.get(tx.id) ?? 0) * 0.028
                      }
                      onSelect={
                        picking && !pickMany ? undefined : (range) => pick(tx, range)
                      }
                    />
                  ))}
                </motion.div>
              </section>
            ))}
          </motion.div>
        )}
      </Card>

      {remaining > 0 && (
        <div className="ledger-more">
          <span>
            Showing {rows.length.toLocaleString('en-IN')} of{' '}
            {total.toLocaleString('en-IN')}
          </span>
          <div className="ledger-more-actions">
            <Button
              size="sm"
              onClick={() => setShown((n) => n + PAGE)}
              disabled={loading}
            >
              {loading ? 'Loading…' : `Show ${Math.min(PAGE, remaining)} more`}
            </Button>
            {remaining > PAGE && (
              <Button
                size="sm"
                tone="ghost"
                onClick={() => setShown(total)}
                disabled={loading}
              >
                Show all {remaining.toLocaleString('en-IN')}
              </Button>
            )}
          </div>
        </div>
      )}

      {/* One change over everything picked out. It floats over the ledger
          rather than sitting in it, so the rows underneath stay where they
          were while you decide. */}
      <AnimatePresence>
        {pickedSet.size > 0 && (
          <motion.div
            className="bulk-bar"
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 12 }}
            transition={spring}
          >
            <span className="bulk-count">
              <strong>{pickedSet.size}</strong>
              selected
            </span>

            {pickMany ? (
              <div className="bulk-actions">
                <Button size="sm" tone="ghost" onClick={() => setPicked([])}>
                  Clear
                </Button>
                <Button
                  size="sm"
                  tone="primary"
                  icon="link"
                  // The whole selection, not the visible part of it: picking
                  // across two searches is the ordinary way a run of
                  // payments gets gathered, and `chosen` only ever holds the
                  // rows still on screen.
                  onClick={() => pickMany.onConfirm([...pickedSet])}
                >
                  {pickMany.label} {pickedSet.size}
                </Button>
              </div>
            ) : (
              <>
            <div className="bulk-fields">
              <Select
                options={bulkCategories}
                value={null}
                onChange={(id) =>
                  id &&
                  applyToPicked(
                    { categoryId: id },
                    `Filed under ${categories.find((c) => c.id === id)?.name ?? 'category'}`,
                  )
                }
                placeholder={
                  categorisable === pickedSet.size
                    ? 'Change category'
                    : `Change category · ${categorisable} of ${pickedSet.size}`
                }
                searchable
                searchPlaceholder="Find a category"
                disabled={working || categorisable === 0}
              />
              <Select
                options={bulkAccounts}
                value={null}
                onChange={(id) =>
                  id &&
                  applyToPicked(
                    { accountId: id },
                    `Moved to ${accounts.find((a) => a.id === id)?.name ?? 'account'}`,
                  )
                }
                placeholder="Change account"
                searchable
                searchPlaceholder="Find an account"
                disabled={working}
              />
            </div>

            <div className="bulk-actions">
              {reviewable && (
                <Button
                  size="sm"
                  tone="primary"
                  icon="check-check"
                  onClick={confirmPicked}
                  disabled={working}
                >
                  Mark reviewed
                </Button>
              )}
              {pickedSet.size < rows.length && (
                <Button
                  size="sm"
                  tone="ghost"
                  onClick={() => setPicked(rows.map((r) => r.id))}
                  disabled={working}
                >
                  All {rows.length.toLocaleString('en-IN')}
                </Button>
              )}
              <Button
                size="sm"
                tone="danger"
                icon="trash-2"
                onClick={() => setConfirmingDelete(true)}
                disabled={working}
              >
                Delete
              </Button>
              <Button size="sm" tone="ghost" onClick={clearPicked} disabled={working}>
                Cancel
              </Button>
            </div>
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      <ImportSheet open={importOpen} onClose={() => setImportOpen(false)} />

      <Confirm
        open={confirmingDelete}
        title={
          pickedSet.size === 1
            ? 'Delete this entry?'
            : `Delete ${pickedSet.size.toLocaleString('en-IN')} entries?`
        }
        confirmLabel={pickedSet.size === 1 ? 'Delete' : `Delete ${pickedSet.size}`}
        busy={working}
        onConfirm={removePicked}
        onCancel={() => setConfirmingDelete(false)}
      >
        {pickedSet.size === 1
          ? 'This cannot be undone.'
          : 'They go together, and this cannot be undone.'}
      </Confirm>
    </div>
  );
}

/** Whether everything picked still wears the Triage label — the only rows
 *  "Mark reviewed" is a sensible thing to say about. */
function chosenHaveTriage(rows: Transaction[], pickedSet: Set<string>) {
  const chosen = rows.filter((r) => pickedSet.has(r.id));
  return (
    chosen.length > 0 &&
    chosen.every((r) => r.labels.some((l) => l.name === 'Triage'))
  );
}

function Total({
  label, value, tone, signed,
}: { label: string; value: number; tone: string; signed?: boolean }) {
  return (
    <motion.div
      className={`total total-${tone}`}
      variants={itemVariants}
      initial="initial"
      animate="animate"
    >
      <span>{label}</span>
      <strong>{money(value, { sign: signed && value > 0 })}</strong>
    </motion.div>
  );
}
