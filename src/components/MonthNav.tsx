import { AnimatePresence, motion, type Variants } from 'motion/react';
import { useEffect, useId, useRef, useState } from 'react';
import { Icon } from './Icon';
import { IconButton } from './ui';
import { monthKey, monthLabel, shiftMonth, shortMonthLabel } from '../lib/format';
import { itemVariants, popover, press, spring } from '../lib/motion';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const QUARTERS = [
  { label: 'Jan – Mar', start: 1 },
  { label: 'Apr – Jun', start: 4 },
  { label: 'Jul – Sep', start: 7 },
  { label: 'Oct – Dec', start: 10 },
];

/** How many years the year grid shows at once, and how far a chevron jumps. */
const YEARS_SHOWN = 12;

/** Which shape of window a period picker offers. */
type Mode = 'month' | 'quarter' | 'year' | 'range';

const MODES: { value: Mode; label: string }[] = [
  { value: 'month', label: 'Month' },
  { value: 'quarter', label: 'Quarter' },
  { value: 'year', label: 'Year' },
  { value: 'range', label: 'Range' },
];

/**
 * Switching between months, quarters and years swaps the whole body of the
 * picker, so it leaves as one piece and the new one cascades in behind it.
 */
const bodyVariants: Variants = {
  initial: { opacity: 0, y: 6 },
  animate: {
    opacity: 1,
    y: 0,
    transition: { ...spring, staggerChildren: 0.018, delayChildren: 0.03 },
  },
  exit: { opacity: 0, y: -6, transition: { duration: 0.12 } },
};

/** Months since year zero, so two month keys can be compared and subtracted. */
function monthIndex(key: string) {
  const [y, m] = key.split('-').map(Number);
  return y * 12 + (m - 1);
}

/** How many months a window from `start` to `end` covers, both ends included. */
export function spanBetween(start: string, end: string) {
  return Math.max(1, monthIndex(end) - monthIndex(start) + 1);
}

/** "August 2026" · "Jun – Aug 2026" · "2025" · "Sep 2025 – Aug 2026" */
export function periodLabel(month: string, span: number) {
  if (span <= 1) return monthLabel(month, true);
  const start = shiftMonth(month, -(span - 1));
  const [startYear, startMonth] = start.split('-');
  const [endYear, endMonth] = month.split('-');
  if (startYear !== endYear) return `${monthLabel(start)} – ${monthLabel(month)}`;
  // A whole calendar year is worth saying as a year rather than as its ends.
  if (startMonth === '01' && endMonth === '12') return startYear;
  return `${shortMonthLabel(start)} – ${shortMonthLabel(month)} ${endYear}`;
}

/** The window shape a month/span pair reads as, for reopening the picker on it. */
function modeOf(month: string, span: number, current: string): Mode {
  if (span <= 1) return 'month';
  const start = shiftMonth(month, -(span - 1));
  const [sy, sm] = start.split('-').map(Number);
  const [ey, em] = month.split('-').map(Number);
  if (sy !== ey) return 'range';
  if (sm === 1 && em === 12) return 'year';
  if ((sm - 1) % 3 === 0 && em === sm + 2) return 'quarter';
  // A window that runs up to today is this year or this quarter, part-done.
  if (month === current) {
    if (sm === 1) return 'year';
    if ((sm - 1) % 3 === 0 && em <= sm + 2) return 'quarter';
  }
  return 'range';
}

/**
 * Steps through time by whatever window is being viewed: one month at a time
 * for a month, three at a time for a quarter, and so on. `month` is always the
 * *last* month of the window.
 *
 * Given `onSpanChange` the picker also chooses the window itself — a month, a
 * quarter, a whole year, or any run of months between two picks.
 */
