import { motion } from 'motion/react';
import { Icon } from './Icon';
import { Amount } from './Money';
import { itemVariants } from '../lib/motion';
import { timeLabel } from '../lib/format';
import type { Transaction } from '../lib/types';

/** One posting. Transfers borrow the source account's colour; the rest use
 *  their category so the list scans by colour before it scans by text. */
export function TransactionRow({
  tx, onClick, showDate,
}: { tx: Transaction; onClick?: () => void; showDate?: string }) {
  const isTransfer = tx.kind === 'transfer';
  const tint = isTransfer
    ? tx.accountColor
    : (tx.categoryColor ?? 'var(--ink-3)');
  const glyph = isTransfer
    ? 'arrow-left-right'
    : (tx.categoryIcon ?? (tx.kind === 'income' ? 'arrow-down-left' : 'circle-dashed'));

  const subtitle = isTransfer
    ? `${tx.accountName} → ${tx.toAccountName ?? '—'}`
    : [tx.categoryName, tx.accountName].filter(Boolean).join(' · ');

  return (
    <motion.button
      type="button"
      layout="position"
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
  );
}
