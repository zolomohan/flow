import { useEffect, useMemo, useState } from 'react';
import { motion } from 'motion/react';
import { Icon } from '../components/Icon';
import { MonthNav, periodLabel } from '../components/MonthNav';
import { Donut, Sparkline, SpendBars } from '../components/charts';
import { Button, Card, Empty } from '../components/ui';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import {
  compactMoney, money, percent, percentDelta, shortDayLabel, shortMonthLabel,
} from '../lib/format';
import { itemVariants, listVariants, spring } from '../lib/motion';
import {
  CardPage, Figure, SectionHead, cycleWords, daysUntil, dueShort, dueWords, usedOf,
} from './CardPage';
import type { Account, CardStat, CardsOverview, Transaction } from '../lib/types';

/** Which card leads the wallet: whatever is due soonest, then whatever owes
 *  the most. The order the accounts screen keeps them in says nothing about
 *  which one needs you first. */
function byUrgency(cards: CardStat[]) {
  return [...cards].sort((a, b) => {
    const aDue = a.billed > 0 && a.dueOn ? daysUntil(a.dueOn) : 9_999;
    const bDue = b.billed > 0 && b.dueOn ? daysUntil(b.dueOn) : 9_999;
    return aDue !== bDue ? aDue - bDue : b.outstanding - a.outstanding;
  });
}

export function Cards({
  onOpenAccount, onEditAccount, onAddAccount, onOpenCategory, onOpenTransaction,
}: {
  /** Off to the ledger, filtered to one card. */
  onOpenAccount: (accountId: string) => void;
  /** Opens the account itself — where the cycle and the limit are set. */
  onEditAccount: (account: Account) => void;
  onAddAccount: () => void;
  /** The ledger filtered to one category, over the window on screen. */
  onOpenCategory: (categoryId: string, span: number) => void;
  onOpenTransaction: (tx: Transaction) => void;
}) {
  const { accounts, month, setMonth, span, setSpan, revision } = useStore();
  const [data, setData] = useState<CardsOverview | null>(null);
  const [loading, setLoading] = useState(true);
  // The card being read at length, if any. The tab itself is the wallet.
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setLoading(true);
    api
      .cards(month, span)
      .then((next) => live && setData(next))
      .catch(() => live && setData(null))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [month, span, revision]);

  const label = periodLabel(month, span);
  const held = useMemo(
    () => accounts.filter((a) => a.kind === 'credit' && !a.archived),
    [accounts],
  );

  const cards = useMemo(() => byUrgency(data?.cards ?? []), [data]);
  const viewing = cards.find((c) => c.id === openId) ?? null;

  // The next statement to be cut, across every card. The heading says this
  // rather than what is owed: what is owed is the figure directly beneath
  // it, and a heading that repeats the panel under it says nothing at all.
  const nextClose = useMemo(() => {
    const closes = cards
      .map((c) => c.cycles[c.cycles.length - 1]?.closedOn)
      .filter((d): d is string => !!d)
      .sort();
    return closes[0] ?? null;
  }, [cards]);

  const nextDue = useMemo(() => {
    const bills = cards
      .filter((c) => c.billed > 0 && c.dueOn)
      .map((c) => ({ card: c, days: daysUntil(c.dueOn!) }));
    return bills[0] ?? null;
  }, [cards]);

  const editing = (id: string) => {
    const account = accounts.find((a) => a.id === id);
    if (account) onEditAccount(account);
  };

  if (viewing) {
    return (
      <CardPage
        card={viewing}
        span={span}
        onBack={() => setOpenId(null)}
        onEdit={() => editing(viewing.id)}
        onOpenLedger={() => onOpenAccount(viewing.id)}
        onOpenCategory={onOpenCategory}
        onOpenTransaction={onOpenTransaction}
      />
    );
  }

  if (!loading && held.length === 0) {
    return (
      <div className="screen cards-screen">
        <header className="screen-head">
          <div>
            <h1>Cards</h1>
            <p>What is owed on your credit cards, and when it falls due.</p>
          </div>
        </header>
        <Empty
          screen
          title="No credit cards yet"
          body="What is billed, what is due, and how much of your limit is left."
          action={
            <Button tone="primary" icon="plus" onClick={onAddAccount}>
              New account
            </Button>
          }
        />
      </div>
    );
  }

  const used = data && data.creditLimit > 0
    ? Math.min(1, data.outstanding / data.creditLimit)
    : 0;
  const delta = data ? percentDelta(data.spend, data.prevSpend) : null;

  return (
    <div className="screen cards-screen">
      <header className="screen-head">
        <div>
          <h1>Cards</h1>
          <p>
            {!data
              ? 'What is owed on your credit cards, and when it falls due.'
              : !nextClose
                ? `${cards.length} ${cards.length === 1 ? 'card' : 'cards'} · no billing cycle set yet`
                : daysUntil(nextClose) <= 0
                  ? `${cards.length} ${cards.length === 1 ? 'card' : 'cards'} · a statement closes today`
                  : `${cards.length} ${cards.length === 1 ? 'card' : 'cards'} · next statement closes ${shortDayLabel(nextClose)}`}
          </p>
        </div>
        <MonthNav month={month} onChange={setMonth} span={span} onSpanChange={setSpan} />
      </header>

      {data && (
        <>
          {/* Every card at once. One panel: the figure, who owes what, the
              four totals, and a year of it — so the tab answers before you
              have clicked on anything. */}
          <Card className="cards-summary" padded={false}>
            <div className="cards-summary-lead">
              <div className="cards-summary-main">
                <span className="figure-label">Outstanding · all cards</span>
                <strong className="cards-total">{money(data.outstanding)}</strong>
                <p className="cards-summary-sub">
                  {data.creditLimit > 0 ? (
                    <>
                      {money(data.available)} left of {money(data.creditLimit)} ·{' '}
                      {percent(used * 100)} used
                    </>
                  ) : (
                    'no credit limits set'
                  )}
                </p>
                {/* Who owes what, as one rule. It reads at a glance even
                    where a donut would be two arcs and a legend. */}
                <div className="cards-summary-bar">
                  {cards
                    .filter((card) => card.outstanding > 0)
                    .map((card) => (
                      <i
                        key={card.id}
                        title={`${card.name} · ${money(card.outstanding)}`}
                        style={{ background: card.color, flexGrow: card.outstanding }}
                      />
                    ))}
                </div>
              </div>

              {cards.length > 1 && data.outstanding > 0 && (
                <Donut
                  size={158}
                  thickness={19}
                  slices={cards
                    .filter((c) => c.outstanding > 0)
                    .map((c) => ({
                      id: c.id,
                      label: c.name,
                      value: c.outstanding,
                      color: c.color,
                    }))}
                  centerLabel="Owed"
                  centerValue={compactMoney(data.outstanding)}
                  onSelect={(id) => setOpenId(id)}
                />
              )}
            </div>

            <div className="figure-row">
              <Figure
                label="Billed"
                value={money(data.billed)}
                tone={nextDue && nextDue.days < 0 ? 'bad' : data.billed > 0 ? 'warn' : 'good'}
                hint={
                  nextDue
                    ? `${nextDue.card.name} ${dueWords(nextDue.days)}`
                    : 'nothing waiting to be paid'
                }
              />
              <Figure
                label="Unbilled"
                value={money(data.unbilled)}
                hint="spent since the last statements"
              />
              <Figure
                label={`Spent · ${label}`}
                value={money(data.spend)}
                tone={delta !== null && delta > 0 ? 'bad' : 'good'}
                hint={
                  delta === null
                    ? 'nothing to compare it against'
                    : `${percent(delta, { sign: true })} on ${compactMoney(data.prevSpend)} before`
                }
              />
              <Figure
                label={`Paid · ${label}`}
                value={money(data.paid)}
                tone={data.paid > 0 ? 'good' : 'flat'}
                hint={
                  data.paid >= data.spend
                    ? 'more paid off than put on'
                    : `${compactMoney(data.spend - data.paid)} more went on than came off`
                }
              />
            </div>

            <section className="cards-summary-chart">
              <SectionHead
                title="What went on the cards"
                hint="every card, month by month"
              />
              <SpendBars
                points={data.monthly.map((m) => ({ bucket: m.bucket, value: m.expense }))}
                labelOf={shortMonthLabel}
                height={186}
                color="var(--ink-3)"
                openLast
              />
            </section>
          </Card>

          {/* The wallet. These are cards, so they are drawn as cards — each
              saying its own short version, and opening at length. */}
          <motion.div
            className="wallet-strip"
            variants={listVariants}
            initial="initial"
            animate="animate"
          >
            {cards.map((card) => (
              <CardFace key={card.id} card={card} onOpen={() => setOpenId(card.id)} />
            ))}
          </motion.div>
        </>
      )}
    </div>
  );
}

