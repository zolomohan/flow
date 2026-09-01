import { useState } from 'react';
import { Icon } from './Icon';
import { RecordPicker } from './RecordPicker';
import type { Transaction } from '../lib/types';

/**
 * Attaches an existing posting to something — a debt, a repayment, a fund
 * purchase. Choosing one opens the full ledger rather than a shortlist, since
 * the record wanted is usually months back and needs finding, not scrolling.
 */
export function TransactionPicker({
  value, label, onChange, onOpen, title = 'Link an existing record', subtitle,
  browseLabel = 'Browse your transactions',
}: {
  value: string | null;
  label: string | null;
  /** The posting itself comes along, so a form can prefill from it. */
  onChange: (id: string | null, label: string | null, tx?: Transaction) => void;
  /** Opens the linked posting itself, when there is somewhere to open it. */
  onOpen?: (id: string) => void;
  title?: string;
  subtitle?: string;
  /** What the button says before anything is linked, where "browse" is not
   *  the point of it — a refund is asking which posting, not for a look
   *  around the ledger. */
  browseLabel?: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      {value ? (
        <div className="link-chip">
          <Icon name="arrow-left-right" size={14} />
          <span>{label ?? 'Linked record'}</span>
          {onOpen && (
            <button type="button" className="link-change" onClick={() => onOpen(value)}>
              Open
            </button>
          )}
          <button type="button" className="link-change" onClick={() => setOpen(true)}>
            Change
          </button>
          <button type="button" onClick={() => onChange(null, null)} aria-label="Unlink">
            <Icon name="x" size={13} />
          </button>
        </div>
      ) : (
        <button type="button" className="link-add" onClick={() => setOpen(true)}>
          <Icon name="search" size={14} />
          {browseLabel}
        </button>
      )}

      <RecordPicker
        open={open}
        onClose={() => setOpen(false)}
        title={title}
        subtitle={subtitle}
        onPick={(tx) => {
          onChange(tx.id, tx.merchant || tx.categoryName || 'Transaction', tx);
          setOpen(false);
        }}
      />
    </>
  );
}
