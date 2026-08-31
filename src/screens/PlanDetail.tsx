import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Icon } from '../components/Icon';
import { MerchantLogo } from '../components/MerchantLogo';
import { BigMoney } from '../components/Money';
import { Button, Card, CardHead, Empty, MoreMenu } from '../components/ui';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { cadenceLabel, cadenceSuffix, dueLabel, hasRisen } from '../lib/plans';
import { compactMoney, money, percent, shortDayLabel } from '../lib/format';
import { itemVariants, listVariants, spring } from '../lib/motion';
import type { Plan, PlanOccurrence } from '../lib/types';

/** How long ago, said the way you would say it. */
function since(day: string) {
  const days = Math.floor((Date.now() - new Date(`${day}T00:00`).getTime()) / 86_400_000);
  if (days < 1) return 'today';
  if (days < 31) return `${days} ${days === 1 ? 'day' : 'days'} ago`;
  const months = Math.round(days / 30.44);
  if (months < 24) return `${months} ${months === 1 ? 'month' : 'months'} ago`;
  return `${(days / 365.25).toFixed(1)} years ago`;
}

/** What one turn of the wheel came to. */
type Turn = 'paid' | 'missed' | 'skipped' | 'due';

function turnOf(o: PlanOccurrence, today: string): Turn {
  if (o.paid) return 'paid';
  if (o.skipped) return 'skipped';
  return o.dueOn < today ? 'missed' : 'due';
}

const TURN_LABEL: Record<Turn, string> = {
  paid: 'Paid',
  missed: 'Nothing paid',
  skipped: 'Skipped',
  due: 'Due',
};

/**
 * One plan, whole: what it costs, what it has cost, and every turn of it —
 * the ones that were paid and, just as loudly, the ones that were not.
 *
 * A subscription is only ever interesting over time. A price that crept up
 * ₹50 at a time, three months nobody was billed, a bill that quietly doubled
 * — none of that can be seen from a row in a list, and all of it is here.
 */
