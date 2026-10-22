import { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { Icon } from '../components/Icon';
import { BigMoney } from '../components/Money';
import { Button, Card, CardHead, Confirm } from '../components/ui';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { dayLabel, debtProgress, initials, isShareOfBill, money } from '../lib/format';
import type { Debt, DebtAddition, DebtPayment, Transaction } from '../lib/types';

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
  debt, onBack, onEdit, onRecordPayment, onEditPayment, onAddMore, onEditAddition,
  onOpenTransaction,
}: {
  debt: Debt;
  onBack: () => void;
  onEdit: () => void;
  onRecordPayment: () => void;
  /** Opens one of the repayments to change or remove it. */
  onEditPayment: (payment: DebtPayment) => void;
  /** More handed over on top of what is already owed. */
  onAddMore: () => void;
  /** Opens one of the additions to change or remove it. */
  onEditAddition: (addition: DebtAddition) => void;
  onOpenTransaction: (tx: Transaction) => void;
}) {
  const { revision, deleteDebt, saveDebt } = useStore();
  const [entries, setEntries] = useState<Transaction[] | null>(null);
  // Getting rid of the debt belongs where the debt is, beside the way in to
  // changing it — not buried at the foot of the form for editing it.
  const [confirming, setConfirming] = useState(false);
  // Closing a debt nobody is going to settle. It is the same flag as settling
  // one, read differently: what is left unpaid becomes what was given up.
  const [forgiving, setForgiving] = useState(false);

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
  const share = isShareOfBill(debt);

  // A repayment and the posting that made it are one thing, not two: the row
  // stands for the repayment, and the posting behind it is a click away
  // inside. An addition is the same, the other way round. Everything else is
  // the money that was handed over in the first place — which is the whole of
  // a debt written over a run of hand-offs.
  const byTransaction = new Map(
    debt.payments.filter((p) => p.transactionId).map((p) => [p.transactionId!, p]),
  );
  const addedBy = new Map(
    debt.additions.filter((a) => a.transactionId).map((a) => [a.transactionId!, a]),
  );
  const handedOver = lent ? 'Lent' : 'Borrowed';
  const inLedger = (id: string | null) => !!id && (entries ?? []).some((tx) => tx.id === id);
  const rows = [
    ...(entries ?? []).map((tx) => {
      const payment = byTransaction.get(tx.id);
      const addition = addedBy.get(tx.id);
      return {
        key: tx.id,
        day: tx.occurredAt,
        amount: payment?.amount ?? addition?.amount ?? tx.amount,
        what: tx.merchant || tx.categoryName || 'Entry',
        detail: tx.note ?? undefined,
        tag: payment ? 'Repaid' : handedOver,
        tone: payment ? 'back' : 'out',
        open: () =>
          payment
            ? onEditPayment(payment)
            : addition
              ? onEditAddition(addition)
              : onOpenTransaction(tx),
      };
    }),
    // A repayment recorded on its own, with no posting behind it.
    ...debt.payments
      .filter((p) => !inLedger(p.transactionId))
      .map((p) => ({
        key: p.id,
        day: p.occurredAt,
        amount: p.amount,
        what: p.note ?? p.transactionLabel ?? 'Repayment',
        detail: undefined,
        tag: 'Repaid',
        tone: 'back' as const,
        open: () => onEditPayment(p),
      })),
    // And more handed over the same way, in cash or before the ledger began.
    ...debt.additions
      .filter((a) => !inLedger(a.transactionId))
      .map((a) => ({
        key: a.id,
        day: a.occurredAt,
        amount: a.amount,
        what: a.note ?? a.transactionLabel ?? (lent ? 'Lent more' : 'Borrowed more'),
        detail: undefined,
        tag: handedOver,
        tone: 'out' as const,
        open: () => onEditAddition(a),
      })),
  ].sort((a, b) => b.day.localeCompare(a.day));
  const overdue =
    !debt.settled && !!debt.dueOn && debt.dueOn < new Date().toISOString().slice(0, 10);
  // Only worth offering while something is still outstanding: a debt paid to
  // the last rupee has nothing left to forgive.
  const canForgive = !debt.settled && debt.outstanding > 0;
  // What deleting it takes with it, said in full.
  const recorded = [
    debt.payments.length &&
      `${debt.payments.length} ${debt.payments.length === 1 ? 'repayment' : 'repayments'}`,
    debt.additions.length &&
      `${debt.additions.length} ${debt.additions.length === 1 ? 'top-up' : 'top-ups'}`,
  ]
    .filter(Boolean)
    .join(' and ');
  const addMore = lent ? 'Lend more' : 'Borrow more';
  const addIcon = lent ? 'arrow-up-right' : 'arrow-down-left';

  const forgive = async () => {
    setForgiving(false);
    await saveDebt({
      id: debt.id,
      direction: debt.direction,
      counterparty: debt.counterparty,
      // What it opened at: the additions are their own rows, and stay so.
      principal: debt.opening,
      openedOn: debt.openedOn,
      dueOn: debt.dueOn,
      note: debt.note,
      transactionId: debt.transactionId,
      settled: true,
    });
  };

  return (
    <div className="screen" style={{ ['--tint' as any]: lent ? 'var(--green)' : 'var(--amber)' }}>
      <Confirm
        open={confirming}
        title="Delete this debt?"
        onConfirm={async () => {
          setConfirming(false);
          await deleteDebt(debt.id);
          onBack();
        }}
        onCancel={() => setConfirming(false)}
      >
        {recorded
          ? `${money(debt.principal)} with ${debt.counterparty}, and the ${recorded} against it. The transactions in your ledger stay. This cannot be undone.`
          : `${money(debt.principal)} with ${debt.counterparty}. The transactions in your ledger stay. This cannot be undone.`}
      </Confirm>

      <Confirm
        open={forgiving}
        title={lent ? 'Forgive what is left?' : 'Write off what is left?'}
        confirmLabel={lent ? 'Forgive' : 'Write it off'}
        icon="heart-handshake"
        tone="primary"
        onConfirm={forgive}
        onCancel={() => setForgiving(false)}
      >
        {lent
          ? `${money(debt.outstanding)} of ${money(debt.principal)} never came back. The debt closes with that much given up rather than repaid, and your ledger is left exactly as it is.`
          : `${money(debt.outstanding)} of ${money(debt.principal)} is no longer being asked of you. The debt closes with that much written off rather than repaid, and your ledger is left exactly as it is.`}
      </Confirm>

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
          <Button tone="ghost" icon="trash-2" onClick={() => setConfirming(true)}>
            Delete
          </Button>
          <Button icon="pencil" onClick={onEdit}>Edit</Button>
          {canForgive && (
            <Button icon="heart-handshake" onClick={() => setForgiving(true)}>
              {lent ? 'Forgive' : 'Write off'}
            </Button>
          )}
          {!debt.settled && (
            <Button icon={addIcon} onClick={onAddMore}>{addMore}</Button>
          )}
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
            {share && (
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
          <Figure
            label="Principal"
            value={money(debt.principal)}
            hint={
              debt.additions.length
                ? `${money(debt.opening)}, then ${debt.additions.length} more`
                : lent ? 'you handed over' : 'they handed over'
            }
          />
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

      {/* One list, not two. Everything the debt is made of, in the order it
          happened, each row saying what it was — the money handed over, and
          the money that came back against it. */}
      <Card padded={false} className="detail-lots">
        <div className="card-pad">
          <CardHead
            title="Entries"
            hint={
              entries === null
                ? 'reading the ledger'
                : `${rows.length} ${rows.length === 1 ? 'entry' : 'entries'} · ${money(debt.principal)} out, ${money(debt.paid)} back`
            }
            action={
              debt.settled ? undefined : (
                <div className="head-actions">
                  <Button size="sm" icon={addIcon} onClick={onAddMore}>{addMore}</Button>
                  <Button size="sm" icon="plus" onClick={onRecordPayment}>Repayment</Button>
                </div>
              )
            }
          />
        </div>
        <div className="debt-entries is-listed">
          {entries === null ? (
            <p className="debt-entries-empty">Looking…</p>
          ) : rows.length === 0 ? (
            <p className="debt-entries-empty">
              Nothing in the ledger is filed against this one.
            </p>
          ) : (
            <ul>
              {rows.map((row) => (
                <li key={row.key}>
                  <button onClick={row.open}>
                    <span className="debt-entry-date">{dayLabel(row.day)}</span>
                    <span className="debt-entry-what">
                      {row.what}
                      {row.detail && <em>{row.detail}</em>}
                    </span>
                    <span className={`debt-entry-tag is-${row.tone}`}>{row.tag}</span>
                    <span className="debt-entry-amount">{money(row.amount)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>
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
