import { useEffect, useMemo, useState } from 'react';
import { motion } from 'motion/react';
import { Icon } from '../components/Icon';
import { MerchantLogo } from '../components/MerchantLogo';
import { PlanCalendar } from '../components/PlanCalendar';
import { PlanDetail } from './PlanDetail';
import { Button, Card, Empty, MoreMenu } from '../components/ui';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import {
  cadenceLabel, cadenceSuffix, dueLabel, isLive, monthlyTotal,
} from '../lib/plans';
import { money, monthKey, shiftMonth, shortDayLabel } from '../lib/format';
import { itemVariants, listVariants } from '../lib/motion';
import type { Plan, PlanOccurrence, PlanPosting } from '../lib/types';
import type { PlanDraft } from '../components/PlanSheet';

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
  const { plans, revision, skipPlan, payPlan, setPlanArchived } = useStore();
  // Held by id rather than by object, so the open page follows the plan
  // through every write the store makes.
  const [openId, setOpenId] = useState<string | null>(null);
  const [month, setMonth] = useState(monthKey);
  const [occurrences, setOccurrences] = useState<PlanOccurrence[]>([]);

  const live = useMemo(() => plans.filter(isLive), [plans]);
  const committed = monthlyTotal(plans, 'expense');
  const yearly = live
    .filter((p) => p.kind === 'expense')
    .reduce((sum, p) => sum + p.yearlyAmount, 0);
  const lapsed = plans.filter((p) => p.status === 'lapsed' && !p.archived);

  // The calendar asks for whatever month it is showing, and again after any
  // write — marking one paid should tick that day off without a reload.
  useEffect(() => {
    const [y, m] = month.split('-').map(Number);
    const last = new Date(y, m, 0).getDate();
    let cancelled = false;
    api
      .planCalendar(`${month}-01`, `${month}-${String(last).padStart(2, '0')}`)
      .then((rows) => { if (!cancelled) setOccurrences(rows); })
      .catch(() => { if (!cancelled) setOccurrences([]); });
    return () => { cancelled = true; };
  }, [month, revision]);

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
              ? `${live.length} running · ${money(committed)} a month committed · ${money(yearly)} a year`
              : 'Rent, subscriptions, EMIs — the money that comes round again.'}
          </p>
        </div>
        <div className="head-actions">
          <Button tone="primary" icon="plus" onClick={() => onNewPlan()}>
            New plan
          </Button>
        </div>
      </header>

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
              owe each month.
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
          <Card padded={false} className="plan-cal-card">
            <PlanCalendar
              month={month}
              onMonthChange={setMonth}
              occurrences={occurrences}
              onOpenPlan={setOpenId}
              onOpenTransaction={onOpenTransaction}
            />
          </Card>

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
        </>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- upcoming */

/**
 * Which shelf a plan falls on. Time, not category: what lands on you first.
 *
 * The near shelves are counted in days, because a week away is a week away
 * whatever the calendar says. Past that they are calendar months, because
 * "this month" is a claim about the month — a bill due on the 3rd is next
 * month's problem even when it is twenty days off, and counting it as this
 * month's made the total under that heading a figure for nothing.
 */
function shelfOf(plan: Plan): string | null {
  if (!isLive(plan) || plan.daysUntil === null || !plan.nextDue) return null;
  if (plan.daysUntil < 0) return 'Late';
  if (plan.daysUntil === 0) return 'Today';
  if (plan.daysUntil <= 7) return 'This week';
  const due = plan.nextDue.slice(0, 7);
  if (due === monthKey()) return 'This month';
  if (due === shiftMonth(monthKey(), 1)) return 'Next month';
  return 'Later';
}

const SHELVES = ['Late', 'Today', 'This week', 'This month', 'Next month', 'Later'];

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
          (sum, p) => sum + (p.kind === 'income' ? 0 : p.amount),
          0,
        );
        return (
          <section key={shelf.name} className="account-group">
            <h2 className="group-title">
              {shelf.name}
              <span>{money(total)}</span>
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
  const late = (plan.daysUntil ?? 0) < 0;

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
          </span>
        </span>
        <span className="plan-row-when">
          <strong className={late ? 'is-down' : ''}>{dueLabel(plan)}</strong>
          <span>{plan.nextDue ? shortDayLabel(plan.nextDue) : '—'}</span>
        </span>
        <span className="plan-row-amount">
          <strong className={plan.kind === 'income' ? 'is-up' : ''}>
            {money(plan.amount)}
          </strong>
          <span>{cadenceSuffix(plan.cadence, plan.every)}</span>
        </span>
      </button>

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

