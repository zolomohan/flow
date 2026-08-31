import type { Plan, PlanCadence, PlanStatus } from './types';

/** The rhythms a plan can keep, in the order they are offered. */
export const CADENCES: { value: PlanCadence; label: string; noun: string }[] = [
  { value: 'weekly', label: 'Weekly', noun: 'week' },
  { value: 'fortnightly', label: 'Fortnightly', noun: 'fortnight' },
  { value: 'monthly', label: 'Monthly', noun: 'month' },
  { value: 'quarterly', label: 'Quarterly', noun: 'quarter' },
  { value: 'half_yearly', label: 'Half-yearly', noun: 'half-year' },
  { value: 'yearly', label: 'Yearly', noun: 'year' },
];

/** "Monthly" for the ordinary case, "Every 2 months" when it is stretched. */
export function cadenceLabel(cadence: PlanCadence, every = 1) {
  const found = CADENCES.find((c) => c.value === cadence);
  if (!found) return 'Recurring';
  if (every <= 1) return found.label;
  return `Every ${every} ${found.noun}s`;
}

/** "a month", "a quarter" — for reading after an amount. */
export function cadenceSuffix(cadence: PlanCadence, every = 1) {
  const found = CADENCES.find((c) => c.value === cadence);
  if (!found) return '';
  return every <= 1 ? `a ${found.noun}` : `every ${every} ${found.noun}s`;
}

/**
 * How near a plan is, in words. Days rather than dates, because what you
 * want off a list of bills is which one lands on you first.
 */
export function dueLabel(plan: Plan): string {
  if (plan.status === 'archived') return 'Put away';
  if (plan.status === 'ended' || plan.daysUntil === null) return 'Finished';
  const days = plan.daysUntil;
  if (days === 0) return 'Due today';
  if (days === 1) return 'Due tomorrow';
  if (days === -1) return 'A day late';
  if (days < 0) return `${Math.abs(days)} days late`;
  if (days <= 13) return `In ${days} days`;
  if (days <= 60) return `In ${Math.round(days / 7)} weeks`;
  return `In ${Math.round(days / 30)} months`;
}

/** The colour a status wears wherever one is shown. */
export function statusTone(status: PlanStatus): 'good' | 'warn' | 'bad' | 'flat' {
  switch (status) {
    case 'overdue':
      return 'bad';
    case 'due':
      return 'warn';
    case 'lapsed':
    case 'ended':
    case 'archived':
      return 'flat';
    default:
      return 'good';
  }
}

/** A plan that is still running, as against put away or run out. */
export const isLive = (plan: Plan) =>
  !plan.archived && plan.status !== 'ended' && plan.status !== 'lapsed';

/** What a set of plans commits you to every month. */
export function monthlyTotal(plans: Plan[], kind: Plan['kind']) {
  return plans
    .filter((p) => isLive(p) && p.kind === kind)
    .reduce((sum, p) => sum + p.monthlyAmount, 0);
}

/**
 * A plan whose last payment came in above what it says it costs, by enough
 * to be a price rise rather than a rounding.
 */
export function hasRisen(plan: Plan) {
  if (plan.paidCount === 0 || plan.amount <= 0) return false;
  return plan.drift > Math.max(Math.round(plan.amount * 0.03), 100);
}
