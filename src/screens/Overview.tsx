import { useEffect, useMemo, useState } from 'react';
import { motion } from 'motion/react';
import { Icon } from '../components/Icon';
import { MonthNav, periodLabel } from '../components/MonthNav';
import { BigMoney, CountMoney } from '../components/Money';
import { DailyBars, Donut, Sparkline, SplitBar } from '../components/charts';
import { TransactionRow } from '../components/TransactionRow';
import { Button, Card, CardHead, Empty, Meter } from '../components/ui';
import { useStore } from '../lib/store';
import {
  accountWorth, compactMoney, dayLabel, money, monthKey, monthLabel, percentDelta,
} from '../lib/format';
import { itemVariants, listVariants, spring } from '../lib/motion';
import { isDeposit } from '../lib/types';
import type {
  FlowPoint, HoldingKind, InvestmentTab, Paise, Transaction,
} from '../lib/types';

/** One face on the wealth card: an account, or the holdings kept outside one. */
interface Tile {
  key: string;
  name: string;
  value: Paise;
  icon: string;
  color: string;
  hint: string;
  open: () => void;
}

/** Holdings that sit in no account of their own are gathered under one tile
 *  each. Only gold and funds can: a deposit's money always sits somewhere. */
const LOOSE: Partial<Record<HoldingKind, { name: string; icon: string; color: string }>> = {
  gold: { name: 'Gold', icon: 'coins', color: 'var(--amber)' },
  fund: { name: 'Mutual funds', icon: 'trending-up', color: 'var(--violet)' },
};

