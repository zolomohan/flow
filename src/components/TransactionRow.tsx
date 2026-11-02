import { useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Icon } from './Icon';
import { MerchantLogo } from './MerchantLogo';
import { Amount } from './Money';
import { MoreMenu, type MenuItem } from './ui';
import { spring } from '../lib/motion';
import {
  effectiveAmount, initials, isCashbackCredit as paysOut, money, shortDayLabel, timeLabel,
} from '../lib/format';
import type { Paise, Transaction, TransactionSplit } from '../lib/types';

/** One posting. Transfers borrow the source account's colour; the rest use
 *  their category so the list scans by colour before it scans by text.
 *
 *  A split bill is still one posting and still one row: the parts it was cut
 *  into, and the people who owe some of it, unfold underneath rather than
 *  filling the ledger with entries the bank never saw. */
/**
 * The parts of a bill folded by what they were filed under.
 *
 * Two lines under one category are one answer to "how was this split", and a
 * strip that says "Coffee, Coffee" says less than "Coffee ₹150" does. The
 * parts stay whole inside: each carries a note of its own, and reading those
 * is what opening the row is for.
 */
function byCategory(splits: TransactionSplit[]) {
  const folded = new Map<string, { key: string; amount: Paise;
    categoryName: string | null; categoryColor: string | null }>();
  for (const part of splits) {
    const key = part.categoryId ?? 'uncategorised';
    const already = folded.get(key);
    if (already) {
      already.amount += part.amount;
    } else {
      folded.set(key, {
        key,
        amount: part.amount,
        categoryName: part.categoryName,
        categoryColor: part.categoryColor,
      });
    }
  }
  return [...folded.values()];
}

