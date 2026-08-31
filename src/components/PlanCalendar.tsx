import { useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Icon } from './Icon';
import { MerchantLogo } from './MerchantLogo';
import { IconButton } from './ui';
import { compactMoney, money, monthLabel, shiftMonth } from '../lib/format';
import { itemVariants, listVariants, spring } from '../lib/motion';
import type { PlanOccurrence } from '../lib/types';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const tint = (o: PlanOccurrence) =>
  o.categoryColor ?? (o.kind === 'income' ? 'var(--green)' : 'var(--ink-3)');

/**
 * The month as a bill calendar: every turn of every plan on the day it falls,
 * what has already been paid marked off.
 *
 * A month of money is not a list — it is a shape, with the rent at one end
 * and the cards at the other, and a week in between where nothing happens.
 * That shape is the whole reason to draw a calendar rather than sort a list
 * by date, so the cells carry the payees themselves rather than dots.
 */
export function PlanCalendar({
  month, onMonthChange, occurrences, onOpenPlan, onOpenTransaction,
}: {
  /** YYYY-MM. */
  month: string;
  onMonthChange: (month: string) => void;
  /** Everything falling in that month, paid and unpaid alike. */
  occurrences: PlanOccurrence[];
  onOpenPlan: (planId: string) => void;
  /** Opens the posting that paid a cycle, when one did. */
  onOpenTransaction: (transactionId: string) => void;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const [picked, setPicked] = useState<string | null>(null);

  const byDay = useMemo(() => {
    const map = new Map<string, PlanOccurrence[]>();
    for (const o of occurrences) {
      const list = map.get(o.dueOn);
      if (list) list.push(o);
      else map.set(o.dueOn, [o]);
    }
    return map;
  }, [occurrences]);

  const [year, monthNo] = month.split('-').map(Number);
  const first = new Date(year, monthNo - 1, 1);
  const days = new Date(year, monthNo, 0).getDate();
  // Monday-first, like every calendar anybody actually keeps bills in.
  const offset = (first.getDay() + 6) % 7;

  const out = occurrences
    .filter((o) => o.kind !== 'income' && !o.skipped)
    .reduce((sum, o) => sum + (o.paid ? o.actualAmount : o.amount), 0);
  const paid = occurrences
    .filter((o) => o.kind !== 'income' && o.paid)
    .reduce((sum, o) => sum + o.actualAmount, 0);
  const income = occurrences
    .filter((o) => o.kind === 'income' && !o.skipped)
    .reduce((sum, o) => sum + (o.paid ? o.actualAmount : o.amount), 0);

  const chosen = picked ? (byDay.get(picked) ?? []) : [];

  return (
    <div className="plan-cal">
      <header className="plan-cal-head">
        <div className="plan-cal-nav">
          <IconButton
            icon="chevron-left"
            label="Previous month"
            size={30}
            onClick={() => { setPicked(null); onMonthChange(shiftMonth(month, -1)); }}
          />
          <strong>{monthLabel(month, true)}</strong>
          <IconButton
            icon="chevron-right"
            label="Next month"
            size={30}
            onClick={() => { setPicked(null); onMonthChange(shiftMonth(month, 1)); }}
          />
        </div>
        <div className="plan-cal-totals">
          <span>
            <em>Going out</em>
            <strong>{money(out)}</strong>
          </span>
          <span>
            <em>Already paid</em>
            <strong className="is-paid">{money(paid)}</strong>
          </span>
          {income > 0 && (
            <span>
              <em>Coming in</em>
              <strong className="is-up">{money(income)}</strong>
            </span>
          )}
        </div>
      </header>

      <div className="plan-cal-grid">
        {WEEKDAYS.map((label) => (
          <span key={label} className="plan-cal-weekday">{label}</span>
        ))}
        {Array.from({ length: offset }).map((_, i) => (
          <span key={`pad-${i}`} className="plan-cal-pad" />
        ))}
        {Array.from({ length: days }).map((_, i) => {
          const iso = `${month}-${String(i + 1).padStart(2, '0')}`;
          const items = byDay.get(iso) ?? [];
          const total = items
            .filter((o) => o.kind !== 'income' && !o.skipped)
            .reduce((sum, o) => sum + (o.paid ? o.actualAmount : o.amount), 0);
          const late = items.some((o) => !o.paid && !o.skipped && iso < today);
          return (
            <button
              key={iso}
              type="button"
              className={`plan-cal-day ${iso === today ? 'is-today' : ''} ${
                iso < today ? 'is-past' : ''
              } ${items.length ? 'has-plans' : ''} ${late ? 'is-late' : ''} ${
                picked === iso ? 'is-picked' : ''
              }`}
              onClick={() => setPicked((was) => (was === iso ? null : iso))}
            >
              <span className="plan-cal-date">
                {i + 1}
                {total > 0 && <em>{compactMoney(total)}</em>}
              </span>
              <span className="plan-cal-items">
                {items.slice(0, 3).map((o) => (
                  <span
                    key={`${o.planId}-${o.dueOn}`}
                    className={`plan-cal-chip ${o.paid ? 'is-paid' : ''} ${
                      o.skipped ? 'is-skipped' : ''
                    }`}
                    style={{ ['--tint' as any]: tint(o) }}
                  >
                    <i />
                    {o.name}
                  </span>
                ))}
                {items.length > 3 && (
                  <span className="plan-cal-more">+{items.length - 3} more</span>
                )}
              </span>
            </button>
          );
        })}
      </div>

      <AnimatePresence initial={false}>
        {picked && (
          <motion.div
            className="plan-cal-day-panel"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={spring}
          >
            <div className="plan-cal-day-head">
              <h4>
                {new Date(`${picked}T00:00`).toLocaleDateString('en-IN', {
                  weekday: 'long',
                  day: 'numeric',
                  month: 'long',
                })}
              </h4>
              <IconButton icon="x" label="Close" size={28} onClick={() => setPicked(null)} />
            </div>
            {chosen.length === 0 ? (
              <p className="plan-cal-quiet">Nothing planned for this day.</p>
            ) : (
              <motion.ul variants={listVariants} initial="initial" animate="animate">
                {chosen.map((o) => (
                  <motion.li key={`${o.planId}-${o.dueOn}`} variants={itemVariants}>
                    <button
                      type="button"
                      className="plan-cal-row"
                      onClick={() =>
                        o.paid && o.transactionId
                          ? onOpenTransaction(o.transactionId)
                          : onOpenPlan(o.planId)
                      }
                    >
                      <MerchantLogo
                        merchant={o.merchant || o.name}
                        icon={o.categoryIcon ?? 'repeat'}
                        tint={tint(o)}
                        size={32}
                        glyphSize={15}
                      />
                      <span className="plan-cal-row-main">
                        <strong>{o.name}</strong>
                        <span>
                          {o.skipped
                            ? 'Skipped'
                            : o.paid
                              ? `Paid${o.accountName ? ` from ${o.accountName}` : ''}`
                              : o.automatic
                                ? 'Debits itself'
                                : 'To pay'}
                        </span>
                      </span>
                      <span className="plan-cal-row-amount">
                        <strong className={o.kind === 'income' ? 'is-up' : ''}>
                          {money(o.paid ? o.actualAmount : o.amount)}
                        </strong>
                        {o.paid && <Icon name="check-check" size={13} />}
                      </span>
                    </button>
                  </motion.li>
                ))}
              </motion.ul>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
