import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Icon } from '../components/Icon';
import { MerchantLogo } from '../components/MerchantLogo';
import { PlanCalendar } from '../components/PlanCalendar';
import { PlanDetail } from './PlanDetail';
import {
  Button, Card, CardHead, Empty, Meter, MoreMenu, Segmented, type SegmentOption,
} from '../components/ui';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import {
  cadenceLabel, cadenceSuffix, dueLabel, hasRisen, isLive, monthlyTotal,
} from '../lib/plans';
import { compactMoney, money, monthKey, shortDayLabel } from '../lib/format';
import { itemVariants, listVariants } from '../lib/motion';
import type { Plan, PlanOccurrence, PlanPosting } from '../lib/types';
import type { PlanDraft } from '../components/PlanSheet';

type Tab = 'upcoming' | 'calendar' | 'all';

const tint = (plan: Plan) =>
  plan.categoryColor ?? (plan.kind === 'income' ? 'var(--green)' : 'var(--ink-3)');

export function Planned({
  onNewPlan, onEditPlan, onLinkPlan, onOpenTransaction,
}: {
  onNewPlan: (draft?: PlanDraft) => void;
  onEditPlan: (plan: Plan) => void;
  /** Opens the sheet for saying which payments belong to a plan. */
  onLinkPlan: (plan: Plan) => void;
  onOpenTransaction: (transactionId: string) => void;
}) {
  const { plans, overview, revision, skipPlan, payPlan, setPlanArchived } = useStore();
  const [tab, setTab] = useState<Tab>('upcoming');
  // Held by id rather than by object, so the open page follows the plan
  // through every write the store makes.
  const [openId, setOpenId] = useState<string | null>(null);
  const [month, setMonth] = useState(monthKey);
  const [occurrences, setOccurrences] = useState<PlanOccurrence[]>([]);

  const live = useMemo(() => plans.filter(isLive), [plans]);
  const committed = monthlyTotal(plans, 'expense');
  const incoming = monthlyTotal(plans, 'income');
  const yearly = live
    .filter((p) => p.kind === 'expense')
    .reduce((sum, p) => sum + p.yearlyAmount, 0);
  const soon = live.filter((p) => p.daysUntil !== null && p.daysUntil <= 7);
  const soonTotal = soon.reduce((sum, p) => sum + (p.variable ? p.averageAmount : p.amount), 0);
  const risen = useMemo(() => plans.filter(hasRisen), [plans]);
  const lapsed = plans.filter((p) => p.status === 'lapsed' && !p.archived);
  const share = overview && overview.income > 0
    ? Math.round((committed / overview.income) * 100)
    : null;

  // The calendar asks for whatever month it is showing, and again after any
  // write — marking one paid should tick that day off without a reload.
  useEffect(() => {
    if (tab !== 'calendar') return;
    const [y, m] = month.split('-').map(Number);
    const last = new Date(y, m, 0).getDate();
    let cancelled = false;
    api
      .planCalendar(`${month}-01`, `${month}-${String(last).padStart(2, '0')}`)
      .then((rows) => { if (!cancelled) setOccurrences(rows); })
      .catch(() => { if (!cancelled) setOccurrences([]); });
    return () => { cancelled = true; };
  }, [tab, month, revision]);

  const tabs: SegmentOption<Tab>[] = [
    { value: 'upcoming', label: 'Upcoming', icon: 'calendar-days' },
    { value: 'calendar', label: 'Calendar', icon: 'grid-2x2' },
    { value: 'all', label: `All${plans.length ? ` · ${plans.length}` : ''}`, icon: 'repeat' },
  ];

  const viewing = openId ? plans.find((p) => p.id === openId) ?? null : null;
  if (viewing) {
    return (
      <PlanDetail
        plan={viewing}
        onBack={() => setOpenId(null)}
        onEdit={() => onEditPlan(viewing)}
        onLink={() => onLinkPlan(viewing)}
        onOpenTransaction={onOpenTransaction}
      />
    );
  }

  return (
    <div className="screen">
      <header className="screen-head">
        <div>
          <h1>Planned</h1>
          <p>
            {live.length
              ? `${live.length} running · ${money(committed)} a month committed`
              : 'Rent, subscriptions, EMIs — the money that comes round again.'}
          </p>
        </div>
        <div className="head-actions">
          <Button tone="primary" icon="plus" onClick={() => onNewPlan()}>
            New plan
          </Button>
        </div>
      </header>

      <motion.div className="stat-row" variants={listVariants} initial="initial" animate="animate">
        <Stat
          icon="repeat"
          label="Committed each month"
          value={money(committed)}
          hint={
            share !== null
              ? `${share}% of what came in this month`
              : `${live.filter((p) => p.kind === 'expense').length} plans going out`
          }
          tone={share !== null && share > 50 ? 'bad' : 'flat'}
        />
        <Stat
          icon="calendar-days"
          label="Due in the next week"
          value={money(soonTotal)}
          hint={soon.length ? `${soon.length} ${soon.length === 1 ? 'payment' : 'payments'}` : 'nothing falls due'}
          tone={soon.some((p) => (p.daysUntil ?? 0) < 0) ? 'bad' : 'flat'}
        />
        <Stat
          icon="banknote"
          label="A year of this"
          value={money(yearly)}
          hint={incoming > 0 ? `against ${compactMoney(incoming * 12)} planned in` : 'at today’s prices'}
        />
        <Stat
          icon={risen.length ? 'trending-up' : 'shield-check'}
          label={risen.length ? 'Quietly gone up' : 'Prices holding'}
          value={risen.length ? String(risen.length) : '—'}
          hint={
            risen.length
              ? `${risen[0].name} is ${money(risen[0].drift)} more`
              : 'nothing has crept up on you'
          }
          tone={risen.length ? 'bad' : 'good'}
        />
      </motion.div>

      {lapsed.length > 0 && (
        <Card className="plan-nudge">
          <span className="plan-nudge-glyph"><Icon name="circle-dashed" size={16} /></span>
          <div>
            <strong>
              {lapsed.length === 1
                ? `${lapsed[0].name} looks finished`
                : `${lapsed.length} plans look finished`}
            </strong>
            <p>
              {lapsed.length === 1 ? 'It was' : 'They were'} being paid, and
              then three cycles went by with nothing against{' '}
              {lapsed.length === 1 ? 'it' : 'them'}. Putting{' '}
              {lapsed.length === 1 ? 'it' : 'them'} away stops{' '}
              {lapsed.length === 1 ? 'it' : 'them'} counting toward what you
              owe each month; you’ll still find{' '}
              {lapsed.length === 1 ? 'it' : 'them'} under All.
            </p>
          </div>
          <Button
            icon="circle-dashed"
            onClick={() => Promise.all(lapsed.map((p) => setPlanArchived(p.id, true)))}
          >
            Put {lapsed.length === 1 ? 'it' : 'them all'} away
          </Button>
        </Card>
      )}

      {plans.length === 0 ? (
        <Card>
          <Empty
            icon="repeat"
            title="Nothing planned yet"
            body="Write down what comes round again — the rent, a subscription, the SIP — then link the payments you have already made to it."
            action={
              <Button tone="primary" icon="plus" onClick={() => onNewPlan()}>
                Add a planned payment
              </Button>
            }
          />
        </Card>
      ) : (
        <>
          <div className="screen-tabs">
            <Segmented options={tabs} value={tab} onChange={setTab} name="plan-tab" />
          </div>

          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={tab}
              className="tab-panel"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.16 }}
            >
              {tab === 'upcoming' && (
                <Upcoming
                  plans={plans}
                  onOpen={setOpenId}
                  onEdit={onEditPlan}
                  onLink={onLinkPlan}
                  onPay={(plan) => payPlan(plan.id)}
                  onSkip={(plan) => skipPlan(plan.id)}
                  onArchive={(plan) => setPlanArchived(plan.id, true)}
                  onOpenTransaction={onOpenTransaction}
                />
              )}

              {tab === 'calendar' && (
                <Card padded={false} className="plan-cal-card">
                  <PlanCalendar
                    month={month}
                    onMonthChange={setMonth}
                    occurrences={occurrences}
                    onOpenPlan={setOpenId}
                    onOpenTransaction={onOpenTransaction}
                  />
                </Card>
              )}

              {tab === 'all' && <AllPlans plans={plans} onOpen={setOpenId} />}

            </motion.div>
          </AnimatePresence>
        </>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- upcoming */

/** Which shelf a plan falls on. Time, not category: what lands on you first. */
function shelfOf(plan: Plan): string | null {
  if (!isLive(plan) || plan.daysUntil === null) return null;
  if (plan.daysUntil < 0) return 'Late';
  if (plan.daysUntil === 0) return 'Today';
  if (plan.daysUntil <= 7) return 'This week';
  if (plan.daysUntil <= 31) return 'This month';
  return 'Later';
}

const SHELVES = ['Late', 'Today', 'This week', 'This month', 'Later'];

function Upcoming({
  plans, onOpen, onEdit, onLink, onPay, onSkip, onArchive, onOpenTransaction,
}: {
  plans: Plan[];
  onOpen: (id: string) => void;
  onEdit: (plan: Plan) => void;
  onLink: (plan: Plan) => void;
  onPay: (plan: Plan) => void;
  onSkip: (plan: Plan) => void;
  onArchive: (plan: Plan) => void;
  onOpenTransaction: (id: string) => void;
}) {
  const shelves = SHELVES.map((name) => ({
    name,
    plans: plans.filter((p) => shelfOf(p) === name),
  })).filter((s) => s.plans.length > 0);

  if (!shelves.length) {
    return (
      <Card>
        <Empty
          icon="check-check"
          title="Nothing coming"
          body="Every plan you keep is either finished or put away."
        />
      </Card>
    );
  }

  return (
    <>
      {shelves.map((shelf) => {
        const total = shelf.plans.reduce(
          (sum, p) => sum + (p.kind === 'income' ? 0 : p.variable ? p.averageAmount : p.amount),
          0,
        );
        return (
          <section key={shelf.name} className="account-group">
            <h2 className="group-title">
              {shelf.name}
              <span>{money(total)}</span>
              <em>{shelf.plans.length} {shelf.plans.length === 1 ? 'payment' : 'payments'}</em>
            </h2>
            <motion.div
              className="plan-list"
              variants={listVariants}
              initial="initial"
              animate="animate"
            >
              {shelf.plans.map((plan) => (
                <PlanRow
                  key={plan.id}
                  plan={plan}
                  onOpen={() => onOpen(plan.id)}
                  onEdit={() => onEdit(plan)}
                  onLink={() => onLink(plan)}
                  onPay={() => onPay(plan)}
                  onSkip={() => onSkip(plan)}
                  onArchive={() => onArchive(plan)}
                  onOpenTransaction={onOpenTransaction}
                />
              ))}
            </motion.div>
          </section>
        );
      })}
    </>
  );
}

function PlanRow({
  plan, onOpen, onEdit, onLink, onPay, onSkip, onArchive, onOpenTransaction,
}: {
  plan: Plan;
  /** The row leads to the plan's own page; editing is a menu item. */
  onOpen: () => void;
  onEdit: () => void;
  onLink: () => void;
  onPay: () => void;
  onSkip: () => void;
  onArchive: () => void;
  onOpenTransaction: (id: string) => void;
}) {
  const expected = plan.variable && plan.averageAmount > 0 ? plan.averageAmount : plan.amount;
  const late = (plan.daysUntil ?? 0) < 0;
  const rise = hasRisen(plan);

  return (
    <motion.article
      className={`plan-row ${late ? 'is-late' : ''}`}
      variants={itemVariants}
    >
      <button className="plan-row-main" onClick={onOpen}>
        <MerchantLogo
          merchant={plan.merchant || plan.name}
          icon={plan.categoryIcon ?? 'repeat'}
          tint={tint(plan)}
          size={38}
        />
        <span className="plan-row-who">
          <strong>{plan.name}</strong>
          <span>
            {cadenceLabel(plan.cadence, plan.every)}
            {plan.accountName ? ` · ${plan.accountName}` : ''}
            {plan.automatic ? '' : ' · you pay it'}
          </span>
        </span>
        <span className="plan-row-when">
          <strong className={late ? 'is-down' : ''}>{dueLabel(plan)}</strong>
          <span>{plan.nextDue ? shortDayLabel(plan.nextDue) : '—'}</span>
        </span>
        <span className="plan-row-amount">
          <strong className={plan.kind === 'income' ? 'is-up' : ''}>{money(expected)}</strong>
          <span>
            {rise
              ? `up ${money(plan.drift)}`
              : plan.variable
                ? 'varies'
                : cadenceSuffix(plan.cadence, plan.every)}
          </span>
        </span>
      </button>

      <div className="plan-row-tags">
        {plan.automatic && (
          <span className="plan-tag"><Icon name="zap" size={11} /> Auto</span>
        )}
        {rise && (
          <span className="plan-tag is-warn">
            <Icon name="trending-up" size={11} /> {money(plan.drift)} more
          </span>
        )}
        {plan.paidCount > 0 ? (
          <span className="plan-tag">
            {plan.paidCount} paid · {money(plan.observedTotal)} so far
          </span>
        ) : (
          <span className="plan-tag">
            <Icon name="link" size={11} /> no payments linked yet
          </span>
        )}
        {plan.lastPaidOn && (
          <span className="plan-tag">Last {shortDayLabel(plan.lastPaidOn)}</span>
        )}
      </div>

      <div className="plan-row-actions">
        <PaymentSpark
          postings={plan.recent}
          onOpen={() => onOpenTransaction(plan.recent[plan.recent.length - 1].id)}
        />
        <Button size="sm" icon="check" onClick={onPay}>Paid</Button>
        <MoreMenu
          items={[
            { icon: 'link', label: 'Link payments', hint: 'from your ledger', onClick: onLink },
            { icon: 'pencil', label: 'Edit plan', onClick: onEdit },
            { icon: 'corner-up-left', label: 'Skip this one', hint: 'nothing owed', onClick: onSkip },
            { icon: 'circle-dashed', label: 'Put away', onClick: onArchive },
          ]}
        />
      </div>
    </motion.article>
  );
}

/**
 * The last few payments as bars.
 *
 * A price rise reads as a step here and as nothing at all in a column of
 * numbers, which is the whole reason it is drawn rather than listed.
 */
function PaymentSpark({
  postings, onOpen,
}: {
  postings: PlanPosting[];
  onOpen?: () => void;
}) {
  // An empty slot rather than nothing at all: a column that appears on some
  // rows and not others is what stops a list from lining up.
  if (postings.length < 2) return <span className="plan-spark is-empty" aria-hidden />;
  const peak = Math.max(...postings.map((p) => p.amount), 1);
  return (
    <button
      type="button"
      className="plan-spark"
      title="The last few payments"
      onClick={onOpen}
      disabled={!onOpen}
    >
      {postings.map((p, i) => (
        <i
          key={p.id || `${p.occurredAt}-${i}`}
          style={{ height: `${Math.max(14, (p.amount / peak) * 100)}%` }}
          title={`${shortDayLabel(p.occurredAt)} · ${money(p.amount)}`}
        />
      ))}
    </button>
  );
}

/* -------------------------------------------------------------- every plan */

function AllPlans({ plans, onOpen }: { plans: Plan[]; onOpen: (id: string) => void }) {
  const groups = [
    { name: 'Going out', kind: 'expense' as const },
    { name: 'Coming in', kind: 'income' as const },
    { name: 'Moving between accounts', kind: 'transfer' as const },
  ];
  const away = plans.filter((p) => p.archived || p.status === 'ended');
  const biggest = Math.max(
    1,
    ...plans.filter((p) => !p.archived).map((p) => p.monthlyAmount),
  );

  return (
    <>
      {groups.map((group) => {
        const mine = plans.filter((p) => !p.archived && p.status !== 'ended' && p.kind === group.kind);
        if (!mine.length) return null;
        const total = mine.reduce((sum, p) => sum + p.monthlyAmount, 0);
        return (
          <Card key={group.kind}>
            <CardHead
              title={group.name}
              hint={`${money(total)} a month across ${mine.length} ${mine.length === 1 ? 'plan' : 'plans'}`}
            />
            <motion.ul
              className="breakdown"
              variants={listVariants}
              initial="initial"
              animate="animate"
            >
              {[...mine]
                .sort((a, b) => b.monthlyAmount - a.monthlyAmount)
                .map((plan) => (
                  <motion.li key={plan.id} variants={itemVariants}>
                    <button className="breakdown-row" onClick={() => onOpen(plan.id)}>
                      <span className="cat-swatch" style={{ background: tint(plan) }}>
                        <Icon name={plan.categoryIcon ?? 'repeat'} size={12} strokeWidth={2.3} />
                      </span>
                      <div className="breakdown-main">
                        <div className="breakdown-top">
                          <span>
                            {plan.name}
                            <em className="plan-inline-note">
                              {' '}{cadenceLabel(plan.cadence, plan.every).toLowerCase()}
                            </em>
                          </span>
                          <strong>{money(plan.monthlyAmount)}<em>/mo</em></strong>
                        </div>
                        <Meter value={plan.monthlyAmount / biggest} color={tint(plan)} />
                      </div>
                      <span className="breakdown-pct">{money(plan.amount)}</span>
                    </button>
                  </motion.li>
                ))}
            </motion.ul>
          </Card>
        );
      })}

      {away.length > 0 && (
        <Card>
          <CardHead title="Put away" hint="Finished, or no longer counted" />
          <motion.ul className="breakdown" variants={listVariants} initial="initial" animate="animate">
            {away.map((plan) => (
              <motion.li key={plan.id} variants={itemVariants}>
                <button className="breakdown-row is-quiet" onClick={() => onOpen(plan.id)}>
                  <span className="cat-swatch" style={{ background: 'var(--ink-4)' }}>
                    <Icon name="circle-dashed" size={12} strokeWidth={2.3} />
                  </span>
                  <div className="breakdown-main">
                    <div className="breakdown-top">
                      <span>{plan.name}</span>
                      <strong>{money(plan.observedTotal)}</strong>
                    </div>
                  </div>
                  <span className="breakdown-pct">{plan.paidCount} paid</span>
                </button>
              </motion.li>
            ))}
          </motion.ul>
        </Card>
      )}
    </>
  );
}

function Stat({
  label, value, hint, icon, tone = 'flat',
}: {
  label: string;
  value: string;
  hint: string;
  icon: string;
  tone?: 'good' | 'bad' | 'flat';
}) {
  return (
    <motion.div className={`stat stat-${tone}`} variants={itemVariants} whileHover={{ y: -2 }}>
      <span className="stat-glyph">
        <Icon name={icon} size={16} />
      </span>
      <span className="stat-label">{label}</span>
      <strong className="stat-value">{value}</strong>
      <span className="stat-hint">{hint}</span>
    </motion.div>
  );
}
