import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { IconButton } from './ui';
import { Transactions } from '../screens/Transactions';
import { sheetBackdrop, stackedPanel } from '../lib/motion';
import type { Transaction } from '../lib/types';

/**
 * Picking a record to attach something to — a fund purchase, a repayment, a
 * run of payments against a plan — from the whole ledger rather than a
 * shortlist. It is the Transactions screen itself inside a modal, so the
 * search, the filters, the day headers and the date ranges are the ones
 * already learned rather than a cut-down copy of them that drifts.
 */
export function RecordPicker({
  open, onClose, onPick, onPickMany, pickLabel = 'Link', search, title, subtitle,
}: {
  open: boolean;
  onClose: () => void;
  /** Picking one, which is what attaching a repayment or a lot wants. */
  onPick?: (tx: Transaction) => void;
  /** Picking several — a run of past payments to hang on a plan. Given
   *  this, rows tick instead of choosing and the ledger's own selection
   *  does the work. */
  onPickMany?: (ids: string[]) => void;
  /** What the button over a multiple selection says. */
  pickLabel?: string;
  /** What the search box starts on, when the picker is opened about
   *  something in particular. */
  search?: string;
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

  // Through a portal, like every other layer that opens over a sheet. Left in
  // the sheet's own tree it is a fixed box inside a transformed, briefly
  // clipped ancestor: the panel is anchored to the sheet rather than to the
  // window, and the moment the sheet animates its own height the picker is
  // cut out of the page — which is what made closing it look like a
  // disappearance rather than an exit.
  return createPortal(
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
            variants={stackedPanel}
            initial="initial"
            animate="animate"
            exit="exit"
            role="dialog"
            aria-modal="true"
            aria-label={title}
          >
            <header className="sheet-head">
              {/* The heading takes the row, so the close button ends up where
                  every other sheet keeps it — hard right. */}
              <div className="sheet-heading">
                <h2 className="sheet-title">{title}</h2>
                {subtitle && <p className="sheet-sub">{subtitle}</p>}
              </div>
              <IconButton icon="x" label="Close" onClick={onClose} />
            </header>
            <div className="record-picker-body">
              <Transactions
                picking
                initialSearch={search}
                pickMany={
                  onPickMany ? { label: pickLabel, onConfirm: onPickMany } : undefined
                }
                onOpenTransaction={(tx) => onPick?.(tx)}
              />
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
