import { useEffect, useMemo, useState } from 'react';
import { motion } from 'motion/react';
import { Icon } from '../components/Icon';
import { MonthNav, periodLabel } from '../components/MonthNav';
import { BigMoney, CountMoney } from '../components/Money';
import { DailyBars, Donut, Sparkline, SplitBar } from '../components/charts';
import { TransactionRow } from '../components/TransactionRow';
import { MerchantLogo } from '../components/MerchantLogo';
import { Button, Card, CardHead, Empty, Meter } from '../components/ui';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import {
  accountWorth, compactMoney, dayLabel, debtProgress, initials, money, monthKey,
  monthLabel, percent, percentDelta,
} from '../lib/format';
import { itemVariants, listVariants, spring } from '../lib/motion';
import { cadenceLabel, dueLabel, isLive, monthlyTotal } from '../lib/plans';
import { isDeposit } from '../lib/types';
import type {
  Debt, FlowPoint, HoldingKind, InvestmentTab, Paise, Plan, Transaction,
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

/** One line on the investments card: a whole tab's worth, gathered. */
interface Sleeve {
  tab: InvestmentTab;
  name: string;
  icon: string;
  color: string;
  value: Paise;
  count: number;
}

/** Holdings that sit in no account of their own are gathered under one tile
 *  each. Only gold and funds can: a deposit's money always sits somewhere. */
const LOOSE: Partial<Record<HoldingKind, { name: string; icon: string; color: string }>> = {
  gold: { name: 'Gold', icon: 'coins', color: 'var(--amber)' },
  fund: { name: 'Mutual funds', icon: 'trending-up', color: 'var(--violet)' },
};

/** The three shapes an investment takes, in the order the tabs carry them. */
const SLEEVES: { tab: InvestmentTab; name: string; icon: string; color: string }[] = [
  { tab: 'fund', name: 'Mutual funds', icon: 'trending-up', color: 'var(--violet)' },
  { tab: 'gold', name: 'Gold', icon: 'coins', color: 'var(--amber)' },
  { tab: 'deposit', name: 'Deposits', icon: 'landmark', color: 'var(--blue)' },
];

/** How much of the portfolio's line the card carries. A year is the read
 *  most people have in mind when they glance at what they hold. */
const PORTFOLIO_DAYS = 366;

/** Which sleeve a holding belongs to — the two deposits share one. */
const sleeveOf = (kind: HoldingKind): InvestmentTab => (isDeposit(kind) ? 'deposit' : kind);

export function Overview({
  onOpenTransaction, onAddTransaction, onGoTransactions, onOpenAccount, onOpenCategory,
  onGoInvestments, onGoDebts, onGoAccounts, onGoPlanned,
}: {
  onOpenTransaction: (tx: Transaction) => void;
  onAddTransaction: () => void;
  onGoTransactions: () => void;
  /** Jump to Transactions filtered to one account. */
  onOpenAccount: (accountId: string) => void;
  /** Opens the ledger filtered to one category, over the window on screen. */
  onOpenCategory: (categoryId: string, span: number) => void;
  /** Jump to Investments, on the tab that holds what was clicked. */
  onGoInvestments: (tab: InvestmentTab) => void;
  onGoDebts: () => void;
  onGoAccounts: () => void;
  /** Off to the planned payments, from the card that previews them. */
  onGoPlanned: () => void;
}) {
  const {
    overview, accounts, holdings, debts, plans, month, setMonth, span, setSpan,
    listTransactions, revision,
  } = useStore();
  const [recent, setRecent] = useState<Transaction[]>([]);
  const [portfolioLine, setPortfolioLine] = useState<Paise[]>([]);

  useEffect(() => {
    listTransactions({ limit: 6 }).then(setRecent).catch(() => setRecent([]));
  }, [listTransactions, revision]);

  // The portfolio's own line, which answers to the book rather than to the
  // period nav: what you hold is not something that happened in August. It
  // comes back empty when there is nothing held, and the card draws nothing.
  useEffect(() => {
    let live = true;
    api
      .portfolioValueSeries(PORTFOLIO_DAYS)
      .then((points) => live && setPortfolioLine(points.map((p) => p.value)))
      .catch(() => live && setPortfolioLine([]));
    return () => {
      live = false;
    };
  }, [revision]);

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
      const kind = sleeveOf(held);
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

  // The portfolio as the Investments screen reads it: what is open, gathered
  // by the tab it lives under, with the cost and the gain that go with it.
  // Gold carries neither — it was weighed, not bought — so it moves the value
  // without moving the return.
  const portfolio = useMemo(() => {
    const open = holdings.filter((h) => !h.closed);
    const sleeves = SLEEVES.flatMap<Sleeve>((sleeve) => {
      const mine = open.filter((h) => sleeveOf(h.kind) === sleeve.tab);
      if (!mine.length) return [];
      return [{
        ...sleeve,
        value: mine.reduce((sum, h) => sum + h.marketValue, 0),
        count: mine.length,
      }];
    });
    const value = open.reduce((sum, h) => sum + h.marketValue, 0);
    const cost = open.reduce((sum, h) => sum + h.invested - h.realised, 0);
    const gain = open.reduce((sum, h) => sum + h.totalReturn, 0);
    return {
      sleeves,
      value,
      gain,
      gainPct: cost > 0 ? (gain / cost) * 100 : null,
      peak: sleeves.reduce((most, s) => Math.max(most, s.value), 1),
    };
  }, [holdings]);

  // What is still moving between you and other people, each side kept apart:
  // being owed ₹5,000 and owing ₹5,000 is not the same as owing nothing.
  const ledger = useMemo(() => {
    const open = debts.filter((d) => !d.settled);
    const lent = open.filter((d) => d.direction === 'lent');
    const borrowed = open.filter((d) => d.direction === 'borrowed');
    const sum = (list: Debt[]) => list.reduce((total, d) => total + d.outstanding, 0);
    return {
      any: open.length > 0,
      lent: sum(lent),
      borrowed: sum(borrowed),
      lentCount: lent.length,
      borrowedCount: borrowed.length,
      // The biggest first, since that is the one worth chasing or clearing.
      top: [...open].sort((a, b) => b.outstanding - a.outstanding).slice(0, 4),
    };
  }, [debts]);

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
  // Eight rather than six: beside the ring in the wide column there is room
  // for them, and the two columns end at more or less the same place.
  const topCategories = overview.topCategories.slice(0, 8);
  const categoryPeak = topCategories[0]?.total ?? 1;
  const isNow = month === monthKey() && span === 1;
  const label = periodLabel(month, span);
  // Negative balances and what you have borrowed, which the chip names
  // rather than quietly folding into the figure above it.
  const owed = overview.debt;

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

      {/* ================================================== wealth centre */}
      <div className="ov-stack">
        <motion.section
          className="hero"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={spring}
        >
          <div className="hero-top">
            <div>
              <span className="hero-label">Net worth</span>
              <BigMoney value={overview.netWorth} className="hero-amount" />
              <div className="hero-chips">
                <HeroChip
                  dot="in"
                  label="Cash"
                  value={overview.liquid}
                  hint="See your accounts"
                  onClick={onGoAccounts}
                />
                {overview.investments > 0 && (
                  <HeroChip
                    icon="coins"
                    label="Invested"
                    value={overview.investments}
                    hint="See your investments"
                    onClick={() => onGoInvestments(portfolio.sleeves[0]?.tab ?? 'fund')}
                  />
                )}
                {overview.lentOutstanding > 0 && (
                  <HeroChip
                    dot="in"
                    label="Lent out"
                    value={overview.lentOutstanding}
                    hint="See who owes you"
                    onClick={onGoDebts}
                  />
                )}
                {owed > 0 && (
                  <HeroChip
                    dot="out"
                    label="Owed"
                    value={owed}
                    hint="See what you owe"
                    onClick={onGoDebts}
                  />
                )}
              </div>
            </div>
          </div>

          {/* `morph`: moving to another window bends this line into the new
              one rather than drawing a fresh chart, so the change reads as
              the same balance seen over different months. */}
          <div className="hero-chart">
            <Sparkline
              values={overview.balanceSeries}
              height={104}
              stroke="var(--green-bright)"
              morph
            />
          </div>

          {/* The one figure here that belongs to the period rather than to
              the balance sheet, kept off the chip row above so the two are
              never read as the same kind of number. */}
          <div className="hero-split">
            <span className="hero-split-note">
              <Icon name="calendar-days" size={13} />
              {label}
            </span>
            <span className={`hero-chip ${net >= 0 ? 'is-up' : 'is-down'}`}>
              <Icon name={net >= 0 ? 'trending-up' : 'trending-down'} size={13} />
              {money(Math.abs(net))} {net >= 0 ? 'saved' : 'over'}
            </span>
          </div>
        </motion.section>

        {/* Where the money actually sits, given a card of its own: the hero
            is one figure and the shape of it, and a dozen tiles crowding in
            underneath made it neither. */}
        <Card className="wallet-card">
          <CardHead
            title="Where it sits"
            hint="Every account, and what is held outside one"
            action={
              <Button tone="quiet" size="sm" trailingIcon="arrow-right" onClick={onGoAccounts}>
                Accounts
              </Button>
            }
          />
          <motion.div
            className="wallet-grid"
            variants={listVariants}
            initial="initial"
            animate="animate"
          >
            {tiles.map((tile) => (
              <motion.button
                key={tile.key}
                className="wallet-tile"
                onClick={tile.open}
                title={tile.hint}
                variants={itemVariants}
              >
                <span className="wallet-glyph" style={{ background: tile.color }}>
                  <Icon name={tile.icon} size={15} />
                </span>
                <span className="wallet-text">
                  <strong>{tile.name}</strong>
                  <span className={tile.value < 0 ? 'is-owed' : undefined}>
                    {money(tile.value)}
                  </span>
                </span>
              </motion.button>
            ))}
          </motion.div>
        </Card>

        {/* The two things a balance sheet is made of beyond the cash: what is
            invested, and what is still owed either way. A book with neither
            gets neither card rather than two empty ones. */}
        {(portfolio.sleeves.length > 0 || ledger.any) && (
          <div className="wealth-grid">
            {portfolio.sleeves.length > 0 && (
              <Card className="wealth-card">
                <CardHead
                  title="Investments"
                  hint="Valued at what today's prices say"
                  action={
                    <Button
                      tone="quiet"
                      size="sm"
                      trailingIcon="arrow-right"
                      onClick={() => onGoInvestments(portfolio.sleeves[0].tab)}
                    >
                      Open
                    </Button>
                  }
                />
                <div className="wealth-figure">
                  <CountMoney value={portfolio.value} className="figure-value" />
                  {portfolio.gainPct === null ? (
                    <span className="delta delta-flat">nothing bought to compare against</span>
                  ) : (
                    <span className={`delta ${portfolio.gain >= 0 ? 'is-good' : 'is-bad'}`}>
                      <Icon
                        name={portfolio.gain >= 0 ? 'trending-up' : 'trending-down'}
                        size={12}
                      />
                      {money(portfolio.gain, { sign: true })} ·{' '}
                      {percent(portfolio.gainPct, { sign: true })} on cost
                    </span>
                  )}
                </div>
                {portfolioLine.length > 1 && (
                  <div className="wealth-chart">
                    <span>Last 12 months</span>
                    <Sparkline
                      values={portfolioLine}
                      height={72}
                      stroke={portfolio.gain >= 0 ? 'var(--green)' : 'var(--red)'}
                      morph
                    />
                  </div>
                )}
                <ul className="sleeve-list">
                  {portfolio.sleeves.map((sleeve) => (
                    <li key={sleeve.tab}>
                      <button
                        type="button"
                        className="cat-row"
                        onClick={() => onGoInvestments(sleeve.tab)}
                        title={`See ${sleeve.name.toLowerCase()}`}
                      >
                        <span className="cat-name">
                          <span className="cat-swatch" style={{ background: sleeve.color }}>
                            <Icon name={sleeve.icon} size={11} strokeWidth={2.4} />
                          </span>
                          {sleeve.name}
                          <small className="cat-count">{sleeve.count}</small>
                        </span>
                        <span className="cat-amount">{money(sleeve.value)}</span>
                        <Meter value={sleeve.value / portfolio.peak} color={sleeve.color} />
                      </button>
                    </li>
                  ))}
                </ul>
              </Card>
            )}

            {ledger.any && (
              <Card className="wealth-card">
                <CardHead
                  title="Between you and others"
                  hint="What is still open, either way"
                  action={
                    <Button tone="quiet" size="sm" trailingIcon="arrow-right" onClick={onGoDebts}>
                      Open
                    </Button>
                  }
                />
                <div className="flow-figures">
                  <div>
                    <span className="figure-label">
                      <i className="dot dot-in" /> Owed to you
                    </span>
                    <CountMoney value={ledger.lent} className="figure-value" />
                    <span className="delta delta-flat">
                      {ledger.lentCount} {ledger.lentCount === 1 ? 'person' : 'people'}
                    </span>
                  </div>
                  <div>
                    <span className="figure-label">
                      <i className="dot dot-out" /> You owe
                    </span>
                    <CountMoney value={ledger.borrowed} className="figure-value" />
                    <span className="delta delta-flat">
                      {ledger.borrowedCount} {ledger.borrowedCount === 1 ? 'person' : 'people'}
                    </span>
                  </div>
                </div>
                <ul className="owing-list">
                  {ledger.top.map((debt) => {
                    const lent = debt.direction === 'lent';
                    return (
                      <li key={debt.id}>
                        <button type="button" className="owing-row" onClick={onGoDebts}>
                          <span className="owing-face">{initials(debt.counterparty)}</span>
                          <span className="owing-name">
                            {debt.counterparty}
                            <small>{lent ? 'owes you' : 'you owe'}</small>
                          </span>
                          <span className="owing-amount">{money(debt.outstanding)}</span>
                          <Meter
                            value={debtProgress(debt).repaid / 100}
                            color={lent ? 'var(--green)' : 'var(--amber)'}
                          />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </Card>
            )}
          </div>
        )}
      </div>

      {/* ================================================= expense centre */}
      <BandHead
        title="Spending"
        hint={`What came in and what went out over ${label}.`}
      />

      <div className="spend-grid">
        <div className="ov-col spend-main">
          {/* --------------------------------------------------- flow card */}
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

          {/* ----------------------------------------------------- category */}
          <Card className="donut-card">
            <CardHead
              title="Where it went"
              hint={`${overview.topCategories.length} categories · ${label}`}
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
                  onSelect={(id) => onOpenCategory(id, span)}
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
                        onClick={() => onOpenCategory(c.categoryId, span)}
                        title={`Show ${c.name} over ${label}`}
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
        </div>

        <div className="ov-col">
          {/* ------------------------------------------------------- recent */}
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

          {/* ---------------------------------------------------- merchants */}
          <PlannedCard plans={plans} onOpen={onGoPlanned} />

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
    </div>
  );
}

/** The rule that names each half of the page — what you are worth, and what
 *  you spent. Two very different questions, and the answers to them should
 *  not read as one long list of cards. */
function BandHead({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="ov-band">
      <h2>{title}</h2>
      <p>{hint}</p>
    </div>
  );
}

/** A figure off the balance sheet, and the screen it belongs to. */
function HeroChip({
  label, value, hint, onClick, dot, icon,
}: {
  label: string;
  value: Paise;
  hint: string;
  onClick: () => void;
  dot?: 'in' | 'out';
  icon?: string;
}) {
  return (
    <button type="button" className="hero-chip is-link" onClick={onClick} title={hint}>
      {dot ? <i className={`dot dot-${dot}`} /> : icon ? <Icon name={icon} size={13} /> : null}
      {label} {money(value)}
    </button>
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


/**
 * What the month has already promised away.
 *
 * A dashboard that only shows what you have is telling you half of it: the
 * rent is as real on the 1st as it was on the 31st. This is the other half —
 * the next few things that will leave without being asked, and what the
 * standing commitments come to across a month.
 */
function PlannedCard({ plans, onOpen }: { plans: Plan[]; onOpen: () => void }) {
  const live = plans.filter(isLive);
  const next = [...live]
    .filter((p) => p.nextDue)
    .sort((a, b) => (a.nextDue ?? '').localeCompare(b.nextDue ?? ''))
    .slice(0, 5);
  const committed = monthlyTotal(plans, 'expense');
  const week = live.filter((p) => p.daysUntil !== null && p.daysUntil <= 7);
  const weekTotal = week.reduce(
    (sum, p) => sum + (p.kind === 'income' ? 0 : p.variable ? p.averageAmount : p.amount),
    0,
  );
  const late = live.filter((p) => (p.daysUntil ?? 0) < 0).length;

  return (
    <Card className="planned-card">
      <CardHead
        title="Coming up"
        hint={committed ? `${money(committed)} a month committed` : 'Money that repeats'}
        action={
          <Button tone="quiet" size="sm" trailingIcon="arrow-right" onClick={onOpen}>
            Plans
          </Button>
        }
      />
      {next.length === 0 ? (
        <Empty
          icon="repeat"
          title="Nothing on the horizon"
          body="Track a rent or a subscription and the next few land here."
          action={
            <Button tone="primary" icon="sparkles" onClick={onOpen}>
              Find what repeats
            </Button>
          }
        />
      ) : (
        <>
          <motion.ul
            className="planned-preview"
            variants={listVariants}
            initial="initial"
            animate="animate"
          >
            {next.map((plan) => (
              <motion.li key={plan.id} variants={itemVariants}>
                <button type="button" className="planned-preview-row" onClick={onOpen}>
                  <MerchantLogo
                    merchant={plan.merchant || plan.name}
                    icon={plan.categoryIcon ?? 'repeat'}
                    tint={plan.categoryColor ?? 'var(--ink-3)'}
                    size={30}
                    glyphSize={14}
                  />
                  <span className="planned-preview-main">
                    <strong>{plan.name}</strong>
                    <span>{cadenceLabel(plan.cadence, plan.every)}</span>
                  </span>
                  <span className="planned-preview-when">
                    <em className={(plan.daysUntil ?? 0) < 0 ? 'is-down' : ''}>
                      {dueLabel(plan)}
                    </em>
                    <strong className={plan.kind === 'income' ? 'is-up' : ''}>
                      {money(plan.variable && plan.averageAmount ? plan.averageAmount : plan.amount)}
                    </strong>
                  </span>
                </button>
              </motion.li>
            ))}
          </motion.ul>
          <p className="planned-foot">
            {weekTotal > 0
              ? `${money(weekTotal)} falls due in the next seven days`
              : 'Nothing falls due in the next seven days'}
            {late > 0 ? ` · ${late} already late` : ''}
          </p>
        </>
      )}
    </Card>
  );
}
