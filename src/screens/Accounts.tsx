import { useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Icon } from '../components/Icon';
import { Button, Card, Empty } from '../components/ui';
import { useStore } from '../lib/store';
import { accountWorth, money } from '../lib/format';
import { itemVariants, listVariants, spring } from '../lib/motion';
import type { Account } from '../lib/types';

const GROUPS: { kind: Account['kind']; label: string }[] = [
  { kind: 'bank', label: 'Bank accounts' },
  { kind: 'credit', label: 'Credit cards' },
  { kind: 'cash', label: 'Cash' },
  { kind: 'wallet', label: 'Wallets' },
  { kind: 'investment', label: 'Investments' },
];

const KIND_LABEL: Record<Account['kind'], string> = {
  bank: 'Bank',
  credit: 'Credit card',
  cash: 'Cash',
  wallet: 'Wallet',
  investment: 'Investment',
};

/**
 * Purely a management surface: what each account is, what it holds, and how to
 * change it. Activity lives on Transactions and Overview.
 */
export function Accounts({
  onEditAccount, onAddAccount,
}: {
  onEditAccount: (account: Account) => void;
  onAddAccount: () => void;
}) {
  const { accounts } = useStore();
  const [showArchived, setShowArchived] = useState(false);

  // The book's own account is not one of yours: every debt runs through it,
  // nothing about it is yours to set, and a row you cannot act on is a row
  // that only raises the question of why it is there.
  const mine = useMemo(() => accounts.filter((a) => !a.system), [accounts]);
  const live = useMemo(() => mine.filter((a) => !a.archived), [mine]);
  const archived = useMemo(() => mine.filter((a) => a.archived), [mine]);

  const netWorth = live.reduce((sum, a) => sum + accountWorth(a), 0);

  const grouped = GROUPS.map((group) => ({
    ...group,
    items: live.filter((a) => a.kind === group.kind),
  })).filter((g) => g.items.length);

  return (
    <div className="screen">
      <header className="screen-head">
        <div>
          <h1>Accounts</h1>
          <p>
            {live.length} active {live.length === 1 ? 'account' : 'accounts'} · net worth{' '}
            {money(netWorth)}
          </p>
        </div>
        <Button tone="primary" icon="plus" onClick={onAddAccount}>
          New account
        </Button>
      </header>

      {live.length === 0 ? (
        <Empty
          screen
          art="wallet"
          title="No accounts yet"
          body="A bank, a card, a wallet, a fund: wherever your money sits."
        />
      ) : (
        grouped.map((group) => (
          <section key={group.kind} className="account-group">
            <h2 className="group-title">
              {group.label}
              <span>{money(group.items.reduce((s, a) => s + accountWorth(a), 0))}</span>
            </h2>
            <Card padded={false} className="row-board">
              <motion.div
                className="account-list"
                variants={listVariants}
                initial="initial"
                animate="animate"
              >
                {group.items.map((account) => (
                  <AccountRow
                    key={account.id}
                    account={account}
                    onEdit={() => onEditAccount(account)}
                  />
                ))}
              </motion.div>
            </Card>
          </section>
        ))
      )}

      {archived.length > 0 && (
        <section className="account-group">
          <button className="archived-toggle" onClick={() => setShowArchived((s) => !s)}>
            <motion.span animate={{ rotate: showArchived ? 90 : 0 }} transition={spring}>
              <Icon name="chevron-right" size={15} />
            </motion.span>
            Archived · {archived.length}
          </button>
          <AnimatePresence initial={false}>
            {showArchived && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                transition={spring}
                style={{ overflow: 'hidden' }}
              >
                <Card padded={false} className="row-board">
                  {/* The same variant parent the live groups have: a row is
                      hidden until its list tells it to arrive, and a plain
                      div never does — which is why this card opened empty. */}
                  <motion.div
                    className="account-list"
                    variants={listVariants}
                    initial="initial"
                    animate="animate"
                  >
                    {archived.map((account) => (
                      <AccountRow
                        key={account.id}
                        account={account}
                        onEdit={() => onEditAccount(account)}
                      />
                    ))}
                  </motion.div>
                </Card>
              </motion.div>
            )}
          </AnimatePresence>
        </section>
      )}
    </div>
  );
}

/**
 * One line per account: what it is, what it holds, and a pencil to change it.
 * A card had room to shout the balance; a list would rather you could scan
 * twelve accounts at once.
 */
function AccountRow({ account, onEdit }: { account: Account; onEdit: () => void }) {
  const owed = account.kind === 'credit' && account.balance < 0;
  const limited = account.kind === 'credit' && account.creditLimit > 0;
  const utilisation = limited ? Math.max(0, -account.balance) / account.creditLimit : 0;
  // An account holding funds or metal is worth what they would fetch today,
  // which is a different number from the cash that went through it.
  const worth = accountWorth(account);

  // What is left on a card is the fact worth carrying; an account whose figure
  // came off a price rather than the ledger says where it came from; and
  // everywhere else the balance says it all on its own.
  const note = limited
    ? `${money(Math.max(0, account.creditLimit + account.balance))} left of ${money(account.creditLimit)}`
    : owed
      ? 'outstanding'
      : account.revaluation !== 0
        ? "at today's price"
        : null;

  const sub = [
    account.institution,
    KIND_LABEL[account.kind],
    account.archived ? 'archived' : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <motion.button
      type="button"
      className={`account-row ${account.archived ? 'is-archived' : ''}`}
      variants={itemVariants}
      whileTap={{ scale: 0.997 }}
      style={{ ['--tint' as any]: account.color }}
      onClick={onEdit}
    >
      <span className="account-glyph">
        <Icon name={account.icon} size={17} />
      </span>
      <span className="account-main">
        <span className="account-name">{account.name}</span>
        <span className="account-sub">{sub}</span>
      </span>
      <span className="account-right">
        <strong className={worth < 0 ? 'is-negative' : ''}>
          {money(Math.abs(worth))}
        </strong>
        {note && <span className={limited && utilisation > 0.7 ? 'is-high' : ''}>{note}</span>}
      </span>
      <span className="account-edit" aria-hidden>
        <Icon name="pencil" size={14} />
      </span>
    </motion.button>
  );
}