export function PlanDetail({
  plan, onBack, onEdit, onLink, onOpenTransaction,
}: {
  plan: Plan;
  onBack: () => void;
  onEdit: () => void;
  /** Opens the sheet for saying which payments belong to this plan. */
  onLink: () => void;
  onOpenTransaction: (transactionId: string) => void;
}) {
  const { revision, payPlan, skipPlan, setPlanArchived, unlinkPlanPosting } = useStore();
  const [timeline, setTimeline] = useState<PlanOccurrence[] | null>(null);
  const today = new Date().toISOString().slice(0, 10);

  useEffect(() => {
    let live = true;
    setTimeline(null);
    api
      .planTimeline(plan.id)
      .then((rows) => live && setTimeline(rows))
      .catch(() => live && setTimeline([]));
    return () => {
      live = false;
    };
  }, [plan.id, revision]);

  const stats = useMemo(() => {
    const rows = timeline ?? [];
    const paid = rows.filter((o) => o.paid);
    const amounts = paid.map((o) => o.actualAmount);
    // Cycles that were genuinely owed: what is still ahead was never owed,
    // and what was let go on purpose was never missed.
    const owed = rows.filter((o) => o.dueOn <= today && !o.skipped);
    const missed = owed.length - paid.filter((o) => o.dueOn <= today).length;
    return {
      paid,
      count: paid.length,
      total: amounts.reduce((sum, a) => sum + a, 0),
      average: amounts.length
        ? Math.round(amounts.reduce((sum, a) => sum + a, 0) / amounts.length)
        : 0,
      lowest: amounts.length ? Math.min(...amounts) : 0,
      highest: amounts.length ? Math.max(...amounts) : 0,
      first: paid[0] ?? null,
      last: paid[paid.length - 1] ?? null,
      owed: owed.length,
      missed,
      skipped: rows.filter((o) => o.skipped).length,
    };
  }, [timeline, today]);

  // What it costs now against what it cost the first time it was paid. The
  // whole point of watching a subscription is catching this.
  const opening = stats.first?.actualAmount ?? 0;
  const latest = stats.last?.actualAmount ?? 0;
  const change = opening && latest ? latest - opening : 0;
  const changePct = opening ? (change / opening) * 100 : 0;

  // What the plan is for. Past payments coming in lower is history; it does
  // not make the next one lower.
  const expected = plan.amount;
  const late = (plan.daysUntil ?? 0) < 0 && plan.status !== 'ended';
  const tint = plan.categoryColor ?? (plan.kind === 'income' ? 'var(--green)' : 'var(--ink-3)');

  return (
    <div className="screen">
      <header className="screen-head detail-head">
        <div className="detail-id">
          <button className="detail-back" onClick={onBack} aria-label="Back to planned payments">
            <Icon name="chevron-left" size={17} />
          </button>
          <MerchantLogo
            merchant={plan.merchant || plan.name}
            icon={plan.categoryIcon ?? 'repeat'}
            tint={tint}
            size={42}
            glyphSize={19}
          />
          <div>
            <h1>{plan.name}</h1>
            <p>
              {cadenceLabel(plan.cadence, plan.every)}
              {plan.accountName ? ` · from ${plan.accountName}` : ''}
              {plan.categoryName ? ` · ${plan.categoryName}` : ''}
              {stats.first ? ` · since ${shortDayLabel(stats.first.dueOn)}` : ''}
            </p>
          </div>
        </div>
        <div className="head-actions">
          <Button icon="link" onClick={onLink}>Link payments</Button>
          <Button icon="pencil" onClick={onEdit}>Edit</Button>
          {plan.status !== 'ended' && !plan.archived && (
            <Button tone="primary" icon="check" onClick={() => payPlan(plan.id)}>
              Mark paid
            </Button>
          )}
          <MoreMenu
            items={[
              {
                icon: 'corner-up-left',
                label: 'Skip this one',
                hint: 'nothing owed',
                onClick: () => skipPlan(plan.id),
              },
              {
                icon: plan.archived ? 'undo-2' : 'circle-dashed',
                label: plan.archived ? 'Bring back' : 'Put away',
                onClick: () => setPlanArchived(plan.id, !plan.archived),
              },
            ]}
          />
        </div>
      </header>

      <Card className="detail-summary">
        <div className="detail-top">
          <div className="detail-hero-main">
            <span className="detail-label">
              {plan.status === 'ended'
                ? 'Finished'
                : late
                  ? 'Overdue'
                  : plan.kind === 'income'
                    ? 'Next payment in'
                    : 'Next payment'}
            </span>
            <BigMoney value={expected} className="hero-amount" />
            <p className="detail-hero-sub">
              {plan.nextDue
                ? `${dueLabel(plan)} · ${shortDayLabel(plan.nextDue)}`
                : 'nothing more due'}
              {` · ${cadenceSuffix(plan.cadence, plan.every)}`}
            </p>
          </div>
          <div className="plan-row-tags plan-detail-tags">
            {hasRisen(plan) && (
              <span className="plan-tag is-warn">
                <Icon name="trending-up" size={11} /> {money(plan.drift)} above plan
              </span>
            )}
            {plan.status === 'lapsed' && (
              <span className="plan-tag is-warn">
                <Icon name="circle-dashed" size={11} /> Looks stopped
              </span>
            )}
            {stats.count === 0 && timeline !== null && (
              <span className="plan-tag">
                <Icon name="link" size={11} /> Nothing linked yet
              </span>
            )}
          </div>
        </div>

        <div className="detail-figures">
          <Figure
            label="Paid so far"
            value={money(stats.total)}
            hint={`${stats.count} ${stats.count === 1 ? 'payment' : 'payments'}`}
          />
          <Figure
            label="Average paid"
            value={stats.count ? money(stats.average) : '—'}
            hint={
              !stats.count
                ? `${money(plan.amount)} a time is what it is for`
                : stats.lowest !== stats.highest
                  ? `${compactMoney(stats.lowest)} – ${compactMoney(stats.highest)}`
                  : 'the same every time'
            }
          />
          <Figure
            label="A year of this"
            value={money(plan.yearlyAmount)}
            hint={`${money(plan.monthlyAmount)} a month`}
          />
          <Figure
            label="Kept up"
            value={stats.owed ? `${stats.count} of ${stats.owed}` : '—'}
            hint={
              stats.missed > 0
                ? `${stats.missed} ${stats.missed === 1 ? 'cycle' : 'cycles'} unpaid`
                : stats.skipped > 0
                  ? `${stats.skipped} skipped on purpose`
                  : 'every cycle paid'
            }
            tone={stats.missed > 0 ? 'bad' : undefined}
          />
        </div>
      </Card>

      <div className="detail-grid">
        <Card className="chart-card">
          <CardHead
            title="What it has cost"
            hint={
              change !== 0
                ? `${money(opening)} when it started, ${money(latest)} now`
                : 'Every cycle since it began'
            }
            action={
              change !== 0 ? (
                <span className={`plan-change ${change > 0 ? 'is-up' : 'is-down'}`}>
                  <Icon name={change > 0 ? 'trending-up' : 'trending-down'} size={14} />
                  {money(Math.abs(change))} · {percent(changePct, { sign: true })}
                </span>
              ) : undefined
            }
          />
          {timeline === null ? (
            <div className="plan-history-loading" />
          ) : stats.count === 0 ? (
            <Empty
              icon="link"
              title="No payments linked yet"
              body="A plan counts what you tell it to. Link the payments you have already made and its history, its average and its next date all fill in."
              action={<Button tone="primary" icon="link" onClick={onLink}>Link payments</Button>}
            />
          ) : (
            <CycleBars occurrences={timeline} today={today} tint={tint} />
          )}
        </Card>

        <Card padded={false} className="plan-history-card">
          <div className="card-pad card-head-only">
            <CardHead
              title="Every cycle"
              hint={
                timeline
                  ? `${timeline.length} since ${shortDayLabel(timeline[0]?.dueOn ?? plan.anchorOn)}`
                  : 'Reading the ledger'
              }
            />
          </div>
          {timeline === null ? (
            <div className="plan-history-loading" />
          ) : timeline.length === 0 ? (
            <div className="card-pad">
              <Empty icon="repeat" title="Nothing yet" body="No cycle has come round." />
            </div>
          ) : (
            <motion.ul
              className="plan-history"
              variants={listVariants}
              initial="initial"
              animate="animate"
            >
              {[...timeline].reverse().map((o) => {
                const turn = turnOf(o, today);
                return (
                  <motion.li key={o.dueOn} variants={itemVariants}>
                    <button
                      type="button"
                      className={`plan-history-row is-${turn}`}
                      disabled={!o.transactionId}
                      onClick={() => o.transactionId && onOpenTransaction(o.transactionId)}
                    >
                      <span className="plan-history-mark">
                        <Icon
                          name={
                            turn === 'paid'
                              ? 'check'
                              : turn === 'skipped'
                                ? 'corner-up-left'
                                : turn === 'missed'
                                  ? 'x'
                                  : 'circle-dashed'
                          }
                          size={12}
                          strokeWidth={2.6}
                        />
                      </span>
                      <span className="plan-history-when">
                        <strong>{shortDayLabel(o.dueOn)}</strong>
                        <span>{since(o.dueOn)}</span>
                      </span>
                      <span className="plan-history-what">{TURN_LABEL[turn]}</span>
                      <span className="plan-history-amount">
                        {o.paid ? money(o.actualAmount) : '—'}
                      </span>
                      {o.transactionId && <Icon name="chevron-right" size={14} />}
                    </button>
                    {o.transactionId && (
                      <button
                        type="button"
                        className="plan-history-unlink"
                        title="This payment was not for this plan"
                        aria-label="Unlink this payment"
                        onClick={() => unlinkPlanPosting(plan.id, o.transactionId!)}
                      >
                        <Icon name="x" size={13} />
                      </button>
                    )}
                  </motion.li>
                );
              })}
            </motion.ul>
          )}
        </Card>
      </div>
    </div>
  );
}

