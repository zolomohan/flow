import { useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Icon } from '../components/Icon';
import { Button, Card, Empty, Segmented, type SegmentOption } from '../components/ui';
import { useStore } from '../lib/store';
import { DebtDetail } from './DebtDetail';
import { dayLabel, debtProgress, initials, money } from '../lib/format';
import { itemVariants, listVariants } from '../lib/motion';
import type { Debt, DebtDirection, Transaction } from '../lib/types';

/** Who owes whom, and what is done with. */
type DebtTab = 'lent' | 'borrowed' | 'past';

export function Debts({
  onNewDebt, onEditDebt, onRecordPayment, onOpenTransaction,
}: {
  onNewDebt: (direction: DebtDirection) => void;
  onEditDebt: (debt: Debt) => void;
  onRecordPayment: (debt: Debt) => void;
  /** Opens one of the entries behind a debt, from the debt itself. */
  onOpenTransaction: (tx: Transaction) => void;
}) {
  const { debts } = useStore();
  // Held by id, not by object: the store hands back fresh debts after every
  // write, and the open page should follow them.
  const [openId, setOpenId] = useState<string | null>(null);

  const open = useMemo(() => debts.filter((d) => !d.settled), [debts]);
  // Newest first: what was squared up last week is worth more than what was
  // squared up in 2021.
  const settled = useMemo(
    () =>
      debts
        .filter((d) => d.settled)
        .sort((a, b) => (b.settledAt ?? b.openedOn).localeCompare(a.settledAt ?? a.openedOn)),
    [debts],
  );
  const [tab, setTab] = useState<DebtTab>('lent');
  const lent = open.filter((d) => d.direction === 'lent');
  const borrowed = open.filter((d) => d.direction === 'borrowed');
  const owedToYou = lent.reduce((s, d) => s + d.outstanding, 0);
  const youOwe = borrowed.reduce((s, d) => s + d.outstanding, 0);
  const net = owedToYou - youOwe;

  // Three ways of asking the same question — who owes whom, and what is done
  // with. Each is its own list rather than three stacked down one page.
  const tabs: SegmentOption<DebtTab>[] = [
    {
      value: 'lent',
      label: `Owed to you${lent.length ? ` · ${lent.length}` : ''}`,
      icon: 'arrow-up-right',
      accent: 'var(--green)',
    },
    {
      value: 'borrowed',
      label: `You owe${borrowed.length ? ` · ${borrowed.length}` : ''}`,
      icon: 'arrow-down-left',
      accent: 'var(--amber)',
    },
    {
      value: 'past',
      label: `Past${settled.length ? ` · ${settled.length}` : ''}`,
      icon: 'check',
    },
  ];
  const showing = tab === 'lent' ? lent : tab === 'borrowed' ? borrowed : settled;

  const viewing = openId ? debts.find((d) => d.id === openId) ?? null : null;
  if (viewing) {
    return (
      <DebtDetail
        debt={viewing}
        onBack={() => setOpenId(null)}
        onEdit={() => onEditDebt(viewing)}
        onRecordPayment={() => onRecordPayment(viewing)}
        onOpenTransaction={onOpenTransaction}
      />
    );
  }

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

      {debts.length === 0 ? (
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
          <div className="screen-tabs">
            <Segmented options={tabs} value={tab} onChange={setTab} name="debt-tab" />
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
              {showing.length === 0 ? (
                <Card>
                  <Empty
                    icon={tab === 'past' ? 'check' : 'arrow-left-right'}
                    title={
                      tab === 'lent'
                        ? 'Nobody owes you anything'
                        : tab === 'borrowed'
                          ? 'You owe nobody anything'
                          : 'Nothing settled yet'
                    }
                    body={
                      tab === 'past'
                        ? 'A debt lands here once it has been repaid in full, or written off.'
                        : 'Record one and it will stand here until it is squared up.'
                    }
                    action={
                      tab === 'past' ? undefined : (
                        <Button
                          tone="primary"
                          icon={tab === 'lent' ? 'arrow-up-right' : 'arrow-down-left'}
                          onClick={() => onNewDebt(tab === 'lent' ? 'lent' : 'borrowed')}
                        >
                          {tab === 'lent' ? 'I lent someone' : 'I borrowed'}
                        </Button>
                      )
                    }
                  />
                </Card>
              ) : (
                <motion.div
                  className="debt-grid"
                  variants={listVariants}
                  initial="initial"
                  animate="animate"
                >
                  {showing.map((debt) => (
                    <DebtCard
                      key={debt.id}
                      debt={debt}
                      onOpen={() => setOpenId(debt.id)}
                      onRecordPayment={() => onRecordPayment(debt)}
                    />
                  ))}
                </motion.div>
              )}
            </motion.div>
          </AnimatePresence>
        </>
      )}
    </div>
  );
}

