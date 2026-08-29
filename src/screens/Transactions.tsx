import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Icon } from '../components/Icon';
import { TransactionRow } from '../components/TransactionRow';
import { Button, Card, Chip, Empty, Segmented, TextInput, type SegmentOption } from '../components/ui';
import { MonthNav, periodLabel } from '../components/MonthNav';
import { useStore } from '../lib/store';
import { dayKey, dayLabel, money, shiftMonth } from '../lib/format';
import { itemVariants, listVariants, spring } from '../lib/motion';
import type { Transaction, TransactionSummary, TxKind } from '../lib/types';

type KindFilter = 'all' | TxKind;
type Range = 'month' | 'quarter' | 'year' | 'all';
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

/** How many months each range covers. Zero means unbounded. */
const RANGE_SPAN: Record<Range, number> = { month: 1, quarter: 3, year: 12, all: 0 };

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

function rangeBounds(range: Range, month: string) {
  if (range === 'all') return { from: null, to: null };
  const back = RANGE_SPAN[range] - 1;
  const [y, m] = shiftMonth(month, -back).split('-').map(Number);
  const [ey, em] = month.split('-').map(Number);
  const end = new Date(ey, em, 0);
  return {
    from: `${y}-${String(m).padStart(2, '0')}-01`,
    to: `${ey}-${String(em).padStart(2, '0')}-${String(end.getDate()).padStart(2, '0')}`,
  };
}