function Figure({
  label, value, hint, tone,
}: { label: string; value: string; hint: string; tone?: 'bad' }) {
  return (
    <div className="detail-figure">
      <span>{label}</span>
      <strong className={tone === 'bad' ? 'is-down' : undefined}>{value}</strong>
      <small>{hint}</small>
    </div>
  );
}

/**
 * A bar per cycle, in time order.
 *
 * The unpaid cycles are drawn as empty slots rather than left out, because a
 * subscription's holes are the part worth seeing: three gaps in a row is how
 * you find out something stopped billing you a year ago.
 */
function CycleBars({
  occurrences, today, tint,
}: { occurrences: PlanOccurrence[]; today: string; tint: string }) {
  const [hover, setHover] = useState<number | null>(null);
  // The last two years' worth at most — beyond that the bars are hairlines.
  const shown = occurrences.slice(-36);
  const peak = Math.max(1, ...shown.map((o) => o.actualAmount || o.amount));

  return (
    <div className="cycle-bars">
      <div className="cycle-row">
        {shown.map((o, i) => {
          const turn = turnOf(o, today);
          const height = ((o.actualAmount || o.amount) / peak) * 100;
          return (
            <div
              key={o.dueOn}
              className={`cycle-slot is-${turn}`}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
            >
              <motion.span
                className="cycle-bar"
                style={turn === 'paid' ? { background: tint } : undefined}
                initial={{ height: 0 }}
                animate={{ height: `${Math.max(3, height)}%` }}
                transition={{ duration: 0.5, delay: i * 0.012, ease: [0.06, 0.94, 0.67, 1.01] }}
              />
              <AnimatePresence>
                {hover === i && (
                  <motion.div
                    className="flow-tip cycle-tip"
                    initial={{ opacity: 0, y: 6, scale: 0.96 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: 4, scale: 0.97 }}
                    transition={spring}
                  >
                    <strong>{shortDayLabel(o.dueOn)}</strong>
                    <span className="tip-row">
                      {o.paid ? money(o.actualAmount) : TURN_LABEL[turn]}
                    </span>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          );
        })}
      </div>
      <div className="cycle-legend">
        <span><i className="is-paid" style={{ background: tint }} /> Paid</span>
        <span><i className="is-missed" /> Nothing paid</span>
        <span><i className="is-due" /> Still to come</span>
      </div>
    </div>
  );
}
