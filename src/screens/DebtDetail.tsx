import { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { Icon } from '../components/Icon';
import { BigMoney } from '../components/Money';
import { Button, Card, CardHead, Empty } from '../components/ui';
import { useStore } from '../lib/store';
import { dayLabel, initials, money } from '../lib/format';
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
  const { listTransactions } = useStore();
  const [entries, setEntries] = useState<Transaction[] | null>(null);

  // Only some debts hold a link to a posting; the rest are joined to the
  // ledger by the one thing they share, which is the name on them.
  useEffect(() => {
    let live = true;
    setEntries(null);
    listTransactions({ search: debt.counterparty, limit: 200 })
      .then((rows) => live && setEntries(rows))
      .catch(() => live && setEntries([]));
    return () => {
      live = false;
    };
  }, [debt.counterparty, listTransactions]);

  const lent = debt.direction === 'lent';
  const progress = debt.principal ? debt.paid / debt.principal : 0;
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
              {debt.settled ? 'Was' : lent ? 'Still owed to you' : 'You still owe'}
            </span>
            <BigMoney value={debt.settled ? debt.principal : debt.outstanding} className="hero-amount" />
            <p className="detail-hero-sub">
              {debt.paid > 0
                ? `${money(debt.paid)} of ${money(debt.principal)} back`
                : `nothing repaid against ${money(debt.principal)}`}
              {debt.dueOn && ` · due ${dayLabel(debt.dueOn)}`}
            </p>
          </div>
          <div className="debt-tags">
            {debt.settled && <span className="debt-tag is-done">Settled</span>}
            {overdue && <span className="debt-tag is-late">Overdue</span>}
            {debt.fromSplit && (
              <span className="debt-tag is-link">
                <Icon name="split" size={11} />
                Share of {debt.transactionLabel ?? 'a split bill'}
              </span>
            )}
          </div>
        </div>

        <div className="debt-bar detail-bar">
          <motion.span
            initial={{ width: 0 }}
            animate={{ width: `${Math.min(100, progress * 100)}%` }}
            transition={{ duration: 0.7, ease: [0.06, 0.94, 0.67, 1.01] }}
          />
        </div>

        <div className="detail-figures">
          <Figure label="Principal" value={money(debt.principal)} hint={lent ? 'you handed over' : 'they handed over'} />
          <Figure label="Repaid" value={money(debt.paid)} hint={`${debt.payments.length} ${debt.payments.length === 1 ? 'payment' : 'payments'}`} />
          <Figure label="Outstanding" value={money(debt.outstanding)} hint={debt.settled ? 'settled either way' : 'still to come'} />
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
              hint={`everything naming ${debt.counterparty}${entries ? ` · ${entries.length}` : ''}`}
            />
          </div>
          <div className="debt-entries is-listed">
            {entries === null ? (
              <p className="debt-entries-empty">Looking…</p>
            ) : entries.length === 0 ? (
              <p className="debt-entries-empty">Nothing in the ledger says that name.</p>
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

function Figure({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="detail-figure">
      <span>{label}</span>
      <strong>{value}</strong>
      {hint && <small>{hint}</small>}
    </div>
  );
}