export function Transactions({
  onOpenTransaction, onSplitTransaction, onAddTransaction, accountFocus, picking,
}: {
  onOpenTransaction: (tx: Transaction) => void;
  /** Opens a row straight into its split editor. Absent while picking. */
  onSplitTransaction?: (tx: Transaction) => void;
  onAddTransaction?: () => void;
  /** Set when arriving from an account elsewhere in the app. */
  accountFocus?: { ids: string[]; token: number };
  /**
   * Rendered inside the link-a-record modal. The screen's own title and the
   * running totals belong to the page rather than the task, and choosing a row
   * picks it instead of opening it for editing — everything else, the search,
   * the filters and the date ranges, works exactly as it does on the page.
   */
  picking?: boolean;
}) {
  const {
    accounts, categories, month, setMonth, listTransactions, transactionSummary, revision,
  } = useStore();
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [kind, setKind] = useState<KindFilter>('all');
  const [range, setRange] = useState<Range>('month');
  const [accountIds, setAccountIds] = useState<string[]>([]);
  const [side, setSide] = useState<Side>('either');
  const [categoryIds, setCategoryIds] = useState<string[]>([]);
  const [catQuery, setCatQuery] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  const [rows, setRows] = useState<Transaction[]>([]);
  const [summary, setSummary] = useState<TransactionSummary | null>(null);
  const [shown, setShown] = useState(PAGE);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(search), 160);
    return () => window.clearTimeout(timer);
  }, [search]);

  // Arriving from an account card: apply its filter and show the tray, so it
  // is obvious the list is narrowed rather than mysteriously short.
  useEffect(() => {
    if (!accountFocus?.token) return;
    setAccountIds(accountFocus.ids);
    setShowFilters(true);
  }, [accountFocus?.token]);

  // A selected group stands for itself plus every category filed under it.
  const expandedCategoryIds = useMemo(() => {
    if (!categoryIds.length) return null;
    const out = new Set(categoryIds);
    for (const c of categories) {
      if (c.parentId && categoryIds.includes(c.parentId)) out.add(c.id);
    }
    return [...out];
  }, [categoryIds, categories]);

  useEffect(() => {
    setShown(PAGE);
  }, [debounced, kind, range, accountIds, side, expandedCategoryIds, month]);

  useEffect(() => {
    const bounds = rangeBounds(range, month);
    setLoading(true);
    const query = {
      search: debounced || null,
      kinds: kind === 'all' ? null : [kind],
      accountIds: accountIds.length ? accountIds : null,
      accountSide: accountIds.length ? side : null,
      categoryIds: expandedCategoryIds,
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
    debounced, kind, range, accountIds, side, expandedCategoryIds, month, shown,
    listTransactions, transactionSummary, revision,
  ]);


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

  const activeFilters =
    accountIds.length + categoryIds.length + (side === 'either' ? 0 : 1);
  const total = summary?.count ?? rows.length;
  const remaining = Math.max(total - rows.length, 0);
  const listing = rows.length > STAGGER_UP_TO ? PLAIN_LIST : listVariants;
  // Closed accounts keep their history, and some of it is the only history
  // there is — the Wallet import parks orphaned transfer legs against an
  // archived "Unlinked" account. Leaving them out made those unfindable.
  const live = accounts.filter((a) => !a.archived);
  const closed = accounts.filter((a) => a.archived);

  return (
    <div className={`screen ${picking ? 'is-picking' : ''}`}>
      <header className="screen-head">
        {picking ? (
          <p className="picking-count">
            {total} {total === 1 ? 'entry' : 'entries'}
            {range === 'all'
              ? ' · all time'
              : ` · ${periodLabel(month, RANGE_SPAN[range])}`}
          </p>
        ) : (
          <div>
            <h1>Transactions</h1>
            <p>
              {total} {total === 1 ? 'entry' : 'entries'}
              {range === 'all'
                ? ' · all time'
                : ` · ${periodLabel(month, RANGE_SPAN[range])}`}
            </p>
          </div>
        )}
        <div className="head-actions">
          {range !== 'all' && (
            <MonthNav month={month} onChange={setMonth} span={RANGE_SPAN[range]} />
          )}
          {!picking && (
            <Button tone="primary" icon="plus" onClick={onAddTransaction}>
              Add transaction
            </Button>
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
        <Segmented options={RANGES} value={range} onChange={setRange} name="tx-range" size="sm" />
        <Button
          tone={showFilters || activeFilters ? 'primary' : 'secondary'}
          size="sm"
          icon="list-filter"
          onClick={() => setShowFilters((s) => !s)}
        >
          {activeFilters ? `Filters · ${activeFilters}` : 'Filters'}
        </Button>
      </div>

      <AnimatePresence initial={false}>
        {showFilters && (
          <motion.div
            className="filter-tray"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={spring}
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

            {activeFilters > 0 && (
              <button
                className="filter-clear"
                onClick={() => {
                  setAccountIds([]);
                  setCategoryIds([]);
                  setSide('either');
                }}
              >
                <Icon name="x" size={13} /> Clear filters
              </button>
            )}
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
        <Total label="Transferred" value={summary?.transferred ?? 0} tone="moved" />
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
                range === 'all'
                  ? 'Nothing here fits those filters.'
                  : `No entries in ${periodLabel(month, RANGE_SPAN[range])} that fit these filters — there may be some further back.`
              }
              action={
                <div className="welcome-actions">
                  {range !== 'all' && (
                    <Button tone="primary" onClick={() => setRange('all')}>
                      Search all time
                    </Button>
                  )}
                  <Button
                    tone="secondary"
                    onClick={() => {
                      setSearch(''); setKind('all'); setRange('all');
                      setAccountIds([]); setCategoryIds([]);
                    }}
                  >
                    Clear filters
                  </Button>
                </div>
              }
            />
          </div>
        ) : (
          <motion.div variants={listing} initial="initial" animate="animate">
            {days.map((day) => (
              <section key={day.key} className="day-group">
                <header className="day-head">
                  <span>{dayLabel(day.key)}</span>
                  <span className={day.net >= 0 ? 'is-up' : ''}>
                    {money(day.net, { sign: day.net > 0 })}
                  </span>
                </header>
                <motion.div className="tx-list" variants={listing}>
                  {day.items.map((tx) => (
                    <TransactionRow
                      key={tx.id}
                      tx={tx}
                      onClick={() => onOpenTransaction(tx)}
                      onSplit={
                        picking || !onSplitTransaction
                          ? undefined
                          : () => onSplitTransaction(tx)
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
    </div>
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
