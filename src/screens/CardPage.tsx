import { useEffect, useState, type ReactNode } from 'react';
import { motion } from 'motion/react';
import { Icon } from '../components/Icon';
import { BigMoney } from '../components/Money';
import { SpendBars } from '../components/charts';
import { TransactionRow } from '../components/TransactionRow';
import { Button, Card, Empty, Meter } from '../components/ui';
import { useStore } from '../lib/store';
import {
  compactMoney, money, percent, percentDelta, shortDayLabel,
} from '../lib/format';
import { itemVariants, listVariants } from '../lib/motion';
import type { CardStat, Transaction } from '../lib/types';

/* The words a card is read in. They are shared with the tab itself, which
   says the same things in less room. */

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

/** 1st, 2nd, 3rd — for saying a day of the month out loud. */
export function ordinal(day: number) {
  const tens = day % 100;
  const suffix = tens >= 11 && tens <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][day % 10] ?? 'th');
  return `${day}${suffix}`;
}

/** How a card describes its own cycle, when it keeps one. */
export function cycleWords(card: CardStat) {
  if (card.statementDay <= 0) return null;
  return `closes the ${ordinal(card.statementDay)}${
    card.dueDay > 0 ? `, due the ${ordinal(card.dueDay)}` : ''
  }`;
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
            {days === null ? 'still to pay' : dueWords(days)}
            {card.dueOn && <em>{shortDayLabel(card.dueOn)}</em>}
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

/**
 * One card, at length: the bill and the cycle it came from, where the money
 * went, and the charges themselves. Reached from the wallet on the tab,
 * which says the short version of all of it.
 */
export function CardPage({
  card, label, span, onBack, onEdit, onOpenLedger, onOpenCategory, onOpenTransaction,
}: {
  card: CardStat;
  /** The window on screen, as the month strip names it. */
  label: string;
  span: number;
  onBack: () => void;
  onEdit: () => void;
  onOpenLedger: () => void;
  onOpenCategory: (categoryId: string, span: number) => void;
  onOpenTransaction: (tx: Transaction) => void;
}) {
  const { listTransactions, revision } = useStore();
  const [recent, setRecent] = useState<Transaction[]>([]);

  // The charges themselves, newest first — payments into the card included,
  // since what you want off this page is everything the card has been doing.
  useEffect(() => {
    let live = true;
    listTransactions({ accountIds: [card.id], limit: 8 })
      .then((rows) => live && setRecent(rows))
      .catch(() => live && setRecent([]));
    return () => {
      live = false;
    };
  }, [card.id, listTransactions, revision]);

  const used = usedOf(card);
  const delta = percentDelta(card.spend, card.prevSpend);
  const days = card.dueOn ? daysUntil(card.dueOn) : null;
  const closesIn = card.cycles.length
    ? daysUntil(card.cycles[card.cycles.length - 1].closedOn)
    : null;
  const categoryPeak = card.topCategories[0]?.total ?? 1;

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
          <button className="detail-back" onClick={onBack} aria-label="Back to cards">
            <Icon name="chevron-left" size={17} />
          </button>
          <div>
            <h1>{card.name}</h1>
            <p>
              {[
                card.institution,
                cycleWords(card) ?? 'no billing cycle set',
                card.lastUsed ? `last used ${shortDayLabel(card.lastUsed)}` : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
          </div>
        </div>
        <div className="head-actions">
          <Button icon="list-filter" onClick={onOpenLedger}>Ledger</Button>
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
              Say which day the statement closes and which day it has to be paid,
              and the card is read by its own month: what is billed, what is not
              yet, and how long you have. Until then all of it is simply owed.
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
            <span className="figure-label">Outstanding</span>
            <BigMoney value={card.outstanding} className="cards-total" />
            <p className="card-detail-lead-sub">
              {card.balance > 0
                ? `${money(card.balance)} sitting in credit`
                : card.creditLimit > 0
                  ? `${money(card.available)} of ${money(card.creditLimit)} left to spend`
                  : 'no limit set on this card'}
            </p>
            {card.creditLimit > 0 && (
              <div className="card-detail-limit">
                <Meter
                  value={used}
                  color={used >= 0.85 ? 'var(--red)' : used >= 0.65 ? 'var(--amber)' : 'var(--green)'}
                />
                <span>{percent(used * 100)} of the limit used</span>
              </div>
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
            label={`Spent · ${label}`}
            value={money(card.spend)}
            tone={delta !== null && delta > 0 ? 'bad' : 'good'}
            hint={
              delta === null
                ? `${card.charges} ${card.charges === 1 ? 'charge' : 'charges'}`
                : `${percent(delta, { sign: true })} on ${compactMoney(card.prevSpend)} before`
            }
          />
          <Figure
            label={`Paid · ${label}`}
            value={money(card.paid)}
            tone={card.paid > 0 ? 'good' : 'flat'}
            hint={
              card.paidSince > 0
                ? `${compactMoney(card.paidSince)} since the statement`
                : 'nothing since the statement'
            }
          />
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
                    <span className="cycle-amount">{money(cycle.spend)}</span>
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
          <SectionHead title="What it bought" hint={label} />
          {card.topCategories.length ? (
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
          ) : (
            <p className="section-empty">Nothing was put on this card in {label}.</p>
          )}
        </section>

        <section>
          <SectionHead title="Where it went" hint={label} />
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
            <p className="section-empty">Name the payee on a charge to see it ranked here.</p>
          )}
        </section>
      </Card>

      <Card padded={false} className="row-board">
        <div className="card-recent-head">
          <SectionHead title="Latest on this card" hint="newest first" />
          <Button size="sm" tone="ghost" trailingIcon="arrow-right" onClick={onOpenLedger}>
            All of it
          </Button>
        </div>
        {recent.length ? (
          <div className="tx-list">
            {recent.map((tx, i) => (
              <TransactionRow
                key={tx.id}
                tx={tx}
                showDate={shortDayLabel(tx.occurredAt)}
                enterDelay={i * 0.028}
                onClick={() => onOpenTransaction(tx)}
              />
            ))}
          </div>
        ) : (
          <Empty
            icon="credit-card"
            title="Nothing on it yet"
            body="Charges written against this card show up here."
          />
        )}
      </Card>
    </div>
  );
}