/** One card in the wallet: the plastic itself, at a glance, and the way in. */
function CardFace({ card, onOpen }: { card: CardStat; onOpen: () => void }) {
  const used = usedOf(card);
  const days = card.billed > 0 && card.dueOn ? daysUntil(card.dueOn) : null;
  // Its own cycles as a line. Two closed cycles is not a trend, so the line
  // only appears once there is something in it to see.
  const line = card.cycles.filter((c) => !c.open).map((c) => Math.max(0, c.spend));

  return (
    <motion.button
      type="button"
      variants={itemVariants}
      whileHover={{ y: -3 }}
      whileTap={{ scale: 0.99 }}
      transition={spring}
      className="card-face"
      style={{ ['--tint' as any]: card.color }}
      onClick={onOpen}
    >
      <span className="card-face-top">
        <Icon name={card.icon} size={15} />
        <b>{card.name}</b>
        {days !== null && (
          <em className={`card-face-due ${days < 0 ? 'is-late' : days <= 5 ? 'is-soon' : ''}`}>
            {dueShort(days)}
          </em>
        )}
      </span>

      <span className="card-face-owed">{money(card.outstanding)}</span>
      <span className="card-face-sub">
        {card.statementDay > 0
          ? `${compactMoney(card.billed)} billed · ${compactMoney(card.unbilled)} unbilled`
          : (cycleWords(card) ?? 'no billing cycle set')}
      </span>

      {line.length > 2 && (
        <span className="card-face-line">
          <Sparkline values={line} height={40} stroke="rgba(255, 255, 255, 0.92)" />
        </span>
      )}

      {card.creditLimit > 0 ? (
        <>
          <span className={`card-face-bar ${used >= 0.85 ? 'is-high' : ''}`}>
            <i style={{ width: `${Math.max(2, used * 100)}%` }} />
          </span>
          <span className="card-face-foot">
            {percent(used * 100)} of {compactMoney(card.creditLimit)} ·{' '}
            {compactMoney(card.available)} left
          </span>
        </>
      ) : (
        <span className="card-face-foot is-quiet">no limit set</span>
      )}

      <span className="card-face-go" aria-hidden>
        <Icon name="arrow-right" size={14} />
      </span>
    </motion.button>
  );
}
