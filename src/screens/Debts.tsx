import { useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Icon } from '../components/Icon';
import { Button, Card, Empty, Segmented, type SegmentOption } from '../components/ui';
import { useStore } from '../lib/store';
import { DebtDetail } from './DebtDetail';
import { dayLabel, debtProgress, initials, isShareOfBill, money } from '../lib/format';
import { itemVariants, listVariants, spring } from '../lib/motion';
import type { Debt, DebtDirection, DebtPayment, Transaction } from '../lib/types';

/** Which side of the ledger you are looking at. What is done with is not a
 *  third place to look — it is folded under the side it happened on. */
type DebtTab = DebtDirection;

export function Debts({
  onNewDebt, onEditDebt, onRecordPayment, onEditPayment, onOpenTransaction,
}: {
  onNewDebt: (direction: DebtDirection) => void;
  onEditDebt: (debt: Debt) => void;
  onRecordPayment: (debt: Debt) => void;
  /** Opens one of a debt's repayments to change or remove it. */
  onEditPayment: (debt: Debt, payment: DebtPayment) => void;
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

  // Two sides, two tabs. What is done with is not a third place to look: it
  // belongs to the side it happened on, folded away under it.
  const tabs: SegmentOption<DebtTab>[] = [
    {
      value: 'lent',
      label: `Lent${lent.length ? ` · ${lent.length}` : ''}`,
      icon: 'arrow-up-right',
      accent: 'var(--green)',
    },
    {
      value: 'borrowed',
      label: `Borrowed${borrowed.length ? ` · ${borrowed.length}` : ''}`,
      icon: 'arrow-down-left',
      accent: 'var(--amber)',
    },
  ];
  const showing = tab === 'lent' ? lent : borrowed;
  const past = settled.filter((d) => d.direction === tab);

  const viewing = openId ? debts.find((d) => d.id === openId) ?? null : null;
  if (viewing) {
    return (
      <DebtDetail
        debt={viewing}
        onBack={() => setOpenId(null)}
        onEdit={() => onEditDebt(viewing)}
        onRecordPayment={() => onRecordPayment(viewing)}
        onEditPayment={(payment) => onEditPayment(viewing, payment)}
        onOpenTransaction={onOpenTransaction}
      />
    );
  }

  return (
    <div className="screen debt-screen">
      <header className="screen-head">
        <div>
          <h1>Debts</h1>
          {/* The two figures, in a line. They used to want a card apiece. */}
          <p>
            {open.length
              ? `${money(owedToYou)} owed to you · ${money(youOwe)} you owe`
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
                    icon="arrow-left-right"
                    title={
                      tab === 'lent'
                        ? 'Nobody owes you anything'
                        : 'You owe nobody anything'
                    }
                    body="Record one and it will stand here until it is squared up."
                    action={
                      <Button
                        tone="primary"
                        icon={tab === 'lent' ? 'arrow-up-right' : 'arrow-down-left'}
                        onClick={() => onNewDebt(tab)}
                      >
                        {tab === 'lent' ? 'I lent someone' : 'I borrowed'}
                      </Button>
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

              {/* What is done with, on the side it happened on. Shut, because
                  a debt that is squared up is a debt you have stopped
                  thinking about — but there, because it is the only place the
                  history of this side can be read. */}
              <SettledSection
                debts={past}
                onOpen={setOpenId}
                onRecordPayment={onRecordPayment}
              />
            </motion.div>
          </AnimatePresence>
        </>
      )}
    </div>
  );
}

/**
 * The side's own history, folded away. What it all came to, how much was let
 * go, and the debts themselves — opened only when somebody asks for them.
 */
function SettledSection({
  debts, onOpen, onRecordPayment,
}: {
  debts: Debt[];
  onOpen: (id: string) => void;
  onRecordPayment: (debt: Debt) => void;
}) {
  const [open, setOpen] = useState(false);

  if (!debts.length) return null;
  const principal = debts.reduce((sum, d) => sum + d.principal, 0);
  const forgiven = debts.reduce((sum, d) => sum + debtProgress(d).forgivenAmount, 0);

  return (
    <>
      {/* The empty page between the list and the fold, held as a flex item of
          its own rather than as an auto margin. Shut, it takes whatever space
          is going and holds the fold at the foot of the screen; opening winds
          it back to nothing, which walks the row up to the end of the list
          above. The negative margin pays back the column's own gap, so a
          spacer at no height leaves no trace of itself. */}
      <motion.div
        className="debt-past-gap"
        initial={false}
        animate={{ flexGrow: open ? 0 : 1 }}
        transition={{ duration: 0.42, ease: [0.22, 1, 0.36, 1] }}
        aria-hidden
      />

      <section className="debt-past">
        <button
          type="button"
          className={`debt-past-head ${open ? 'is-open' : ''}`}
          onClick={() => setOpen((was) => !was)}
          aria-expanded={open}
        >
          <motion.span animate={{ rotate: open ? 90 : 0 }} transition={spring}>
            <Icon name="chevron-right" size={15} />
          </motion.span>
          <strong>Settled</strong>
          <span className="debt-past-count">
            {debts.length} {debts.length === 1 ? 'debt' : 'debts'}
          </span>
          <em>
            {money(principal)}
            {forgiven > 0 ? ` · ${money(forgiven)} forgiven` : ' · all of it back'}
          </em>
        </button>

        <motion.div
          className="debt-past-body"
          initial={false}
          // The list is in the page either way, so `auto` is a height that
          // can actually be measured when the fold is asked to open.
          animate={{ height: open ? 'auto' : 0 }}
          transition={{ duration: 0.42, ease: [0.22, 1, 0.36, 1] }}
          // Shut, it is still in the page: nothing inside it should answer a
          // Tab or be read out to anyone.
          aria-hidden={!open}
          inert={!open}
        >
          <div className="debt-past-inner">
            {/* Each card is told when to arrive rather than inheriting it
                from the list: these ones are mounted the whole time, and a
                variant handed down a tree that never remounts is a variant
                nothing acts on. */}
            <div className="debt-grid">
              {debts.map((debt, i) => (
                <DebtCard
                  key={debt.id}
                  debt={debt}
                  reveal={open}
                  delay={0.08 + i * 0.05}
                  onOpen={() => onOpen(debt.id)}
                  onRecordPayment={() => onRecordPayment(debt)}
                />
              ))}
            </div>
          </div>
        </motion.div>
      </section>
    </>
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
  debt, onOpen, onRecordPayment, reveal, delay = 0,
}: {
  debt: Debt;
  onOpen: () => void;
  onRecordPayment: () => void;
  /** Set inside a fold, which says when the card is on show. Left off in a
   *  plain list, where the list itself brings its cards in. */
  reveal?: boolean;
  delay?: number;
}) {
  const bar = debtProgress(debt);
  const lent = debt.direction === 'lent';
  const share = isShareOfBill(debt);
  const overdue =
    !debt.settled && !!debt.dueOn && debt.dueOn < new Date().toISOString().slice(0, 10);

  return (
    <motion.article
      className={`debt-card ${debt.settled ? 'is-settled' : ''}`}
      {...(reveal === undefined
        ? { variants: itemVariants }
        : {
            initial: false,
            animate: reveal ? { opacity: 1, y: 0 } : { opacity: 0, y: 12 },
            transition: {
              duration: 0.34,
              delay: reveal ? delay : 0,
              ease: [0.22, 1, 0.36, 1] as const,
            },
          })}
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
              <Icon name={share ? 'split' : 'arrow-left-right'} size={11} />
              {share
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
