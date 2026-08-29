import { useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Icon } from '../components/Icon';
import { Button, Card, Empty } from '../components/ui';
import { useStore } from '../lib/store';
import { dayLabel, initials, money } from '../lib/format';
import { itemVariants, listVariants, spring } from '../lib/motion';
import type { Debt, DebtDirection } from '../lib/types';

export function Debts({
  onNewDebt, onEditDebt, onRecordPayment,
}: {
  onNewDebt: (direction: DebtDirection) => void;
  onEditDebt: (debt: Debt) => void;
  onRecordPayment: (debt: Debt) => void;
}) {
  const { debts } = useStore();
  const [showSettled, setShowSettled] = useState(false);

  const open = useMemo(() => debts.filter((d) => !d.settled), [debts]);
  const settled = useMemo(() => debts.filter((d) => d.settled), [debts]);

  const lent = open.filter((d) => d.direction === 'lent');
  const borrowed = open.filter((d) => d.direction === 'borrowed');
  const owedToYou = lent.reduce((s, d) => s + d.outstanding, 0);
  const youOwe = borrowed.reduce((s, d) => s + d.outstanding, 0);
  const net = owedToYou - youOwe;

  return (
    <div className="screen">
      <header className="screen-head">
        <div>
          <h1>Debts</h1>
          <p>
            {open.length
              ? `${open.length} open · net ${net >= 0 ? 'in your favour' : 'against you'} ${money(Math.abs(net))}`
              : 'Money you have lent out, and money you owe.'}
          </p>
        </div>
        <div className="head-actions">
          <Button icon="arrow-down-left" onClick={() => onNewDebt('borrowed')}>
            I borrowed
          </Button>
          <Button tone="primary" icon="arrow-up-right" onClick={() => onNewDebt('lent')}>
            I lent
          </Button>
        </div>
      </header>

      <div className="debt-summary">
        <div className="debt-total is-lent">
          <span>Owed to you</span>
          <strong>{money(owedToYou)}</strong>
          <small>{lent.length} {lent.length === 1 ? 'person' : 'debts'}</small>
        </div>
        <div className="debt-total is-borrowed">
          <span>You owe</span>
          <strong>{money(youOwe)}</strong>
          <small>{borrowed.length} {borrowed.length === 1 ? 'person' : 'debts'}</small>
        </div>
        <div className="debt-total">
          <span>Net position</span>
          <strong className={net >= 0 ? 'is-up' : 'is-down'}>
            {money(net, { sign: net > 0 })}
          </strong>
          <small>folded into your net worth</small>
        </div>
      </div>

      {open.length === 0 ? (
        <Card>
          <Empty
            icon="arrow-left-right"
            title="No debts tracked"
            body="Record money you have lent or borrowed. Link it to an existing transaction, or add it on its own if it predates your ledger."
            action={
              <div className="welcome-actions">
                <Button tone="primary" icon="arrow-up-right" onClick={() => onNewDebt('lent')}>
                  I lent someone
                </Button>
                <Button icon="arrow-down-left" onClick={() => onNewDebt('borrowed')}>
                  I borrowed
                </Button>
              </div>
            }
          />
        </Card>
      ) : (
        <>
          <DebtGroup
            title="Money you lent"
            hint="they owe you"
            debts={lent}
            onEditDebt={onEditDebt}
            onRecordPayment={onRecordPayment}
          />
          <DebtGroup
            title="Money you borrowed"
            hint="you owe them"
            debts={borrowed}
            onEditDebt={onEditDebt}
            onRecordPayment={onRecordPayment}
          />
        </>
      )}

      {settled.length > 0 && (
        <section className="account-group">
          <button className="archived-toggle" onClick={() => setShowSettled((s) => !s)}>
            <motion.span animate={{ rotate: showSettled ? 90 : 0 }} transition={spring}>
              <Icon name="chevron-right" size={15} />
            </motion.span>
            Settled · {settled.length}
          </button>
          <AnimatePresence initial={false}>
            {showSettled && (
              <motion.div
                className="debt-grid"
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                transition={spring}
              >
                {settled.map((debt) => (
                  <DebtCard
                    key={debt.id}
                    debt={debt}
                    onEdit={() => onEditDebt(debt)}
                    onRecordPayment={() => onRecordPayment(debt)}
                  />
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        </section>
      )}
    </div>
  );
}

function DebtGroup({
  title, hint, debts, onEditDebt, onRecordPayment,
}: {
  title: string;
  hint: string;
  debts: Debt[];
  onEditDebt: (debt: Debt) => void;
  onRecordPayment: (debt: Debt) => void;
}) {
  if (!debts.length) return null;
  const total = debts.reduce((s, d) => s + d.outstanding, 0);
  return (
    <section className="account-group">
      <h2 className="group-title">
        {title}
        <span>{money(total)}</span>
        <em>{hint}</em>
      </h2>
      <motion.div
        className="debt-grid"
        variants={listVariants}
        initial="initial"
        animate="animate"
      >
        {debts.map((debt) => (
          <DebtCard
            key={debt.id}
            debt={debt}
            onEdit={() => onEditDebt(debt)}
            onRecordPayment={() => onRecordPayment(debt)}
          />
        ))}
      </motion.div>
    </section>
  );
}

function DebtCard({
  debt, onEdit, onRecordPayment,
}: { debt: Debt; onEdit: () => void; onRecordPayment: () => void }) {
  const [open, setOpen] = useState(false);
  const progress = debt.principal ? debt.paid / debt.principal : 0;
  const lent = debt.direction === 'lent';
  const overdue =
    !debt.settled && !!debt.dueOn && debt.dueOn < new Date().toISOString().slice(0, 10);

  return (
    <motion.article
      className={`debt-card ${debt.settled ? 'is-settled' : ''}`}
      variants={itemVariants}
      style={{ ['--tint' as any]: lent ? 'var(--green)' : 'var(--amber)' }}
    >
      <button className="debt-head" onClick={onEdit}>
        <span className="debt-avatar">{initials(debt.counterparty)}</span>
        <span className="debt-who">
          <strong>{debt.counterparty}</strong>
          <span>
            {lent ? 'Lent' : 'Borrowed'} {dayLabel(debt.openedOn)}
            {debt.note ? ` · ${debt.note}` : ''}
          </span>
        </span>
        <span className="debt-amount">
          <strong>{money(debt.outstanding)}</strong>
          <span>of {money(debt.principal)}</span>
        </span>
      </button>

      <div className="debt-bar">
        <motion.span
          initial={{ width: 0 }}
          animate={{ width: `${Math.min(100, progress * 100)}%` }}
          transition={{ duration: 0.7, ease: [0.06, 0.94, 0.67, 1.01] }}
        />
      </div>

      <div className="debt-meta">
        <span className="debt-tags">
          {debt.settled && <span className="debt-tag is-done">Settled</span>}
          {overdue && <span className="debt-tag is-late">Overdue</span>}
          {debt.dueOn && !debt.settled && !overdue && (
            <span className="debt-tag">Due {dayLabel(debt.dueOn)}</span>
          )}
          {debt.transactionId && (
            <span className="debt-tag is-link">
              <Icon name="arrow-left-right" size={11} />
              {debt.transactionLabel ?? 'Linked'}
            </span>
          )}
          {debt.payments.length > 0 && (
            <button className="debt-tag is-toggle" onClick={() => setOpen((o) => !o)}>
              <motion.span animate={{ rotate: open ? 90 : 0 }} transition={spring}>
                <Icon name="chevron-right" size={11} />
              </motion.span>
              {debt.payments.length} {debt.payments.length === 1 ? 'repayment' : 'repayments'}
            </button>
          )}
        </span>
        {!debt.settled && (
          <button className="debt-repay" onClick={onRecordPayment}>
            <Icon name="plus" size={13} strokeWidth={2.4} />
            Repayment
          </button>
        )}
      </div>

      <AnimatePresence initial={false}>
        {open && debt.payments.length > 0 && (
          <motion.ul
            className="debt-payments"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={spring}
          >
            {debt.payments.map((payment) => (
              <li key={payment.id}>
                <span className="debt-payment-date">{dayLabel(payment.occurredAt)}</span>
                <span className="debt-payment-note">
                  {payment.note ?? payment.transactionLabel ?? 'Repayment'}
                </span>
                <strong>{money(payment.amount)}</strong>
              </li>
            ))}
          </motion.ul>
        )}
      </AnimatePresence>
    </motion.article>
  );
}
