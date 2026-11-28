import { motion } from 'motion/react';
import { Icon } from '../components/Icon';
import { BigMoney } from '../components/Money';
import { Button, Card, CardHead } from '../components/ui';
import { personRepayments, type DebtPerson } from '../lib/debts';
import { dayLabel, debtProgress, initials, isShareOfBill, money } from '../lib/format';
import type { Debt, DebtPayment } from '../lib/types';

/** What a debt was for, said in a few words. */
function debtTitle(debt: Debt) {
  if (isShareOfBill(debt)) return `Share of ${debt.transactionLabel ?? 'a split bill'}`;
  return debt.note ?? debt.transactionLabel ?? (debt.direction === 'lent' ? 'Lent' : 'Borrowed');
}

/**
 * Everybody's debts with one person, on one side, as the one running tab they
 * are: what is left across all of it, each bill it is made of, and what has
 * come back. A repayment from here is laid over the bills oldest first.
 */
export function PersonDebtDetail({
  person, onBack, onOpenDebt, onRecordPayment, onEditPayment, onAddMore,
}: {
  person: DebtPerson;
  onBack: () => void;
  onOpenDebt: (debt: Debt) => void;
  onRecordPayment: () => void;
  /** Opens one of the repayments — a spread one as its whole amount. */
  onEditPayment: (debt: Debt, payment: DebtPayment) => void;
  /** More handed over, on top of the newest debt still open. */
  onAddMore: () => void;
}) {
  const lent = person.direction === 'lent';
  const open = person.debts.filter((d) => !d.settled);
  const settled = person.debts.filter((d) => d.settled);
  const live = open.length > 0;
  // The figures are what is still running when anything is; once all of it is
  // squared up, they are the whole history with this person.
  const counted = live ? open : person.debts;
  const principal = counted.reduce((s, d) => s + d.principal, 0);
  const paid = counted.reduce((s, d) => s + Math.min(d.paid, d.principal), 0);
  const outstanding = open.reduce((s, d) => s + d.outstanding, 0);
  const forgiven = live ? 0 : counted.reduce((s, d) => s + debtProgress(d).forgivenAmount, 0);
  const bar = debtProgress({ principal, paid, settled: !live });

  // What came back against what is still running, and every repayment that
  // was spread — those belong to the person, not to any one bill.
  const repayments = personRepayments(person.debts).filter(
    (p) => p.spreadId || open.some((d) => d.id === p.debtId),
  );
  const debtOf = (p: DebtPayment) => person.debts.find((d) => d.id === p.debtId)!;
  const addMore = lent ? 'Lend more' : 'Borrow more';
  const addIcon = lent ? 'arrow-up-right' : 'arrow-down-left';

  const debtRows = (list: Debt[]) => (
    <ul>
      {[...list].reverse().map((debt) => (
        <li key={debt.id}>
          <button onClick={() => onOpenDebt(debt)}>
            <span className="debt-entry-date">{dayLabel(debt.openedOn)}</span>
            <span className="debt-entry-what">
              {debtTitle(debt)}
              {!debt.settled && debt.paid > 0 && (
                <em>{`${money(debt.paid)} of ${money(debt.principal)} back`}</em>
              )}
            </span>
            <span className={`debt-entry-tag is-${debt.settled ? 'back' : 'out'}`}>
              {debt.settled ? 'Settled' : lent ? 'Owed' : 'Owing'}
            </span>
            <span className="debt-entry-amount">
              {money(debt.settled ? debt.principal : debt.outstanding)}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );

  return (
    <div className="screen" style={{ ['--tint' as any]: lent ? 'var(--green)' : 'var(--amber)' }}>
      <header className="screen-head detail-head">
        <div className="detail-id">
          <button className="detail-back" data-label="Debts" onClick={onBack} aria-label="Back to debts">
            <Icon name="chevron-left" size={17} />
          </button>
          <span className="debt-avatar">{initials(person.counterparty)}</span>
          <div>
            <h1>{person.counterparty}</h1>
            <p>
              {person.debts.length} {person.debts.length === 1 ? 'debt' : 'debts'}
              {` · since ${dayLabel(person.openedOn)}`}
              {!live && ' · settled'}
            </p>
          </div>
        </div>
        {live && (
          <div className="head-actions">
            <Button icon={addIcon} onClick={onAddMore}>{addMore}</Button>
            <Button tone="primary" icon="plus" onClick={onRecordPayment}>
              Repayment
            </Button>
          </div>
        )}
      </header>

      <Card className="detail-summary">
        <div className="detail-top">
          <div className="detail-hero-main">
            <span className="detail-label">
              {!live
                ? forgiven > 0
                  ? 'Forgiven'
                  : 'Repaid in full'
                : lent
                  ? 'Still owed to you'
                  : 'You still owe'}
            </span>
            <BigMoney
              value={live ? outstanding : forgiven > 0 ? forgiven : principal}
              className="hero-amount"
            />
            <p className="detail-hero-sub">
              {paid > 0
                ? `${money(paid)} of ${money(principal)} back`
                : `nothing repaid against ${money(principal)}`}
              {live && ` · across ${open.length} ${open.length === 1 ? 'debt' : 'debts'}`}
            </p>
          </div>
        </div>

        <div className="debt-bar detail-bar">
          <motion.span
            className="debt-bar-paid"
            initial={{ width: 0 }}
            animate={{ width: `${Math.min(100, bar.repaid)}%` }}
            transition={{ duration: 0.7, ease: [0.06, 0.94, 0.67, 1.01] }}
          />
          <motion.span
            className="debt-bar-forgiven"
            initial={{ width: 0 }}
            animate={{ width: `${Math.min(100, bar.forgiven)}%` }}
            transition={{ duration: 0.7, delay: 0.08, ease: [0.06, 0.94, 0.67, 1.01] }}
          />
        </div>
      </Card>

      {/* The bills themselves, each still its own debt: a share knows its
          bill, and opening one shows everything filed against it. */}
      <Card padded={false} className="detail-lots">
        <div className="card-pad">
          <CardHead
            title={live ? 'Open' : 'Debts'}
            hint={`${counted.length} ${counted.length === 1 ? 'debt' : 'debts'} · ${money(principal)} ${lent ? 'lent' : 'borrowed'}`}
          />
        </div>
        <div className="debt-entries is-listed">{debtRows(counted)}</div>
      </Card>

      {repayments.length > 0 && (
        <Card padded={false} className="detail-lots">
          <div className="card-pad">
            <CardHead
              title="Repayments"
              hint={`${repayments.length} · ${money(repayments.reduce((s, p) => s + p.amount, 0))} back`}
            />
          </div>
          <div className="debt-entries is-listed">
            <ul>
              {repayments.map((p) => (
                <li key={p.spreadId ?? p.id}>
                  <button onClick={() => onEditPayment(debtOf(p), p)}>
                    <span className="debt-entry-date">{dayLabel(p.occurredAt)}</span>
                    <span className="debt-entry-what">
                      {p.note ?? p.transactionLabel ?? 'Repayment'}
                      {!p.spreadId && <em>{debtTitle(debtOf(p))}</em>}
                    </span>
                    <span className="debt-entry-tag is-back">Repaid</span>
                    <span className="debt-entry-amount">{money(p.amount)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </Card>
      )}

      {live && settled.length > 0 && (
        <Card padded={false} className="detail-lots">
          <div className="card-pad">
            <CardHead
              title="Settled"
              hint={`${settled.length} ${settled.length === 1 ? 'debt' : 'debts'}`}
            />
          </div>
          <div className="debt-entries is-listed">{debtRows(settled)}</div>
        </Card>
      )}
    </div>
  );
}
