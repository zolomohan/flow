import type { Debt, DebtDirection, DebtPayment, Paise } from './types';

/**
 * Everything one person owes on one side, or is owed. Every bill split with
 * somebody opens a debt of its own, so the bill keeps knowing whether its
 * share came back — but the person is who you are actually waiting on, and
 * the person is what the Debts screen shows.
 */
export interface DebtPerson {
  key: string;
  /** The name as the newest of their debts spells it. */
  counterparty: string;
  direction: DebtDirection;
  /** Oldest first — the order a repayment is laid over them in. */
  debts: Debt[];
  principal: Paise;
  paid: Paise;
  outstanding: Paise;
  openedOn: string;
}

/** The same name, whatever its spacing or case, is the same person. The
 *  book matches people the same way when a repayment is spread. */
export function personKey(direction: DebtDirection, name: string) {
  return `${direction}:${name.trim().toLowerCase()}`;
}

/** Debts gathered by who they are with, in the order the first of each
 *  person's debts came in the list. */
export function groupByPerson(debts: Debt[]): DebtPerson[] {
  const people = new Map<string, Debt[]>();
  for (const debt of debts) {
    const key = personKey(debt.direction, debt.counterparty);
    const list = people.get(key);
    if (list) list.push(debt);
    else people.set(key, [debt]);
  }
  return [...people.entries()].map(([key, list]) => personOf(key, list));
}

export function personOf(key: string, list: Debt[]): DebtPerson {
  const oldestFirst = [...list].sort(
    (a, b) => a.openedOn.localeCompare(b.openedOn) || a.createdAt.localeCompare(b.createdAt),
  );
  const newest = oldestFirst[oldestFirst.length - 1];
  return {
    key,
    counterparty: newest.counterparty,
    direction: newest.direction,
    debts: oldestFirst,
    principal: list.reduce((s, d) => s + d.principal, 0),
    paid: list.reduce((s, d) => s + d.paid, 0),
    outstanding: list.reduce((s, d) => s + d.outstanding, 0),
    openedOn: oldestFirst[0].openedOn,
  };
}

/**
 * The repayments across a person's debts, one row per repayment: the pieces
 * of a spread one are put back together into the single amount that changed
 * hands. Newest first.
 */
export function personRepayments(debts: Debt[]): DebtPayment[] {
  const spread = new Map<string, DebtPayment>();
  const rows: DebtPayment[] = [];
  for (const payment of debts.flatMap((d) => d.payments)) {
    if (!payment.spreadId) {
      rows.push(payment);
      continue;
    }
    const whole = spread.get(payment.spreadId);
    if (whole) whole.amount += payment.amount;
    else {
      const first = { ...payment };
      spread.set(payment.spreadId, first);
      rows.push(first);
    }
  }
  return rows.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
}
