import { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { Icon } from '../components/Icon';
import { BigMoney } from '../components/Money';
import { Button, Card, CardHead, Empty } from '../components/ui';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { dayLabel, debtProgress, initials, money } from '../lib/format';
import { itemVariants, listVariants, spring } from '../lib/motion';
import type { Debt, Transaction } from '../lib/types';

/** Days between now and a date, said the way you would say it. */
function since(day: string) {
  const days = Math.floor((Date.now() - new Date(day).getTime()) / 86_400_000);
  if (days < 1) return 'today';
  if (days < 31) return `${days} ${days === 1 ? 'day' : 'days'} ago`;
  const months = Math.round(days / 30.44);
  if (months < 24) return `${months} ${months === 1 ? 'month' : 'months'} ago`;
  return `${(days / 365.25).toFixed(1)} years ago`;
}

/**
 * One debt, whole: what is left of it, what has come back, and everything in
 * the ledger that named the person — which for a debt written against years
 * of hand-offs is the only place the money itself can be read.
 */
export function DebtDetail({
  debt, onBack, onEdit, onRecordPayment, onOpenTransaction,
}: {
  debt: Debt;
  onBack: () => void;
  onEdit: () => void;
  onRecordPayment: () => void;
  onOpenTransaction: (tx: Transaction) => void;
}) {
  const { revision } = useStore();
  const [entries, setEntries] = useState<Transaction[] | null>(null);

  // What the debt is actually made of — the posting that opened it, the ones
  // that repaid it, and whatever else was filed against it. Asked for by the
  // link rather than by the name on them, which found a funeral and a plate
  // of momos looking for a mother.
  useEffect(() => {
    let live = true;
    setEntries(null);
    api
      .debtEntries(debt.id)
      .then((rows) => live && setEntries(rows))
      .catch(() => live && setEntries([]));
    return () => {
      live = false;
    };
  }, [debt.id, revision]);

  const lent = debt.direction === 'lent';
  const bar = debtProgress(debt);
  const overdue =
    !debt.settled && !!debt.dueOn && debt.dueOn < new Date().toISOString().slice(0, 10);

  return (
    <div className="screen" style={{ ['--tint' as any]: lent ? 'var(--green)' : 'var(--amber)' }}>
      <header className="screen-head detail-head">
        <div className="detail-id">
          <button className="detail-back" onClick={onBack} aria-label="Back to debts">
            <Icon name="chevron-left" size={17} />
          </button>
          <span className="debt-avatar">{initials(debt.counterparty)}</span>
          <div>
            <h1>{debt.counterparty}</h1>
            <p>
              {lent ? 'Lent' : 'Borrowed'} {dayLabel(debt.openedOn)} · {since(debt.openedOn)}
              {debt.settled && ' · settled'}
            </p>
          </div>
        </div>
        <div className="head-actions">
          <Button icon="pencil" onClick={onEdit}>Edit</Button>
          {!debt.settled && (
            <Button tone="primary" icon="plus" onClick={onRecordPayment}>
              Repayment
            </Button>
          )}
        </div>
      </header>

      <Card className="detail-summary">
        <div className="detail-top">
          <div className="detail-hero-main">
            <span className="detail-label">
              {debt.settled
                ? bar.forgivenAmount > 0
                  ? 'Forgiven'
                  : 'Repaid in full'
                : lent
                  ? 'Still owed to you'
                  : 'You still owe'}
            </span>
            <BigMoney
              value={
                debt.settled
                  ? bar.forgivenAmount > 0
                    ? bar.forgivenAmount
                    : debt.principal
                  : debt.outstanding
              }
              className="hero-amount"
            />
            <p className="detail-hero-sub">
              {debt.paid > 0
                ? `${money(debt.paid)} of ${money(debt.principal)} back`
                : `nothing repaid against ${money(debt.principal)}`}
              {debt.dueOn && ` · due ${dayLabel(debt.dueOn)}`}
            </p>
          </div>
          <div className="debt-tags">
            {debt.settled && (
              <span className={`debt-tag ${bar.forgivenAmount > 0 ? 'is-forgiven' : 'is-done'}`}>
                {bar.forgivenAmount > 0 ? 'Forgiven' : 'Settled'}
              </span>
            )}
            {overdue && <span className="debt-tag is-late">Overdue</span>}
            {debt.fromSplit && (
              <span className="debt-tag is-link">
                <Icon name="split" size={11} />
                Share of {debt.transactionLabel ?? 'a split bill'}
              </span>
            )}
          </div>
        </div>

        {/* Settled fills it either way: the red is the part nobody paid. */}
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

        <div className="detail-figures">
          <Figure label="Principal" value={money(debt.principal)} hint={lent ? 'you handed over' : 'they handed over'} />
          <Figure label="Repaid" value={money(debt.paid)} hint={`${debt.payments.length} ${debt.payments.length === 1 ? 'payment' : 'payments'}`} />
          <Figure
            label={debt.settled ? 'Forgiven' : 'Outstanding'}
            value={money(debt.settled ? bar.forgivenAmount : debt.outstanding)}
            hint={debt.settled ? 'written off, not chased' : 'still to come'}
            tone={debt.settled && bar.forgivenAmount > 0 ? 'red' : undefined}
          />
          <Figure label="Opened" value={dayLabel(debt.openedOn)} hint={since(debt.openedOn)} />
        </div>

        {debt.note && <p className="detail-note">{debt.note}</p>}
      </Card>

      <div className="detail-grid">
        <Card padded={false} className="detail-lots">
          <div className="card-pad">
            <CardHead
              title="Repayments"
              hint={debt.paid > 0 ? `${money(debt.paid)} back so far` : 'nothing back yet'}
              action={
                debt.settled ? undefined : (
                  <Button size="sm" icon="plus" onClick={onRecordPayment}>Add</Button>
                )
              }
            />
          </div>
          {debt.payments.length === 0 ? (
            <div className="card-pad">
              <Empty
                icon="inbox"
                title="Nothing recorded against it"
                body="Record what comes back and this becomes the debt's own history."
              />
            </div>
          ) : (
            <motion.ul className="debt-payments is-listed" variants={listVariants} initial="initial" animate="animate">
              {debt.payments.map((payment) => (
                <motion.li key={payment.id} variants={itemVariants} transition={spring}>
                  <span className="debt-payment-date">{dayLabel(payment.occurredAt)}</span>
                  <span className="debt-payment-note">
                    {payment.note ?? payment.transactionLabel ?? 'Repayment'}
                  </span>
                  <strong>{money(payment.amount)}</strong>
                </motion.li>
              ))}
            </motion.ul>
          )}
        </Card>

        <Card padded={false} className="detail-lots">
          <div className="card-pad">
            <CardHead
              title="In the ledger"
              hint={`what it is made of${entries ? ` · ${entries.length}` : ''}`}
            />
          </div>
          <div className="debt-entries is-listed">
            {entries === null ? (
              <p className="debt-entries-empty">Looking…</p>
            ) : entries.length === 0 ? (
              <p className="debt-entries-empty">
                Nothing in the ledger is filed against this one.
              </p>
            ) : (
              <ul>
                {entries.map((tx) => (
                  <li key={tx.id}>
                    <button onClick={() => onOpenTransaction(tx)}>
                      <span className="debt-entry-date">{dayLabel(tx.occurredAt)}</span>
                      <span className="debt-entry-what">
                        {tx.merchant || tx.categoryName || 'Entry'}
                        {tx.note && <em>{tx.note}</em>}
                      </span>
                      <span className={`debt-entry-amount is-${tx.kind}`}>
                        {tx.kind === 'income' ? '+' : tx.kind === 'expense' ? '−' : ''}
                        {money(tx.amount)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}

function Figure({
  label, value, hint, tone,
}: { label: string; value: string; hint?: string; tone?: 'red' }) {
  return (
    <div className="detail-figure">
      <span>{label}</span>
      <strong className={tone === 'red' ? 'is-down' : undefined}>{value}</strong>
      {hint && <small>{hint}</small>}
    </div>
  );
}
