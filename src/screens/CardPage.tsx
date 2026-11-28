import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import { motion } from 'motion/react';
import { ordinalDay } from '../components/DateField';
import { Icon } from '../components/Icon';
import { BigMoney } from '../components/Money';
import { Donut, SpendBars } from '../components/charts';
import { TransactionRow } from '../components/TransactionRow';
import {
  Button, Card, Empty, IconButton, Meter, Segmented, type SegmentOption,
} from '../components/ui';
import { periodLabel } from '../components/MonthNav';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import {
  cashbackRate, compactMoney, money, monthKey, monthWindowBounds, percent, shiftMonth,
  shortDayLabel,
  monthLabel,
} from '../lib/format';
import { itemVariants, listVariants } from '../lib/motion';
import type { CardStat, Paise, Transaction, TransactionSummary } from '../lib/types';

/* The words a card is read in. They are shared with the tab itself, which
   says the same things in less room. */

/** Today as a plain ISO day, by the clock on the wall rather than UTC. */
export function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${
    String(d.getDate()).padStart(2, '0')}`;
}

/** Whole days from today to a plain ISO day, negative once it is past. */
export function daysUntil(iso: string) {
  const target = new Date(`${iso}T00:00:00`);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((target.getTime() - today.getTime()) / 86_400_000);
}

/**
 * How near a bill is, in words. Days rather than a date, because what you
 * want off a card is whether it needs paying this week — the date itself is
 * beside it for when it doesn't.
 */
export function dueWords(days: number) {
  if (days === 0) return 'due today';
  if (days === 1) return 'due tomorrow';
  if (days === -1) return 'a day late';
  if (days < 0) return `${Math.abs(days)} days late`;
  return `due in ${days} days`;
}

/** The same thing at chip length, where there is room for four characters. */
export function dueShort(days: number) {
  if (days === 0) return 'today';
  if (days < 0) return `${Math.abs(days)}d late`;
  return `${days}d`;
}

/** A bill is trouble once it is late, and worth a glance when it is nearly
 *  due. Anything further out is simply a number. */
export function dueTone(days: number, billed: number): 'good' | 'bad' | 'warn' | 'flat' {
  if (billed <= 0) return 'good';
  if (days < 0) return 'bad';
  return days <= 5 ? 'warn' : 'flat';
}

/** How much of the limit is gone, 0–1. Zero on a card with no limit set:
 *  nothing is known about how much room is left. */
export const usedOf = (card: { outstanding: number; creditLimit: number }) =>
  card.creditLimit > 0 ? Math.min(1, card.outstanding / card.creditLimit) : 0;

/** How a card describes its own cycle, when it keeps one. */
export function cycleWords(card: CardStat) {
  if (card.statementDay <= 0) return null;
  if (card.dueDay <= 0) return `closes the ${ordinalDay(card.statementDay)}`;
  // A due day at or before the closing day is the month after: a card that
  // closes on the 20th and is due on the 7th is not due a fortnight before
  // the bill exists.
  const next = card.dueDay <= card.statementDay ? ' of the next month' : '';
  return `closes the ${ordinalDay(card.statementDay)}, due the ${
    ordinalDay(card.dueDay)}${next}`;
}

/** One figure on a rule: what it is, what it comes to, and the one line
 *  worth saying about it. Boxes are what the tab is trying not to be. */
export function Figure({
  label, value, hint, tone = 'flat', action,
}: {
  label: string;
  value: string;
  hint: string;
  tone?: 'good' | 'bad' | 'warn' | 'flat';
  /** Something to do about it, when the figure is really a question — a card
   *  with no cycle set, say. */
  action?: ReactNode;
}) {
  return (
    <div className={`figure figure-${tone}`}>
      <span className="figure-label">{label}</span>
      <strong className="figure-value">{value}</strong>
      <span className="figure-hint">
        {hint}
        {action}
      </span>
    </div>
  );
}

/** The heading over a block inside a panel, since a panel inside a panel is
 *  a box too many. */
export function SectionHead({
  title, hint, action,
}: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="section-head">
      <h3>{title}</h3>
      {action ?? (hint && <span>{hint}</span>)}
    </div>
  );
}

/** The plastic itself, for the page that belongs to it: the identity of the
 *  card and nothing that is already a figure elsewhere on the screen. */
export function CardPlastic({ card }: { card: CardStat }) {
  return (
    <div className="card-plastic" style={{ ['--tint' as any]: card.color }}>
      <span className="card-plastic-chip">
        <Icon name={card.icon} size={17} />
      </span>
      <span className="card-plastic-name">{card.name}</span>
      <span className="card-plastic-foot">
        <b>{card.institution ?? 'Credit card'}</b>
        <em>{cycleWords(card) ?? 'no billing cycle set'}</em>
      </span>
    </div>
  );
}

/**
 * How much of the limit is gone, as one bar rather than a bar with a caption
 * under it. Both figures live inside the track — the share on the left, the
 * limit it is a share of on the right — because a percentage with nothing to
 * be a percentage of is half a fact.
 */
function LimitBar({
  value, limit, caption,
}: {
  /** 0–1. */
  value: number;
  limit: Paise;
  caption: string;
}) {
  const tone = value >= 0.85 ? 'is-high' : value >= 0.65 ? 'is-mid' : 'is-low';
  return (
    <div className={`limit-bar ${tone}`}>
      <span className="limit-bar-fill" style={{ width: `${Math.max(2, value * 100)}%` }} />
      <span className="limit-bar-read">
        <b>{percent(value * 100)}</b>
        {caption}
      </span>
      <span className="limit-bar-cap">{money(limit)}</span>
    </div>
  );
}

/**
 * Where the cycle stands: the day it opened, the day it closes, today's mark
 * between them, and the day the last bill has to be paid. A card's month is
 * the one thing about it nobody can hold in their head.
 */
function CycleTrack({ card }: { card: CardStat }) {
  const open = card.cycles[card.cycles.length - 1];
  // Nothing to draw without a cycle. What to do about that is said at the
  // top of the page, where it can be read before anything else.
  if (!open) return null;

  const day = (iso: string) => new Date(`${iso}T00:00:00`).getTime();
  const from = day(open.from);
  const to = day(open.closedOn);
  const at = Math.min(1, Math.max(0, (Date.now() - from) / Math.max(1, to - from)));
  const dueOn = card.dueOn ? day(card.dueOn) : null;
  // The due date usually falls inside the cycle now running. When it doesn't
  // — a long gap between closing and paying — it is left off the track and
  // said in words above instead.
  const dueAt = dueOn !== null && dueOn >= from && dueOn <= to
    ? (dueOn - from) / Math.max(1, to - from)
    : null;
  const days = card.dueOn ? daysUntil(card.dueOn) : null;
  const tone = days === null ? 'flat' : dueTone(days, card.billed);

  return (
    <div className="cycle-track">
      <p className={`cycle-track-bill is-${tone}`}>
        {card.billed > 0 ? (
          <>
            <Icon name="receipt" size={13} />
            <strong>{money(card.billed)}</strong>
            to pay
            {days !== null && (
              <em>
                {dueWords(days)}
                {card.dueOn && ` · ${shortDayLabel(card.dueOn)}`}
              </em>
            )}
          </>
        ) : (
          <>
            <Icon name="check-circle-2" size={13} />
            {card.statementTotal > 0
              ? `The ${money(card.statementTotal)} bill is paid off`
              : 'Nothing was billed last cycle'}
          </>
        )}
      </p>

      <div className="cycle-track-line">
        <span className="cycle-track-fill" style={{ width: `${at * 100}%` }} />
        <span className="cycle-track-now" style={{ left: `${at * 100}%` }} />
        {dueAt !== null && (
          <span
            className={`cycle-track-due ${days !== null && days < 0 ? 'is-late' : ''}`}
            style={{ left: `${dueAt * 100}%` }}
            title={`Payment due ${shortDayLabel(card.dueOn!)}`}
          />
        )}
      </div>

      <div className="cycle-track-ends">
        <span>
          {shortDayLabel(open.from)}
          <small>cycle opened</small>
        </span>
        <span className="is-right">
          {shortDayLabel(open.closedOn)}
          <small>
            {daysUntil(open.closedOn) <= 0
              ? 'closes today'
              : `closes in ${daysUntil(open.closedOn)} days`}
          </small>
        </span>
      </div>
    </div>
  );
}

/** The windows the card's own ledger can be read over. */
type CardRange = 'cycle' | 'month' | 'quarter' | 'year' | 'all';

/** How many months each window covers. The cycle is not a number of months —
 *  it is whatever the bank says it is — so it is bounded from the card. */
const CARD_RANGE_SPAN: Record<Exclude<CardRange, 'cycle'>, number> = {
  month: 1, quarter: 3, year: 12, all: 0,
};

/** Rows fetched at a time. A card with six years on it is still reachable —
 *  the page is what keeps the list quick, not a cap on what you can see. */
const CARD_PAGE = 100;

/** Past this many rows the stagger stops being a flourish and becomes a wait. */
const CARD_STAGGER_UP_TO = 60;

/** Which window a run of `span` months is, when one of them is that long.
 *  The page opens on whatever the tab was set to, and falls back to a month. */
function rangeOfSpan(span: number): CardRange {
  const named = (Object.keys(CARD_RANGE_SPAN) as Exclude<CardRange, 'cycle'>[])
    .find((r) => CARD_RANGE_SPAN[r] === span && span > 0);
  return named ?? 'month';
}

/** The last day anything can have happened on, for a window with no end. */
const FOREVER = '9999-12-31';

/**
 * One card, at length: the bill and the cycle it came from, where the money
 * went, and the charges themselves. Reached from the wallet on the tab,
 * which says the short version of all of it.
 */
export function CardPage({
  card: fromTab, span, onBack, onEdit, onOpenLedger, onOpenCategory, onOpenTransaction,
}: {
  /** The card as the wallet has it, over the tab's own window. It stands in
   *  until the page has read the card over the window *it* is set to. */
  card: CardStat;
  /** The window the tab is on, in months, which the page opens on. */
  span: number;
  onBack: () => void;
  onEdit: () => void;
  onOpenLedger: () => void;
  onOpenCategory: (categoryId: string, span: number) => void;
  onOpenTransaction: (tx: Transaction) => void;
}) {
  const { listTransactions, transactionSummary, month, revision } = useStore();
  const [rows, setRows] = useState<Transaction[]>([]);
  const [summary, setSummary] = useState<TransactionSummary | null>(null);
  const [loading, setLoading] = useState(true);
  // Which window the card's own ledger is read over, and how much of it has
  // been fetched so far.
  // A card's own month is the cycle, so that is what it opens on. One that
  // keeps no cycle has nothing to open on but the calendar, and takes the
  // window the tab was already showing.
  const [range, setRange] = useState<CardRange>(
    () => (fromTab.cycles.length ? 'cycle' : rangeOfSpan(span)),
  );
  const [shown, setShown] = useState(CARD_PAGE);
  // The last month of the window, which the chevrons walk backwards. Its own,
  // not the tab's: reading January on a card shouldn't move the whole screen.
  const [anchor, setAnchor] = useState(month);
  // Which statement is being read, when the window is a cycle. The open one
  // to begin with, since that is the one being run up right now.
  const [cycleAt, setCycleAt] = useState(() => Math.max(0, fromTab.cycles.length - 1));
  // The card read over the page's own window. Everything on the page comes off
  // this — the bill, the figures, what it bought, where it went — so one
  // choice of window moves the whole view rather than the list at the bottom.
  const [own, setOwn] = useState<CardStat | null>(null);

  const card = own ?? fromTab;
  const now = monthKey();
  const cycle = card.cycles[cycleAt];
  const hasCycles = card.cycles.length > 0;

  // Moving the strip on the tab moves the card with it — the page was reopened
  // on a period, and the ledger follows it rather than arguing with it.
  useEffect(() => {
    setAnchor(month);
  }, [month]);

  // A different card is a different run of statements, and its own figures —
  // and its own answer to whether it keeps a cycle at all.
  useEffect(() => {
    setAnchor(month);
    setCycleAt(Math.max(0, fromTab.cycles.length - 1));
    setRange(fromTab.cycles.length ? 'cycle' : rangeOfSpan(span));
    setOwn(null);
  }, [fromTab.id]);

  // The cycle is only offered by a card that keeps one — a window nothing on
  // the page can explain is worse than one fewer button.
  const rangeOptions = useMemo<SegmentOption<CardRange>[]>(() => {
    const named: SegmentOption<CardRange>[] = [
      { value: 'month', label: 'Month' },
      { value: 'quarter', label: '3 months' },
      { value: 'year', label: 'Year' },
      { value: 'all', label: 'All time' },
    ];
    return hasCycles ? [{ value: 'cycle', label: 'Cycle' }, ...named] : named;
  }, [hasCycles]);

  // What the chosen window comes to in days. A cycle takes its ends from the
  // bank's own dates; the rest are months back from wherever the chevrons
  // have walked to.
  const bounds = useMemo(() => {
    if (range === 'cycle') {
      return cycle ? { from: cycle.from, to: cycle.closedOn } : { from: null, to: null };
    }
    return monthWindowBounds(CARD_RANGE_SPAN[range], anchor);
  }, [range, anchor, cycle?.from, cycle?.closedOn]);

  /** Steps the window back or on by one of itself. All time has nowhere to go. */
  const step = (delta: number) => {
    if (range === 'cycle') {
      setCycleAt((at) => Math.min(card.cycles.length - 1, Math.max(0, at + delta)));
      return;
    }
    if (range === 'all') return;
    setAnchor((at) => {
      const next = shiftMonth(at, delta * CARD_RANGE_SPAN[range]);
      // Nothing has happened after this month. A step that would land past it
      // lands on it instead, so a year window can still be walked up to today.
      return next > now ? (at < now ? now : at) : next;
    });
  };

  // Whether there is anywhere to step. Backwards there always is — the book
  // goes back as far as it goes; forwards stops at today, and at the statement
  // still being run up.
  const canForward = range === 'cycle'
    ? cycleAt < card.cycles.length - 1
    : range !== 'all' && anchor < now;
  const canBack = range === 'cycle' ? cycleAt > 0 : range !== 'all';

  // A different window is a different list; it starts at the top again.
  useEffect(() => {
    setShown(CARD_PAGE);
  }, [bounds.from, bounds.to, fromTab.id]);

  // The card itself, read over the chosen window. Months go as months, so a
  // month is still compared against the month before it; a cycle and all of
  // time go as days, which no run of months can say.
  useEffect(() => {
    let live = true;
    const [from, to] = range === 'cycle'
      ? [bounds.from, bounds.to]
      : range === 'all'
        ? [null, FOREVER]
        : [null, null];
    api
      .cards(anchor, Math.max(1, CARD_RANGE_SPAN[range === 'cycle' ? 'month' : range]), from, to)
      .then((next) => {
        if (!live) return;
        setOwn(next.cards.find((c) => c.id === fromTab.id) ?? null);
      })
      .catch(() => live && setOwn(null));
    return () => {
      live = false;
    };
  }, [fromTab.id, range, anchor, bounds.from, bounds.to, revision]);

  // Everything the card has been doing over that window, newest first —
  // payments into it included, since a bill being paid is as much part of the
  // card's story as the charges are. The count comes off the summary rather
  // than the page, so it describes the whole window and not the slice loaded.
  useEffect(() => {
    let live = true;
    const query = { accountIds: [card.id], from: bounds.from, to: bounds.to };
    setLoading(true);
    Promise.all([listTransactions({ ...query, limit: shown }), transactionSummary(query)])
      .then(([nextRows, nextSummary]) => {
        if (!live) return;
        setRows(nextRows);
        setSummary(nextSummary);
      })
      .catch(() => {
        if (!live) return;
        setRows([]);
        setSummary(null);
      })
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [
    card.id, bounds.from, bounds.to, shown, listTransactions, transactionSummary, revision,
  ]);

  const total = summary?.count ?? rows.length;
  const remaining = Math.max(0, total - rows.length);
  // What the chosen window is called, for the line beside the heading and for
  // the empty state that has to name it. Its own window, not the tab's: the
  // ledger below can be read over a different period than the figures above.
  const rangeWords = range === 'cycle'
    ? cycle
      ? `${shortDayLabel(cycle.from)} – ${shortDayLabel(cycle.closedOn)}`
      : 'this cycle'
    : range === 'all'
      ? 'all time'
      : periodLabel(anchor, CARD_RANGE_SPAN[range]);
  // What the window comes to in months, for a breakdown opened off the page:
  // the ledger takes its window in months, and a cycle is near enough one.
  const rangeSpan = range === 'cycle' ? 1 : CARD_RANGE_SPAN[range];

  // The figure the page leads on is what the window on screen came to —
  // whatever window that is. A month reads the month, a cycle reads the
  // cycle, and what the card owes today is the bill below, which is a fact
  // about this morning rather than about the period being read.
  //
  // The bar under it measures that same spending against the limit the card
  // was on when the window ended, which is why the days it changed are worth
  // recording.
  const thenLimit = card.windowCreditLimit || card.creditLimit;
  const used = thenLimit > 0 ? Math.min(1, card.spend / thenLimit) : 0;
  const raised = card.windowCreditLimit > 0 && card.windowCreditLimit !== card.creditLimit;
  const days = card.dueOn ? daysUntil(card.dueOn) : null;
  const closesIn = card.cycles.length
    ? daysUntil(card.cycles[card.cycles.length - 1].closedOn)
    : null;
  const categoryPeak = card.topCategories[0]?.total ?? 1;
  // What the card gives back. Earned on every purchase and paid a cycle at a
  // time, so what is shown is what the open cycle has earned and not been
  // credited yet — it goes back to nothing the day the cycle closes, when it
  // lands on the card.
  const givesBack = card.cashbackRateE4 > 0 || card.cashbackPending > 0 || card.cashbackTotal > 0;
  const capLeft = card.cashbackCap > 0 ? Math.max(0, card.cashbackCap - card.cashbackPending) : null;

  // What each cycle came to. What was paid against it is the statements list
  // below, where it can be read as a fact rather than guessed off a bar.
  const points = card.cycles.map((cycle) => ({
    bucket: cycle.closedOn,
    value: Math.max(0, cycle.spend),
  }));
  // The closed ones, newest first, for the statement history — and what they
  // have averaged, which is the one thing a run of bars is bad at saying.
  const closed = card.cycles.filter((c) => !c.open).reverse();
  const settled = closed.filter((c) => c.spend > 0);
  const average = settled.length
    ? Math.round(settled.reduce((sum, c) => sum + c.spend, 0) / settled.length)
    : 0;

  return (
    <div className="screen cards-screen">
      <header className="screen-head detail-head">
        <div className="detail-id">
          <button className="detail-back" data-label="Cards" onClick={onBack} aria-label="Back to cards">
            <Icon name="chevron-left" size={17} />
          </button>
          {/* The card itself is drawn below, institution, cycle and all —
              a line of the same under the title said it twice. */}
          <h1>{card.name}</h1>
        </div>
        <div className="head-actions card-range-bar">
          {/* The window the whole page is read over: the bill and the figures,
              what it bought, where it went, and the ledger under them. All
              time has no ends to step between, so it says so instead. */}
          <div className="month-nav card-range-nav">
            <IconButton
              icon="chevron-left"
              label={range === 'cycle' ? 'Earlier statement' : 'Earlier period'}
              size={28}
              disabled={!canBack}
              onClick={() => step(-1)}
            />
            <span className="month-label is-static">
              <span>{range === 'all' ? 'All time' : rangeWords}</span>
            </span>
            <IconButton
              icon="chevron-right"
              label={range === 'cycle' ? 'Later statement' : 'Later period'}
              size={28}
              disabled={!canForward}
              onClick={() => step(1)}
            />
          </div>
          <Segmented
            name="card-range"
            size="sm"
            options={rangeOptions}
            value={range}
            onChange={setRange}
          />
          <Button icon="pencil" onClick={onEdit}>Edit card</Button>
        </div>
      </header>

      {card.statementDay <= 0 && (
        <div className="cards-alert" role="status">
          <span className="cards-alert-glyph">
            <Icon name="calendar-days" size={17} />
          </span>
          <div className="cards-alert-body">
            <strong>This card has no billing cycle</strong>
            <p>
              Set the day it closes and the day it is due, and the card is read
              by its own cycle: what is billed, what is not yet, and how long you
              have to pay.
            </p>
          </div>
          <Button tone="primary" size="sm" icon="calendar-days" onClick={onEdit}>
            Set the cycle
          </Button>
        </div>
      )}

      <Card className="card-detail" padded={false}>
        <div className="card-detail-hero">
          <CardPlastic card={card} />
          <div className="card-detail-standing">
            {/* No label over it: the stepper in the page head says which
                window this is, and the bar under it says what it is. */}
            <BigMoney value={card.spend} className="cards-total" />
            {thenLimit > 0 && (
              <LimitBar
                value={used}
                limit={thenLimit}
                caption={raised ? 'of the limit it had then' : 'of the limit'}
              />
            )}
            <CycleTrack card={card} />
          </div>
        </div>

        <div className="figure-row">
          {card.statementDay > 0 ? (
            <>
              <Figure
                label="Billed"
                value={money(card.billed)}
                tone={days === null ? 'flat' : dueTone(days, card.billed)}
                hint={
                  card.billed <= 0
                    ? card.statementTotal > 0
                      ? `${compactMoney(card.statementTotal)} bill cleared`
                      : 'nothing was billed'
                    : days === null
                      ? `of a ${compactMoney(card.statementTotal)} bill`
                      : `${dueWords(days)} · ${shortDayLabel(card.dueOn!)}`
                }
              />
              <Figure
                label="Unbilled"
                value={money(card.unbilled)}
                hint={
                  closesIn === null
                    ? 'since the last statement'
                    : closesIn <= 0
                      ? 'the cycle closes today'
                      : `cycle closes in ${closesIn} ${closesIn === 1 ? 'day' : 'days'}`
                }
              />
            </>
          ) : (
            <Figure
              label="Owed"
              value={money(card.outstanding)}
              hint="no billing cycle set"
              action={<button type="button" onClick={onEdit}>Set one</button>}
            />
          )}
          <Figure
            label="Paid"
            value={money(card.paid)}
            tone={card.paid > 0 ? 'good' : 'flat'}
            hint={
              card.paidSince > 0
                ? `${compactMoney(card.paidSince)} since the statement`
                : 'nothing since the statement'
            }
          />
          {givesBack && (
            <Figure
              label={card.cashbackRateE4 > 0 ? `Cashback · ${cashbackRate(card.cashbackRateE4)}` : 'Cashback'}
              value={money(card.cashbackPending)}
              tone={card.cashbackPending > 0 ? 'good' : 'flat'}
              hint={[
                card.cashbackCreditsOn ? `credited ${shortDayLabel(card.cashbackCreditsOn)}` : null,
                capLeft !== null
                  ? capLeft > 0
                    ? `${compactMoney(capLeft)} of ${compactMoney(card.cashbackCap)} left`
                    : `${compactMoney(card.cashbackCap)} cap reached`
                  : card.cashbackTotal > 0
                    ? `${compactMoney(card.cashbackTotal)} credited so far`
                    : null,
              ].filter(Boolean).join(' · ') || 'earned this cycle'}
            />
          )}
        </div>

        {points.length > 0 && (
          <section className="card-detail-chart">
            <SectionHead
              title="What each cycle came to"
              hint={
                average > 0
                  ? `${money(average)} a cycle on average · the last one is still running`
                  : 'the last one is still running'
              }
            />
            <SpendBars
              points={points}
              labelOf={shortDayLabel}
              height={168}
              color={card.color}
              openLast
            />
          </section>
        )}
      </Card>

      {/* Three ways of reading the same spending, under one roof rather than
          in three boxes of their own. */}
      <Card className="card-lists" padded={false}>
        {closed.length > 0 && (
          <section>
            <SectionHead title="Statements" hint="what each bill came to" />
            <ul className="cycle-list">
              {closed.slice(0, 6).map((cycle) => {
                const cleared = cycle.paid >= cycle.spend && cycle.spend > 0;
                return (
                  <li key={cycle.closedOn}>
                    <span className="cycle-when">
                      {shortDayLabel(cycle.closedOn)}
                      <small>from {shortDayLabel(cycle.from)}</small>
                    </span>
                    <span className="cycle-amount">
                      {money(cycle.spend)}
                      {cycle.cashback > 0 && <small>{money(cycle.cashback)} back</small>}
                    </span>
                    <span className={`cycle-paid ${cleared ? 'is-clear' : ''}`}>
                      {cleared && <Icon name="check" size={11} strokeWidth={3} />}
                      {cycle.paid > 0 ? money(cycle.paid) : 'unpaid'}
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        <section>
          <SectionHead title="What it bought" hint={rangeWords} />
          {card.topCategories.length ? (
            <>
              {/* The same donut the dashboard and the wallet are read by —
                  the shape of a period's spending is one picture, wherever
                  it is being asked about. */}
              <div className="card-donut">
                <Donut
                  size={148}
                  thickness={17}
                  slices={card.topCategories.map((c) => ({
                    id: c.categoryId,
                    label: c.name,
                    value: c.total,
                    color: c.color,
                  }))}
                  centerLabel="Spent"
                  centerValue={compactMoney(card.spend)}
                  onSelect={(id) => onOpenCategory(id, rangeSpan)}
                />
              </div>
              <motion.ul
                className="cat-list"
                variants={listVariants}
                initial="initial"
                animate="animate"
              >
                {card.topCategories.slice(0, 6).map((c) => (
                  <motion.li key={c.categoryId} variants={itemVariants}>
                    <button
                      type="button"
                      className="cat-row"
                      onClick={() => onOpenCategory(c.categoryId, rangeSpan)}
                      title={`Show ${c.name} over ${rangeWords}`}
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
            </>
          ) : (
            <p className="section-empty">
              {range === 'all'
                ? 'Nothing has ever been put on this card.'
                : `Nothing was put on this card in ${rangeWords}.`}
            </p>
          )}
        </section>

        <section>
          <SectionHead title="Where it went" hint={rangeWords} />
          {card.topMerchants.length ? (
            <motion.ul
              className="merchant-list"
              variants={listVariants}
              initial="initial"
              animate="animate"
            >
              {card.topMerchants.map((m, i) => (
                <motion.li key={m.merchant} variants={itemVariants}>
                  <span className="merchant-rank">{i + 1}</span>
                  <span className="merchant-name">
                    {m.merchant}
                    <small>
                      {m.count} {m.count === 1 ? 'time' : 'times'}
                    </small>
                  </span>
                  <span className="merchant-total">{money(m.total)}</span>
                </motion.li>
              ))}
            </motion.ul>
          ) : (
            <p className="section-empty">Charges with a merchant are ranked here.</p>
          )}
        </section>
      </Card>

      {/* The card's own ledger. Not a preview of one: the whole of whatever
          window is chosen, read newest first, a page at a time. */}
      <Card padded={false} className="row-board">
        <div className="card-recent-head">
          <SectionHead
            title="Everything on this card"
            hint={
              loading && !summary
                ? 'newest first'
                : `${total.toLocaleString('en-IN')} ${total === 1 ? 'entry' : 'entries'} · ${
                  money(summary?.expense ?? 0)} charged`
            }
          />
          <Button size="sm" tone="ghost" trailingIcon="arrow-right" onClick={onOpenLedger}>
            Open in ledger
          </Button>
        </div>
        {loading && rows.length === 0 ? (
          <div className="skeletons">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="skeleton-row" style={{ animationDelay: `${i * 60}ms` }} />
            ))}
          </div>
        ) : rows.length ? (
          <>
            <div className="tx-list">
              {rows.map((tx, i) => {
                // A band over each month's first entry, with what it charged.
                const month = tx.occurredAt.slice(0, 7);
                const newMonth = i === 0 || rows[i - 1].occurredAt.slice(0, 7) !== month;
                const charged = newMonth
                  ? rows
                    .filter((r) => r.occurredAt.startsWith(month) && r.kind === 'expense')
                    .reduce((sum, r) => sum + r.amount, 0)
                  : 0;
                return (
                <Fragment key={tx.id}>
                {newMonth && (
                  <div className="band-head card-month">
                    {monthLabel(month, true)}
                    <span>{money(charged)} charged</span>
                  </div>
                )}
                <TransactionRow
                  tx={tx}
                  showDate={shortDayLabel(tx.occurredAt)}
                  // Long lists simply appear; a stagger over hundreds of rows
                  // is a wait rather than a flourish.
                  enterDelay={rows.length > CARD_STAGGER_UP_TO ? 0 : i * 0.028}
                  onClick={() => onOpenTransaction(tx)}
                />
                </Fragment>
                );
              })}
            </div>
            {remaining > 0 && (
              <div className="ledger-more card-more">
                <span>
                  Showing {rows.length.toLocaleString('en-IN')} of{' '}
                  {total.toLocaleString('en-IN')}
                </span>
                <div className="ledger-more-actions">
                  <Button
                    size="sm"
                    onClick={() => setShown((n) => n + CARD_PAGE)}
                    disabled={loading}
                  >
                    {loading ? 'Loading…' : `Show ${Math.min(CARD_PAGE, remaining)} more`}
                  </Button>
                  {remaining > CARD_PAGE && (
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
          </>
        ) : (
          <Empty
            art={range === 'all' ? 'card' : 'search'}
            tone={range === 'all' ? 'blue' : 'ink'}
            title={range === 'all' ? 'Nothing on it yet' : `Nothing in ${rangeWords}`}
            body={
              range === 'all'
                ? 'Charges on this card show up here.'
                : 'Nothing was put on this card over that window.'
            }
            action={
              range === 'all' ? undefined : (
                <Button tone="primary" onClick={() => setRange('all')}>
                  Show all time
                </Button>
              )
            }
          />
        )}
      </Card>
    </div>
  );
}