export function MonthNav({
  month, onChange, span = 1, onSpanChange,
}: {
  month: string;
  onChange: (month: string) => void;
  /** Window size in months. */
  span?: number;
  /** Provided when the window size is the picker's to choose. */
  onSpanChange?: (span: number) => void;
}) {
  const direction = useRef(1);
  // Which way the year number should slide when the stepper moves.
  const yearDirection = useRef(1);
  const pill = useId();
  const current = monthKey();
  const [open, setOpen] = useState(false);
  // The year the picker is showing, which is not necessarily the selected one.
  const [year, setYear] = useState(() => Number(month.slice(0, 4)));
  const [mode, setMode] = useState<Mode>(() => modeOf(month, span, current));
  // One end of a range, held while the other end is being picked.
  const [anchor, setAnchor] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  // The year in the header opens a block of years to jump to, rather than
  // making you step to 2019 one click at a time.
  const [browsingYears, setBrowsingYears] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  const step = (delta: number) => {
    direction.current = delta;
    onChange(shiftMonth(month, delta * span));
  };

  // Opening the picker shows the window that is actually in view.
  useEffect(() => {
    if (!open) return;
    setYear(Number(month.slice(0, 4)));
    setMode(modeOf(month, span, current));
    setAnchor(null);
    setHover(null);
    setBrowsingYears(false);
  }, [open, month, span, current]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    // Captured, so Escape closes the picker rather than the modal around it.
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

  /** `month` is the *last* month of the window, so a pick lands on its end. */
  const pick = (key: string) => {
    direction.current = key > month ? 1 : -1;
    onChange(key > current ? current : key);
    setOpen(false);
  };

  /**
   * Selects a whole window. Nothing runs past the current month, so picking
   * this year or this quarter gives you as much of it as has happened.
   */
  const pickWindow = (a: string, b: string) => {
    const start = a < b ? a : b;
    const wanted = a < b ? b : a;
    const end = wanted > current ? current : wanted;
    if (end < start) return;
    direction.current = end > month ? 1 : -1;
    onChange(end);
    onSpanChange?.(spanBetween(start, end));
    setOpen(false);
  };

  const keyFor = (m: number) => `${year}-${String(m).padStart(2, '0')}`;

  const windowStart = shiftMonth(month, -(span - 1));
  // Only the picker that owns the window size can pick two ends of one.
  const ranging = !!onSpanChange && mode === 'range';

  /** How a month sits in the window being shown: an end of it, or inside it. */
  const monthState = (key: string) => {
    if (anchor) {
      const other = hover ?? anchor;
      const [lo, hi] = anchor < other ? [anchor, other] : [other, anchor];
      if (key === anchor) return 'picked';
      return key >= lo && key <= hi ? 'in' : '';
    }
    if (key === month || key === windowStart) return 'picked';
    return key > windowStart && key < month ? 'in' : '';
  };

  const onMonthClick = (key: string) => {
    if (!onSpanChange) return pick(key);
    if (!ranging) return pickWindow(key, key);
    if (!anchor) {
      setAnchor(key);
      setHover(null);
      return;
    }
    pickWindow(anchor, key);
  };

  const stepYear = (delta: number) => {
    yearDirection.current = delta;
    setYear((y) => y + delta);
  };

  // Browsing years, the chevrons move by the whole block on show.
  const yearStep = browsingYears ? YEARS_SHOWN : 1;

  const yearStepper = (
    <motion.div className="period-pop-head" variants={itemVariants}>
      <motion.button
        type="button"
        aria-label="Previous year"
        whileTap={press}
        onClick={() => stepYear(-yearStep)}
      >
        <Icon name="chevron-left" size={15} />
      </motion.button>
      <motion.button
        type="button"
        aria-label="Pick a year"
        className={`period-year ${browsingYears ? 'is-on' : ''}`}
        whileTap={press}
        onClick={() => setBrowsingYears((b) => !b)}
      >
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={year}
            initial={{ opacity: 0, y: yearDirection.current * 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: yearDirection.current * -10 }}
            transition={spring}
          >
            {year}
          </motion.span>
        </AnimatePresence>
      </motion.button>
      <motion.button
        type="button"
        aria-label="Next year"
        whileTap={press}
        disabled={`${year + yearStep}-01` > current}
        onClick={() => stepYear(yearStep)}
      >
        <Icon name="chevron-right" size={15} />
      </motion.button>
    </motion.div>
  );

  // Both ends of a range are inked at once, and a single pill cannot be in two
  // places — it only glides while exactly one cell owns the selection.
  const glide = !ranging || !!anchor || span <= 1;

  const monthGrid = (
    <div className="period-months">
      {MONTHS.map((label, i) => {
        const key = keyFor(i + 1);
        const state = ranging ? monthState(key) : key === month ? 'picked' : '';
        return (
          <motion.button
            key={label}
            type="button"
            variants={itemVariants}
            whileTap={key > current ? undefined : press}
            disabled={key > current}
            className={state === 'picked' ? 'is-picked' : state === 'in' ? 'is-in-range' : ''}
            onMouseEnter={ranging ? () => setHover(key) : undefined}
            onClick={() => onMonthClick(key)}
          >
            {state === 'picked' && (
              <motion.span
                layoutId={glide ? `period-pick-${pill}` : undefined}
                className="period-pick"
                transition={spring}
              />
            )}
            <span>{label}</span>
          </motion.button>
        );
      })}
    </div>
  );

  const quarterGrid = (
    <div className="period-quarters">
      {QUARTERS.map((q) => {
        const from = keyFor(q.start);
        const to = keyFor(q.start + 2);
        const picked =
          span <= 3 && from === windowStart && (to === month || month === current);
        return (
          <motion.button
            key={q.label}
            type="button"
            variants={itemVariants}
            whileTap={from > current ? undefined : press}
            disabled={from > current}
            className={picked ? 'is-picked' : ''}
            onClick={() => (onSpanChange ? pickWindow(from, to) : pick(to))}
          >
            {picked && (
              <motion.span
                layoutId={`period-pick-${pill}`}
                className="period-pick"
                transition={spring}
              />
            )}
            <span>{q.label}</span>
          </motion.button>
        );
      })}
    </div>
  );

  /** A block of years — either to select a window from, or only to jump to. */
  const yearsGrid = (
    onPick: (y: number) => void,
    isPicked: (y: number) => boolean,
    layoutId?: string,
  ) => (
    <div className="period-years">
      {Array.from({ length: YEARS_SHOWN }, (_, i) => year - 8 + i).map((y) => {
        const picked = isPicked(y);
        return (
          <motion.button
            key={y}
            type="button"
            variants={itemVariants}
            whileTap={`${y}-01` > current ? undefined : press}
            disabled={`${y}-01` > current}
            className={picked ? 'is-picked' : ''}
            onClick={() => onPick(y)}
          >
            {picked && (
              <motion.span
                layoutId={layoutId}
                className="period-pick"
                transition={spring}
              />
            )}
            <span>{y}</span>
          </motion.button>
        );
      })}
    </div>
  );

  const yearGrid = yearsGrid(
    (y) => (onSpanChange ? pickWindow(`${y}-01`, `${y}-12`) : pick(`${y}-12`)),
    (y) => y === Number(month.slice(0, 4)) && (!onSpanChange || mode === 'year'),
    `period-pick-${pill}`,
  );

  // The header's own year grid moves the picker to a year; it selects nothing,
  // so it carries no travelling pill either.
  const browseYears = yearsGrid(
    (y) => {
      setYear(y);
      setBrowsingYears(false);
    },
    (y) => y === year,
  );

  const [thisYear, thisMonth] = current.split('-').map(Number);
  const quarterStart = `${thisYear}-${String(thisMonth - ((thisMonth - 1) % 3)).padStart(2, '0')}`;
  /**
   * The windows people ask for by name. Each is clamped to the current month,
   * so this quarter and this year are as much of them as has happened.
   */
  const PRESETS = [
    { label: 'This month', from: current, to: current },
    { label: 'Last month', from: shiftMonth(current, -1), to: shiftMonth(current, -1) },
    { label: 'This quarter', from: quarterStart, to: current },
    {
      label: 'Last quarter',
      from: shiftMonth(quarterStart, -3),
      to: shiftMonth(quarterStart, -1),
    },
    { label: 'This year', from: `${thisYear}-01`, to: current },
    { label: 'Last year', from: `${thisYear - 1}-01`, to: `${thisYear - 1}-12` },
    { label: 'Last 6 months', from: shiftMonth(current, -5), to: current },
    { label: 'Last 12 months', from: shiftMonth(current, -11), to: current },
  ];

  const presetGrid = (
    <motion.div className="period-presets" variants={itemVariants}>
      {PRESETS.map((p) => (
        <button
          key={p.label}
          type="button"
          className={`period-preset ${
            p.from === windowStart && p.to === month ? 'is-on' : ''
          }`}
          onClick={() => pickWindow(p.from, p.to)}
        >
          {p.label}
        </button>
      ))}
    </motion.div>
  );

  /**
   * The way back to now. It lives in the picker rather than beside it: a
   * button that appeared in the toolbar the moment you stepped away shifted
   * everything around it, and a nav you are clicking through is the last
   * place that should move under the pointer.
   */
  const todayFoot = (
    <motion.div layout className="period-foot" variants={itemVariants}>
      <motion.button
        type="button"
        className="period-today"
        whileTap={press}
        onClick={() => {
          direction.current = month < current ? 1 : -1;
          onChange(current);
          onSpanChange?.(1);
          setOpen(false);
        }}
      >
        <Icon name="calendar-days" size={13} />
        Today
      </motion.button>
    </motion.div>
  );

  return (
    <div className="month-nav" ref={wrap}>
      <IconButton
        icon="chevron-left"
        label={span > 1 ? 'Previous period' : 'Previous month'}
        size={30}
        onClick={() => step(-1)}
      />
      <button
        type="button"
        className={`month-label ${span > 1 ? 'is-wide' : ''} ${open ? 'is-open' : ''}`}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={`${month}-${span}`}
            initial={{ opacity: 0, x: direction.current * 14 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: direction.current * -14 }}
            transition={spring}
          >
            {periodLabel(month, span)}
          </motion.span>
        </AnimatePresence>
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            className="period-pop"
            // Months, quarters and years are different heights: `layout` lets
            // the popover grow into the new one rather than jump.
            layout
            variants={popover}
            initial="initial"
            animate="animate"
            exit="exit"
            onMouseLeave={() => setHover(null)}
          >
            {onSpanChange ? (
              <>
                <motion.div layout className="period-modes" role="tablist">
                  {MODES.map((m) => (
                    <motion.button
                      key={m.value}
                      type="button"
                      role="tab"
                      aria-selected={m.value === mode}
                      whileTap={press}
                      className={m.value === mode ? 'is-on' : ''}
                      onClick={() => {
                        setMode(m.value);
                        setAnchor(null);
                        setBrowsingYears(false);
                      }}
                    >
                      {m.value === mode && (
                        <motion.span
                          layoutId={`period-mode-${pill}`}
                          className="period-mode-pill"
                          transition={spring}
                        />
                      )}
                      <span>{m.label}</span>
                    </motion.button>
                  ))}
                </motion.div>
                <AnimatePresence mode="popLayout" initial={false}>
                  <motion.div
                    key={browsingYears ? `${mode}-years` : mode}
                    className="period-body"
                    variants={bodyVariants}
                    initial="initial"
                    animate="animate"
                    exit="exit"
                  >
                    {ranging && !browsingYears && presetGrid}
                    {mode !== 'year' && yearStepper}
                    {browsingYears
                      ? browseYears
                      : mode === 'quarter'
                        ? quarterGrid
                        : mode === 'year'
                          ? yearGrid
                          : monthGrid}
                  </motion.div>
                </AnimatePresence>
                <AnimatePresence mode="popLayout" initial={false}>
                  {ranging && !browsingYears && (
                    <motion.p
                      key={anchor ?? 'none'}
                      className="period-hint"
                      initial={{ opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -4 }}
                      transition={spring}
                    >
                      {anchor
                        ? `From ${monthLabel(anchor)}. Now pick the other end.`
                        : 'Pick the first month of the range.'}
                    </motion.p>
                  )}
                </AnimatePresence>
              </>
            ) : span >= 12 ? (
              // A year-wide window: pick the year itself.
              yearGrid
            ) : (
              <>
                {yearStepper}
                {browsingYears ? browseYears : span === 1 ? monthGrid : quarterGrid}
              </>
            )}
            {todayFoot}
          </motion.div>
        )}
      </AnimatePresence>
      <IconButton
        icon="chevron-right"
        label={span > 1 ? 'Next period' : 'Next month'}
        size={30}
        disabled={month >= current}
        onClick={() => step(1)}
      />
    </div>
  );
}
