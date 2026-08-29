import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
import { monthLabel, shiftMonth } from '../lib/format';
import { popover, spring } from '../lib/motion';

const WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

/** `YYYY-MM-DD` for a local date, without UTC shifting it a day either way. */
function isoOf(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}

function parseIso(iso: string) {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return null;
  const date = new Date(y, m - 1, d);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Every cell of the grid: the weeks that cover this month, Monday first. */
function monthGrid(month: string) {
  const [y, m] = month.split('-').map(Number);
  const first = new Date(y, m - 1, 1);
  // getDay() is Sunday-first; the calendar reads Monday-first.
  const lead = (first.getDay() + 6) % 7;
  const start = new Date(y, m - 1, 1 - lead);
  return Array.from({ length: 42 }, (_, i) => {
    const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    return { date: day, iso: isoOf(day), inMonth: day.getMonth() === m - 1 };
  });
}

/** "Thu, 14 Aug 2026" — long enough to be unambiguous in a form. */
export function dateFieldLabel(iso: string) {
  const date = parseIso(iso);
  if (!date) return 'Pick a date';
  return date.toLocaleDateString('en-IN', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/**
 * A calendar in the app's own clothes. The native control is a system panel
 * that ignores the theme entirely, and on a date-only field it also hands back
 * a value the moment a partial year is typed.
 */
export function DateField({
  value, onChange, placeholder = 'Pick a date', allowClear, max,
}: {
  value: string;
  onChange: (iso: string) => void;
  placeholder?: string;
  allowClear?: boolean;
  /** Latest selectable date, as `YYYY-MM-DD`. */
  max?: string;
}) {
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(() => (value || isoOf(new Date())).slice(0, 7));
  const [rect, setRect] = useState<DOMRect | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) setCursor((value || isoOf(new Date())).slice(0, 7));
  }, [open, value]);

  useLayoutEffect(() => {
    if (open && trigger.current) setRect(trigger.current.getBoundingClientRect());
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (panel.current?.contains(target) || trigger.current?.contains(target)) return;
      setOpen(false);
    };
    // Captured and stopped, so Escape closes the calendar rather than the
    // sheet holding it.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  const cells = useMemo(() => monthGrid(cursor), [cursor]);
  const today = isoOf(new Date());

  // Flip above the trigger when there isn't room beneath it.
  const height = 320;
  const below = rect ? window.innerHeight - rect.bottom : 0;
  const flip = rect ? below < height && rect.top > below : false;

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={`date-field ${open ? 'is-open' : ''} ${value ? '' : 'is-empty'}`}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="calendar-days" size={15} />
        <span>{value ? dateFieldLabel(value) : placeholder}</span>
        {allowClear && value && (
          <span
            className="date-clear"
            role="button"
            aria-label="Clear"
            onClick={(e) => {
              e.stopPropagation();
              onChange('');
            }}
          >
            <Icon name="x" size={13} />
          </span>
        )}
      </button>

      {createPortal(
        <AnimatePresence>
          {open && rect && (
            <motion.div
              ref={panel}
              className="date-pop"
              variants={popover}
              initial="initial"
              animate="animate"
              exit="exit"
              style={{
                position: 'fixed',
                left: Math.min(rect.left, window.innerWidth - 296),
                top: flip ? undefined : rect.bottom + 6,
                bottom: flip ? window.innerHeight - rect.top + 6 : undefined,
              }}
            >
              <div className="date-pop-head">
                <button type="button" onClick={() => setCursor(shiftMonth(cursor, -1))}>
                  <Icon name="chevron-left" size={15} />
                </button>
                <strong>{monthLabel(cursor, true)}</strong>
                <button type="button" onClick={() => setCursor(shiftMonth(cursor, 1))}>
                  <Icon name="chevron-right" size={15} />
                </button>
              </div>

              <div className="date-grid">
                {WEEKDAYS.map((day, i) => (
                  <span key={i} className="date-weekday">{day}</span>
                ))}
                {cells.map((cell) => {
                  const disabled = max ? cell.iso > max : false;
                  return (
                    <button
                      key={cell.iso}
                      type="button"
                      disabled={disabled}
                      className={[
                        'date-cell',
                        cell.inMonth ? '' : 'is-outside',
                        cell.iso === value ? 'is-picked' : '',
                        cell.iso === today ? 'is-today' : '',
                      ].join(' ')}
                      onClick={() => {
                        onChange(cell.iso);
                        setOpen(false);
                      }}
                    >
                      {cell.iso === value && (
                        <motion.span
                          layoutId="date-pick"
                          className="date-pick"
                          transition={spring}
                        />
                      )}
                      <em>{cell.date.getDate()}</em>
                    </button>
                  );
                })}
              </div>

              <div className="date-pop-foot">
                <button
                  type="button"
                  onClick={() => {
                    onChange(today);
                    setOpen(false);
                  }}
                >
                  Today
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </>
  );
}