/**
 * What came back, and what was let go. A settled debt fills the bar either
 * way — the red is the part of it nobody paid.
 */
function DebtBar({ bar }: { bar: ReturnType<typeof debtProgress> }) {
  return (
    <div className="debt-bar">
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
  );
}

function DebtCard({
  debt, onOpen, onRecordPayment,
}: { debt: Debt; onOpen: () => void; onRecordPayment: () => void }) {
  const bar = debtProgress(debt);
  const lent = debt.direction === 'lent';
  const overdue =
    !debt.settled && !!debt.dueOn && debt.dueOn < new Date().toISOString().slice(0, 10);

  return (
    <motion.article
      className={`debt-card ${debt.settled ? 'is-settled' : ''}`}
      variants={itemVariants}
      style={{ ['--tint' as any]: lent ? 'var(--green)' : 'var(--amber)' }}
    >
      {/* The card says where it stands; the page behind it says how it got
          there — the repayments, and everything in the ledger naming them. */}
      <button className="debt-head" onClick={onOpen}>
        <span className="debt-avatar">{initials(debt.counterparty)}</span>
        <span className="debt-who">
          <strong>{debt.counterparty}</strong>
          <span>
            {lent ? 'Lent' : 'Borrowed'} {dayLabel(debt.openedOn)}
            {debt.note ? ` · ${debt.note}` : ''}
          </span>
        </span>
        <span className="debt-amount">
          <strong>{money(debt.settled ? debt.principal : debt.outstanding)}</strong>
          <span>
            {debt.settled
              ? bar.forgivenAmount > 0
                ? `${money(bar.forgivenAmount)} forgiven`
                : 'repaid in full'
              : `of ${money(debt.principal)}`}
          </span>
        </span>
      </button>

      <DebtBar bar={bar} />

      <div className="debt-meta">
        <span className="debt-tags">
          {debt.settled && (
            <span className={`debt-tag ${bar.forgivenAmount > 0 ? 'is-forgiven' : 'is-done'}`}>
              {bar.forgivenAmount > 0 ? 'Forgiven' : 'Settled'}
            </span>
          )}
          {overdue && <span className="debt-tag is-late">Overdue</span>}
          {debt.dueOn && !debt.settled && !overdue && (
            <span className="debt-tag">Due {dayLabel(debt.dueOn)}</span>
          )}
          {debt.payments.length > 0 && (
            <span className="debt-tag">
              {debt.payments.length} {debt.payments.length === 1 ? 'repayment' : 'repayments'}
            </span>
          )}
          {debt.transactionId && (
            <span className="debt-tag is-link">
              <Icon name={debt.fromSplit ? 'split' : 'arrow-left-right'} size={11} />
              {debt.fromSplit
                ? `Share of ${debt.transactionLabel ?? 'a split bill'}`
                : (debt.transactionLabel ?? 'Linked')}
            </span>
          )}
        </span>
        {!debt.settled && (
          <button className="debt-repay" onClick={onRecordPayment}>
            <Icon name="plus" size={13} strokeWidth={2.4} />
            Repayment
          </button>
        )}
      </div>
    </motion.article>
  );
}
