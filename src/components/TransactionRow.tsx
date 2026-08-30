import { useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Icon } from './Icon';
import { Amount } from './Money';
import { itemVariants, spring } from '../lib/motion';
import { initials, money, timeLabel } from '../lib/format';
import type { Transaction } from '../lib/types';

/** One posting. Transfers borrow the source account's colour; the rest use
 *  their category so the list scans by colour before it scans by text.
 *
 *  A split bill is still one posting and still one row: the parts it was cut
 *  into, and the people who owe some of it, unfold underneath rather than
 *  filling the ledger with entries the bank never saw. */
export function TransactionRow({
  tx, onClick, onSplit, onDebt, showDate, selected, onSelect,
}: {
  tx: Transaction;
  onClick?: () => void;
  /** Opens the split editor straight from the row. Left off while picking. */
  onSplit?: () => void;
  /** Turns the whole posting into a debt someone owes. Left off while picking. */
  onDebt?: () => void;
  showDate?: string;
  /** Whether this row is in the current selection. Absent means the list
   *  isn't selectable at all — inside the record picker, say. */
  selected?: boolean;
  /** Ticking the box. `range` is true when shift was held, which the ledger
   *  reads as "everything between the last one and this". */
  onSelect?: (range: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const isTransfer = tx.kind === 'transfer';
  const split = tx.splits.length > 0 || tx.shares.length > 0;
  const tint = isTransfer
    ? tx.accountColor
    : (tx.categoryColor ?? 'var(--ink-3)');
  const glyph = isTransfer
    ? 'arrow-left-right'
    : (tx.categoryIcon ?? (tx.kind === 'income' ? 'arrow-down-left' : 'circle-dashed'));

  // A split bill's own category is only one of several, so the parts name
  // themselves instead of it.
  const subtitle = isTransfer
    ? `${tx.accountName} → ${tx.toAccountName ?? '—'}`
    : tx.splits.length
      ? [`${tx.splits.length} parts`, tx.accountName].filter(Boolean).join(' · ')
      : [tx.categoryName, tx.accountName].filter(Boolean).join(' · ');

  const owed = tx.shares.reduce((sum, s) => sum + s.outstanding, 0);
  const lent = tx.shares[0]?.direction === 'lent';

  return (
    <motion.div
      className={`tx-bill ${open ? 'is-open' : ''} ${selected ? 'is-picked' : ''}`}
      layout="position"
    >
      {/* The box takes the avatar's place rather than sitting beside it: the
          row keeps its shape whether or not anything is being picked out. */}
      {onSelect && (
        <button
          type="button"
          className={`tx-check ${selected ? 'is-on' : ''}`}
          aria-pressed={selected}
          aria-label={selected ? 'Deselect' : 'Select'}
          onClick={(e) => onSelect(e.shiftKey)}
        >
          <Icon name="check" size={13} strokeWidth={3} />
        </button>
      )}
      <motion.button
        type="button"
        variants={itemVariants}
        className="tx-row"
        onClick={onClick}
        whileTap={{ scale: 0.995 }}
      >
        <span className="tx-avatar" style={{ ['--tint' as any]: tint }}>
          <Icon name={glyph} size={17} strokeWidth={2.05} />
        </span>
        <span className="tx-main">
          <span className="tx-title">
            {tx.merchant || (isTransfer ? 'Transfer' : (tx.categoryName ?? 'Uncategorised'))}
          </span>
          <span className="tx-sub">{subtitle}</span>
        </span>
        {tx.note && (
          <span className="tx-note" title={tx.note}>
            {tx.note}
          </span>
        )}
        <span className="tx-right">
          <Amount value={tx.amount} kind={tx.kind} />
          <span className="tx-time">{showDate ?? timeLabel(tx.occurredAt)}</span>
        </span>
        <span className="tx-chevron">
          <Icon name="chevron-right" size={16} />
        </span>
      </motion.button>

      {/* A transfer moves money between your own accounts: there is nobody to
          owe any of it and nothing to file it under twice. */}
      {!isTransfer && (onSplit || onDebt) && (
        <div className="tx-row-actions">
          {onDebt && (
            <button
              type="button"
              className="tx-split-action"
              title="Make the whole of this a debt in someone's name"
              onClick={onDebt}
            >
              <Icon name="user-round" size={14} strokeWidth={2.1} />
              Debt
            </button>
          )}
          {onSplit && (
            <button type="button" className="tx-split-action" onClick={onSplit}>
              <Icon name="split" size={14} strokeWidth={2.1} />
              Split
            </button>
          )}
        </div>
      )}

      {split && (
        <>
          <button type="button" className="tx-bill-strip" onClick={() => setOpen((o) => !o)}>
            <motion.span animate={{ rotate: open ? 90 : 0 }} transition={spring}>
              <Icon name="chevron-right" size={13} />
            </motion.span>
            {tx.splits.length > 0 && (
              <span className="tx-bill-count">
                {tx.splits.length} {tx.splits.length === 1 ? 'part' : 'parts'}
              </span>
            )}
            {tx.shares.length > 0 && (
              <span className={`tx-bill-owed ${lent ? 'is-lent' : 'is-borrowed'}`}>
                <Icon name="users" size={12} />
                {tx.shares.map((s) => s.counterparty).join(', ')}
                {owed > 0 && <em>{money(owed)} {lent ? 'owed to you' : 'you owe'}</em>}
              </span>
            )}
          </button>

          <AnimatePresence initial={false}>
            {open && (
              <motion.div
                className="tx-parts"
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                transition={spring}
              >
                <div className="tx-parts-inner">
                  {tx.splits.map((part) => (
                    <div key={part.id} className="tx-part">
                      <span
                        className="tx-part-dot"
                        style={{ ['--tint' as any]: part.categoryColor ?? 'var(--ink-4)' }}
                      >
                        <Icon name={part.categoryIcon ?? 'circle-dashed'} size={12} strokeWidth={2.2} />
                      </span>
                      <span className="tx-part-name">
                        {part.categoryName ?? 'Uncategorised'}
                        {part.categoryGroupName && part.categoryGroupName !== part.categoryName && (
                          <em>{part.categoryGroupName}</em>
                        )}
                      </span>
                      {part.note && <span className="tx-part-note">{part.note}</span>}
                      <span className="tx-part-amount">{money(part.amount)}</span>
                    </div>
                  ))}
                  {tx.shares.map((share) => (
                    <div key={share.debtId} className="tx-part is-share">
                      <span className="tx-part-mark">{initials(share.counterparty)}</span>
                      <span className="tx-part-name">
                        {share.counterparty}
                        <em>
                          {share.settled
                            ? 'settled'
                            : share.paid > 0
                              ? `${money(share.paid)} repaid`
                              : share.direction === 'lent'
                                ? 'owes you'
                                : 'you owe'}
                        </em>
                      </span>
                      <span className="tx-part-amount">{money(share.amount)}</span>
                    </div>
                  ))}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </>
      )}
    </motion.div>
  );
}