export function Overview({
  onOpenTransaction, onAddTransaction, onGoTransactions, onOpenAccount, onOpenCategory,
  onGoInvestments,
}: {
  onOpenTransaction: (tx: Transaction) => void;
  onAddTransaction: () => void;
  onGoTransactions: () => void;
  /** Jump to Transactions filtered to one account. */
  onOpenAccount: (accountId: string) => void;
  /** Opens the ledger filtered to one category, over all time. */
  onOpenCategory: (categoryId: string) => void;
  /** Jump to Investments, on the tab that holds what was clicked. */
  onGoInvestments: (tab: InvestmentTab) => void;
}) {
  const {
    overview, accounts, holdings, month, setMonth, span, setSpan, listTransactions, revision,
  } = useStore();
  const [recent, setRecent] = useState<Transaction[]>([]);

  useEffect(() => {
    listTransactions({ limit: 7 }).then(setRecent).catch(() => setRecent([]));
  }, [listTransactions, revision]);

  const live = useMemo(() => accounts.filter((a) => !a.archived), [accounts]);

  // What money you have, whatever shape it is in. Accounts come first, and
  // then the holdings that answer to no account — gold is kept in a locker
  // rather than an account, so nothing in the ledger would otherwise carry it
  // onto this card. Both lead to where the thing itself lives.
  const tiles = useMemo<Tile[]>(() => {
    const held = live.map<Tile>((account) => {
      const investment = account.kind === 'investment';
      // Which tab this account's holdings live under, so the card lands
      // where what it holds actually is.
      const held = holdings.find((h) => h.accountId === account.id)?.kind ?? 'fund';
      const kind: InvestmentTab = isDeposit(held) ? 'deposit' : held;
      return {
        key: account.id,
        name: account.name,
        value: accountWorth(account),
        icon: account.icon,
        color: account.color,
        hint: investment ? `See ${account.name} in investments` : `See ${account.name} transactions`,
        open: () => (investment ? onGoInvestments(kind) : onOpenAccount(account.id)),
      };
    });

    const loose = new Map<HoldingKind, Paise>();
    for (const holding of holdings) {
      if (holding.closed || holding.accountId || !holding.marketValue) continue;
      loose.set(holding.kind, (loose.get(holding.kind) ?? 0) + holding.marketValue);
    }

    return [
      ...held,
      ...[...loose].flatMap<Tile>(([kind, value]) => {
        // Only the priced kinds can sit outside an account, so anything else
        // has no tile of its own to stand under.
        const what = LOOSE[kind];
        if (!what) return [];
        return [{
          key: `holdings-${kind}`,
          name: what.name,
          value,
          icon: what.icon,
          color: what.color,
          hint: `See ${what.name.toLowerCase()} in investments`,
          open: () => onGoInvestments(kind === 'gold' ? 'gold' : 'fund'),
        }];
      }),
    ];
  }, [live, holdings, onOpenAccount, onGoInvestments]);

  // A day a bar is readable; a year of days is 365 slivers. Anything longer
  // than a month is folded into one column per month instead.
  const flow = useMemo<FlowPoint[]>(() => {
    const days = overview?.dailyFlow ?? [];
    if (span <= 1) return days;
    const months = new Map<string, FlowPoint>();
    for (const day of days) {
      const bucket = day.bucket.slice(0, 7);
      const at = months.get(bucket) ?? { bucket, income: 0, expense: 0 };
      at.income += day.income;
      at.expense += day.expense;
      months.set(bucket, at);
    }
    return [...months.values()];
  }, [overview, span]);

  if (!overview) return null;

  const net = overview.income - overview.expense;
  const spendDelta = percentDelta(overview.expense, overview.prevExpense);
  const incomeDelta = percentDelta(overview.income, overview.prevIncome);
  const topCategories = overview.topCategories.slice(0, 6);
  const categoryPeak = topCategories[0]?.total ?? 1;
  const isNow = month === monthKey() && span === 1;
  const label = periodLabel(month, span);

  return (
    <div className="screen">
      <header className="screen-head">
        <div>
          <h1>Overview</h1>
          <p>
            {isNow
              ? 'Where your money stands right now.'
              : `A look back at ${label}.`}
          </p>
        </div>
        <MonthNav month={month} onChange={setMonth} span={span} onSpanChange={setSpan} />
      </header>

      <div className="overview-grid">
        {/* ----------------------------------------------------------- hero */}
        <motion.section
          className="hero"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={spring}
        >
          <div className="hero-top">
            <div>
              <span className="hero-label">Total balance</span>
              <BigMoney value={overview.netWorth} className="hero-amount" />
              <div className="hero-chips">
                <span className="hero-chip">
                  <i className="dot dot-in" />
                  Liquid {money(overview.liquid)}
                </span>
                {overview.debt > 0 && (
                  <span className="hero-chip">
                    <i className="dot dot-out" />
                    Owed {money(overview.debt)}
                  </span>
                )}
                {overview.lentOutstanding > 0 && (
                  <span className="hero-chip">
                    <i className="dot dot-in" />
                    Lent out {money(overview.lentOutstanding)}
                  </span>
                )}
                <span className={`hero-chip ${net >= 0 ? 'is-up' : 'is-down'}`}>
                  <Icon name={net >= 0 ? 'trending-up' : 'trending-down'} size={13} />
                  {money(Math.abs(net))} {net >= 0 ? 'saved' : 'over'}{' '}
                  {span > 1 ? 'this period' : 'this month'}
                </span>
              </div>
            </div>
            <Button tone="primary" icon="plus" onClick={onAddTransaction}>
              Add transaction
            </Button>
          </div>

          <div className="hero-chart">
            <Sparkline
              values={overview.balanceSeries}
              height={104}
              stroke="var(--green-bright)"
            />
          </div>

          <div className="hero-accounts">
            {tiles.map((tile, i) => (
              <motion.button
                key={tile.key}
                className="hero-account"
                onClick={tile.open}
                title={tile.hint}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ ...spring, delay: 0.05 + i * 0.03 }}
              >
                <span className="hero-account-glyph" style={{ background: tile.color }}>
                  <Icon name={tile.icon} size={14} />
                </span>
                <span className="hero-account-text">
                  <strong>{tile.name}</strong>
                  <span className={tile.value < 0 ? 'is-owed' : undefined}>
                    {money(tile.value)}
                  </span>
                </span>
              </motion.button>
            ))}
          </div>
        </motion.section>

        {/* ------------------------------------------------------ flow cards */}
        <Card className="flow-card">
          <CardHead title={span > 1 ? 'This period' : 'This month'} hint={label} />
          <div className="flow-figures">
            <div>
              <span className="figure-label">
                <i className="dot dot-in" /> Money in
              </span>
              <CountMoney value={overview.income} className="figure-value" />
              <Delta value={incomeDelta} good="up" span={span} />
            </div>
            <div>
              <span className="figure-label">
                <i className="dot dot-out" /> Money out
              </span>
              <CountMoney value={overview.expense} className="figure-value" />
              <Delta value={spendDelta} good="down" span={span} />
            </div>
          </div>
          <SplitBar income={overview.income} expense={overview.expense} />
          <div className="flow-foot">
            <span>{span > 1 ? 'Monthly spend' : 'Daily spend'}</span>
            <DailyBars
              points={flow}
              height={54}
              labelOf={span > 1 ? monthLabel : undefined}
            />
          </div>
        </Card>

        {/* -------------------------------------------------------- category */}
        <Card className="donut-card">
          <CardHead
            title="Where it went"
            hint={`${overview.topCategories.length} categories`}
          />
          {topCategories.length ? (
            <div className="donut-layout">
              <Donut
                slices={topCategories.map((c) => ({
                  id: c.categoryId,
                  label: c.name,
                  value: c.total,
                  color: c.color,
                }))}
                centerLabel="Total spend"
                centerValue={compactMoney(overview.expense)}
                onSelect={onOpenCategory}
              />
              <motion.ul
                key={`${month}-${span}`}
                className="cat-list"
                variants={listVariants}
                initial="initial"
                animate="animate"
              >
                {topCategories.map((c) => (
                  <motion.li key={c.categoryId} variants={itemVariants}>
                    <button
                      type="button"
                      className="cat-row"
                      onClick={() => onOpenCategory(c.categoryId)}
                      title={`Show every ${c.name} entry`}
                    >
                      <span className="cat-name">
                        <span className="cat-swatch" style={{ background: c.color }}>
                          <Icon name={c.icon} size={11} strokeWidth={2.4} />
                        </span>
                        {c.name}
                      </span>
                      <span className="cat-amount">{money(c.total)}</span>
                      <Meter value={c.total / categoryPeak} color={c.color} />
                    </button>
                  </motion.li>
                ))}
              </motion.ul>
            </div>
          ) : (
            <Empty
              icon="grid-2x2"
              title="No spending yet"
              body="Categorised expenses show up here as a breakdown."
            />
          )}
        </Card>

        {/* ---------------------------------------------------------- recent */}
        <Card className="recent-card" padded={false}>
          <div className="card-pad card-head-only">
            <CardHead
              title="Recent activity"
              hint="Across every account"
              action={
                <Button tone="quiet" size="sm" trailingIcon="arrow-right" onClick={onGoTransactions}>
                  View all
                </Button>
              }
            />
          </div>
          {recent.length ? (
            <motion.div
              className="tx-list"
              variants={listVariants}
              initial="initial"
              animate="animate"
            >
              {recent.map((tx) => (
                <TransactionRow
                  key={tx.id}
                  tx={tx}
                  showDate={dayLabel(tx.occurredAt)}
                  onClick={() => onOpenTransaction(tx)}
                />
              ))}
            </motion.div>
          ) : (
            <div className="card-pad">
              <Empty
                title="Nothing recorded yet"
                body="Add your first transaction and it will appear here."
                action={<Button tone="primary" icon="plus" onClick={onAddTransaction}>Add transaction</Button>}
              />
            </div>
          )}
        </Card>

        {/* ------------------------------------------------------- merchants */}
        <Card className="merchant-card">
          <CardHead title="Top merchants" hint={label} />
          {overview.topMerchants.length ? (
            <motion.ul
              key={`${month}-${span}`}
              className="merchant-list"
              variants={listVariants}
              initial="initial"
              animate="animate"
            >
              {overview.topMerchants.map((m, i) => (
                <motion.li key={m.merchant} variants={itemVariants}>
                  <span className="merchant-rank">{i + 1}</span>
                  <span className="merchant-name">
                    {m.merchant}
                    <small>{m.count} {m.count === 1 ? 'time' : 'times'}</small>
                  </span>
                  <span className="merchant-total">{money(m.total)}</span>
                </motion.li>
              ))}
            </motion.ul>
          ) : (
            <Empty icon="store" title="No merchants yet" body="Name the payee on an expense to see it ranked here." />
          )}
        </Card>
      </div>
    </div>
  );
}

/** Percent change vs the window before, tinted by whether it's welcome news. */
function Delta({
  value, good, span,
}: { value: number | null; good: 'up' | 'down'; span: number }) {
  const since = span > 1 ? 'previous period' : 'last month';
  if (value === null || !isFinite(value)) {
    return <span className="delta delta-flat">no prior {span > 1 ? 'period' : 'month'}</span>;
  }
  const up = value >= 0;
  const positive = good === 'up' ? up : !up;
  return (
    <span className={`delta ${positive ? 'is-good' : 'is-bad'}`}>
      <Icon name={up ? 'trending-up' : 'trending-down'} size={12} />
      {Math.abs(Math.round(value))}% vs {since}
    </span>
  );
}