export function TransactionRow({
  tx, onClick, onSplit, onDebt, onRefund, showDate, selected, onSelect, enterDelay = 0,
  extraActions,
}: {
  tx: Transaction;
  onClick?: () => void;
  /**
   * How long this row waits before appearing, which is what gives a freshly
   * loaded list its cascade. The row drives that itself rather than
   * inheriting it from the list: a row added to a list that has already
   * finished animating never receives the parent's state, and would sit
   * there at zero opacity — a row-shaped hole where the entry you just
   * wrote should be.
   */
  enterDelay?: number;
  /** Opens the split editor straight from the row. Left off while picking. */
  onSplit?: () => void;
  /** Turns the whole posting into a debt someone owes. Left off while picking. */
  onDebt?: () => void;
  /** Writes the posting that gives this one back. Left off while picking. */
  onRefund?: () => void;
  showDate?: string;
  /** Whether this row is in the current selection. Absent means the list
   *  isn't selectable at all — inside the record picker, say. */
  selected?: boolean;
  /** Ticking the box. `range` is true when shift was held, which the ledger
   *  reads as "everything between the last one and this". */
  onSelect?: (range: boolean) => void;
  /** Anything else this row can do where it is being shown rather than
   *  everywhere — taking it out of the folder showing it, say. */
  extraActions?: MenuItem[];
}) {
  const [open, setOpen] = useState(false);
  const isTransfer = tx.kind === 'transfer';
  // A refund undoes the posting it names, so neither counts toward what was
  // earned or spent. The row says so on both of them — the money moved, and
  // the balance still has it, so nothing else would give it away.
  const isRefund = !!tx.refundOf;
  const givenBack = tx.refunded >= tx.amount ? 'all' : tx.refunded > 0 ? 'part' : 'none';
  // The credit a card's cashback lands as is the same kind of thing: it pays
  // back what the cycle's purchases already count as given back, so it is
  // not money earned. A purchase that earned some shows what it cost, with
  // what was paid beside it.
  // A Rewards row written by hand while the card's offer covers it is the
  // same credit arriving, and reads the same — under its own words.
  const isCashbackCredit = paysOut(tx);
  const earnedBack = tx.kind === 'expense' && tx.cashback > 0;
  // The whole of it owed by one person, with nothing filed under anything:
  // that is not a division of the posting, it is what the posting is. A row
  // like that says so on its own line rather than hiding the fact behind a
  // chevron that opens on a single name.
  const owedTotal = tx.shares.reduce((sum, s) => sum + s.amount, 0);
  const wholeDebt =
    tx.shares.length > 0 && tx.splits.length === 0 && owedTotal === tx.amount;
  const split = tx.splits.length > 0 || (tx.shares.length > 0 && !wholeDebt);
  const tint = isTransfer
    ? tx.accountColor
    : (tx.categoryColor ?? 'var(--ink-3)');
  const glyph = isTransfer
    ? 'arrow-left-right'
    : (tx.categoryIcon ?? (tx.kind === 'income' ? 'arrow-down-left' : 'circle-dashed'));

  // Filed under a sub-category, the row says which shelf it sits on as well:
  // "Kitchen" on its own is a different bill in Home than it is in Rent, and
  // the group is what the totals are read against.
  const filedAs =
    tx.categoryGroupName && tx.categoryGroupName !== tx.categoryName
      ? `${tx.categoryGroupName} › ${tx.categoryName}`
      : tx.categoryName;

  const owedTo = tx.shares.map((s) => s.counterparty).join(', ');
  const owed = tx.shares.reduce((sum, s) => sum + s.outstanding, 0);
  const lent = tx.shares[0]?.direction === 'lent';
  const subtitle = isRefund
    ? [`Gives back ${tx.refundOfMerchant || 'a transaction'}`, tx.accountName]
        .filter(Boolean)
        .join(' · ')
    : tx.cashbackCycle
      ? `${tx.accountName} · the cycle that closed ${shortDayLabel(tx.cashbackCycle)}`
    : isTransfer
      // A hand-off names the person on the far side of it, not the account
      // the book files it against: the money went to them.
      ? wholeDebt
        ? lent
          ? `${tx.accountName} → ${owedTo}`
          : `${owedTo} → ${tx.toAccountName ?? tx.accountName}`
        : `${tx.accountName} → ${tx.toAccountName ?? (owedTo || 'owed back')}`
      // A split bill's own category is only one of several, so the row leaves
      // the filing to the strip under it — which names every part rather than
      // counting them. Saying "3 parts" here as well was the same fact told
      // twice, a line apart.
      : tx.splits.length
        ? tx.accountName
        : [filedAs, tx.accountName].filter(Boolean).join(' · ');


  return (
    <motion.div
      className={`tx-bill ${open ? 'is-open' : ''} ${selected ? 'is-picked' : ''} ${
        givenBack === 'all' || isRefund || isCashbackCredit ? 'is-undone' : ''
      }`}
      layout="position"
    >
      {/* The box sits in the gutter, tucked under the avatar's left edge. It
          used to stand in the avatar's place, which took away the logo just
          as a run of rows was being read to decide which ones to tick. */}
      {onSelect && (
        <button
          type="button"
          className={`tx-check ${selected ? 'is-on' : ''}`}
          aria-pressed={selected}
          aria-label={selected ? 'Deselect' : 'Select'}
          onClick={(e) => onSelect(e.shiftKey)}
        >
          <Icon name="check" size={12} strokeWidth={3} />
        </button>
      )}
      <motion.button
        type="button"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0, transition: { ...spring, delay: enterDelay } }}
        className="tx-row"
        onClick={onClick}
        whileTap={{ scale: 0.995 }}
      >
        {/* The category's glyph, never the payee's logo. Down a long ledger
            the colour and the shape are what a row is found by, and a wall of
            brand marks reads as a wall of brands rather than as a month of
            spending. The logos are still here, and still used where a row
            stands on its own — the plans, the month's top merchants. */}
        <MerchantLogo merchant={null} icon={glyph} tint={tint} />
        <span className="tx-main">
          <span className="tx-title">
            {tx.merchant || (isTransfer ? 'Transfer' : (tx.categoryName ?? 'Uncategorised'))}
            {isRefund && (
              <span className="tx-label is-refund">
                <Icon name="undo-2" size={11} strokeWidth={2.4} />
                Refund
              </span>
            )}
            {isCashbackCredit && (
              <span
                className="tx-label is-cashback"
                title="The cycle's cashback, credited to the card. Its purchases already count it, so it is not income."
              >
                <Icon name="percent" size={11} strokeWidth={2.4} />
                Cashback credit
              </span>
            )}
            {wholeDebt && owed > 0 && (
              <span
                className="tx-label"
                style={{ ['--tint' as any]: lent ? 'var(--green)' : 'var(--amber)' }}
              >
                {lent ? 'owed to you' : 'you owe'}
              </span>
            )}
            {givenBack !== 'none' && (
              <span className="tx-label is-refund">
                <Icon name="undo-2" size={11} strokeWidth={2.4} />
                {givenBack === 'all' ? 'Refunded' : `${money(tx.refunded)} back`}
              </span>
            )}
          </span>
          <span className="tx-sub">
            {subtitle}
            {earnedBack && (
              <span
                className="tx-cashback"
                title={`Paid ${money(tx.amount)}; ${money(tx.cashback)} of it comes back as cashback${
                  tx.cashbackSet != null ? ' (set by hand)' : ''
                }`}
              >
                {money(tx.amount)} paid · <em>{money(tx.cashback)} back</em>
              </span>
            )}
            {tx.note && (
              <span className="tx-note" title={tx.note}>
                {tx.note}
              </span>
            )}
          </span>
        </span>
        {/* Pins and collections sit beside the figure rather than beside the
            payee: they are things put on a posting afterwards, and a name
            that has to end early to make room for them is the row's own
            words giving way to somebody's filing. */}
        <span className="tx-tags">
            {/* Silent labels are pinned and filterable, and drawn nowhere:
                they are a way of asking the ledger a question, not a mark to
                be read off a row. */}
            {tx.labels.filter((label) => !label.silent).map((label) => (
              <span
                key={label.id}
                className="tx-label"
                style={{ ['--tint' as any]: label.color }}
              >
                {label.name}
              </span>
            ))}
            {/* A folder is a collection rather than a pin, so it is squared
                off where a label is rounded — the shapes say which is which
                before the words are read. */}
            {tx.folders.map((folder) => (
              <span
                key={folder.id}
                className="tx-folder"
                style={{ ['--tint' as any]: folder.color }}
                title={`In ${folder.name}`}
              >
                <Icon name={folder.icon || 'folder'} size={10} strokeWidth={2.4} />
                {folder.name}
              </span>
            ))}
        </span>
        <span className="tx-right">
          <Amount value={effectiveAmount(tx)} kind={tx.kind} />
          <span className="tx-time">{showDate ?? timeLabel(tx.occurredAt)}</span>
        </span>
        <span className="tx-chevron">
          <Icon name="chevron-right" size={16} />
        </span>
      </motion.button>

      {/* What can be done to the row without opening it, behind one glyph.
          A transfer has no category to be divided between, but it can still
          be money somebody owes back. */}
      <div className="tx-row-actions">
        <MoreMenu
          label={`More for ${tx.merchant || 'this entry'}`}
          items={[
            ...(onSplit && !isTransfer
              ? [{
                  icon: 'split',
                  label: 'Split transaction',
                  hint: 'file it under more than one category',
                  onClick: onSplit,
                }]
              : []),
            ...(onDebt
              ? [{
                  icon: 'user-round',
                  label: 'Mark as debt',
                  hint: 'the whole of it becomes a debt',
                  onClick: onDebt,
                }]
              : []),
            // Nothing refunds a transfer, a refund, money that came in, or a
            // posting already given back in full: a refund is what comes back
            // from something spent, and there has to be something left of it.
            ...(onRefund && !isTransfer && !isRefund && tx.kind !== 'income' && givenBack !== 'all'
              ? [{
                  icon: 'undo-2',
                  label: 'Refund it',
                  hint: 'record a refund, neither will count',
                  onClick: onRefund,
                }]
              : []),
            ...(extraActions ?? []),
          ]}
        />
      </div>

      {split && (
        <>
          <button type="button" className="tx-bill-strip" onClick={() => setOpen((o) => !o)}>
            <motion.span animate={{ rotate: open ? 90 : 0 }} transition={spring}>
              <Icon name="chevron-right" size={13} />
            </motion.span>
            {/* What it was cut into, named on the strip rather than described
                by it: the categories are the answer to "how was it split",
                and a row that says the words instead makes you open it to
                find out. The amounts wait inside. */}
            {tx.splits.length > 0 && (
              <span className="tx-bill-parts">
                {byCategory(tx.splits).map((part) => (
                  <span key={part.key} className="tx-bill-part">
                    <i style={{ background: part.categoryColor ?? 'var(--ink-4)' }} />
                    {part.categoryName ?? 'Uncategorised'}
                    <em>{money(part.amount)}</em>
                  </span>
                ))}
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
