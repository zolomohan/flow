import { useEffect } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { IconButton } from './ui';
import { Transactions } from '../screens/Transactions';
import { sheetBackdrop, sheetPanel } from '../lib/motion';
import type { Transaction } from '../lib/types';

/**
 * Picking a record to attach something to — a fund purchase, a repayment —
 * against the whole ledger rather than a shortlist. It is the Transactions
 * screen itself inside a modal, so the search, filters and date ranges are the
 * ones already learned rather than a cut-down copy of them.
 */
export function RecordPicker({
  open, onClose, onPick, title, subtitle,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (tx: Transaction) => void;
  title: string;
  subtitle?: string;
}) {
  useEffect(() => {
    if (!open) return;
    // Captured, so Escape closes this and stops there. The sheet underneath
    // listens on the same document and would otherwise close along with it.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="scrim is-stacked"
          variants={sheetBackdrop}
          initial="initial"
          animate="animate"
          exit="exit"
          onMouseDown={(e) => e.target === e.currentTarget && onClose()}
        >
          <motion.div
            className="sheet record-picker"
            variants={sheetPanel}
            initial="initial"
            animate="animate"
            exit="exit"
            role="dialog"
            aria-modal="true"
            aria-label={title}
          >
            <header className="sheet-head">
              <div>
                <h2 className="sheet-title">{title}</h2>
                {subtitle && <p className="sheet-sub">{subtitle}</p>}
              </div>
              <IconButton icon="x" label="Close" onClick={onClose} />
            </header>
            <div className="record-picker-body">
              <Transactions picking onOpenTransaction={onPick} />
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
