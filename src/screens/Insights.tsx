import { useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Icon } from '../components/Icon';
import { MonthNav, periodLabel } from '../components/MonthNav';
import { FlowBars } from '../components/charts';
import { Card, CardHead, Empty, Meter } from '../components/ui';
import type { CategorySlice, FlowPoint } from '../lib/types';
import { useStore } from '../lib/store';
import { compactMoney, money, monthLabel, shortMonthLabel } from '../lib/format';
import { itemVariants, listVariants, spring } from '../lib/motion';

export function Insights({
  onOpenCategory,
}: {
  /** Opens the ledger filtered to one category, over all time. */
  onOpenCategory: (categoryId: string) => void;
}) {
  const { overview, month, setMonth, span, setSpan } = useStore();

  const stats = useMemo(() => {
    if (!overview) return null;
    const flow = overview.monthlyFlow;
    const active = flow.filter((f) => f.income || f.expense);
    const avgSpend = active.length
      ? Math.round(active.reduce((s, f) => s + f.expense, 0) / active.length)
      : 0;
    // A month with almost no income makes the ratio explode (₹799 earned
    // against ₹1.1L spent reads as -14,236%), which tells you nothing. Treat
    // those months as having no meaningful rate.
    const negligibleIncome =
      overview.income <= 0 || overview.income < overview.expense * 0.01;
    const savingsRate = negligibleIncome
      ? null
      : ((overview.income - overview.expense) / overview.income) * 100;
    const daysElapsed = overview.dailyFlow.filter((d) => d.expense > 0).length || 1;
    const perDay = Math.round(overview.expense / daysElapsed);
    const best = [...active].sort(
      (a, b) => b.income - b.expense - (a.income - a.expense),
    )[0];
    return { avgSpend, savingsRate, perDay, best };
  }, [overview]);

  if (!overview || !stats) return null;

  const categoryTotal = overview.topCategories.reduce((s, c) => s + c.total, 0) || 1;
  const label = periodLabel(month, span);
  // The heat-map is a calendar, so it shows the last month of the window
  // rather than trying to lay a whole year out as one.
  const rhythmDays = span > 1
    ? overview.dailyFlow.filter((d) => d.bucket.startsWith(month))
    : overview.dailyFlow;

  return (
    <div className="screen">
      <header className="screen-head">
        <div>
          <h1>Insights</h1>
          <p>
            {overview.monthlyFlow.length} months of cash flow, and where {label} went.
          </p>
        </div>
        <MonthNav month={month} onChange={setMonth} span={span} onSpanChange={setSpan} />
      </header>

      <motion.div
        className="stat-row"
        variants={listVariants}
        initial="initial"
        animate="animate"
      >
        <Stat
          label="Savings rate"
          value={stats.savingsRate === null ? '—' : `${Math.round(stats.savingsRate)}%`}
          hint={
            stats.savingsRate === null
              ? `only ${money(overview.income)} came in`
              : `of ${compactMoney(overview.income)} earned`
          }
          tone={
            stats.savingsRate === null
              ? 'flat'
              : stats.savingsRate >= 20
                ? 'good'
                : stats.savingsRate >= 0
                  ? 'flat'
                  : 'bad'
          }
          icon="piggy-bank"
        />
        <Stat
          label="Spend per active day"
          value={money(stats.perDay)}
          hint={`${overview.dailyFlow.filter((d) => d.expense > 0).length} days with spending`}
          icon="calendar-days"
        />
        <Stat
          label={`${overview.monthlyFlow.length}-month average spend`}
          value={money(stats.avgSpend)}
          hint={
            overview.expense > stats.avgSpend
              ? `${compactMoney(overview.expense - stats.avgSpend)} above average`
              : `${compactMoney(stats.avgSpend - overview.expense)} below average`
          }
          tone={overview.expense > stats.avgSpend ? 'bad' : 'good'}
          icon="trending-up"
        />
        <Stat
          label="Best month"
          value={stats.best ? monthLabel(stats.best.bucket) : '—'}
          hint={stats.best ? `${money(stats.best.income - stats.best.expense)} kept` : 'not enough history'}
          tone="good"
          icon="sparkles"
        />
      </motion.div>

      <Card className="chart-card">
        <CardHead
          title="Cash flow"
          hint="Money in against money out, month by month"
          action={
            <div className="legend">
              <span><i style={{ background: 'var(--green)' }} /> In</span>
              <span><i style={{ background: 'var(--ink-3)' }} /> Out</span>
            </div>
          }
        />
        <FlowBars points={overview.monthlyFlow} labelOf={shortMonthLabel} height={210} />
      </Card>

      <div className="insight-grid">
        <Card>
          <CardHead title="Category breakdown" hint={label} />
          {overview.topCategories.length ? (
            <motion.ul
              className="breakdown"
              variants={listVariants}
              initial="initial"
              animate="animate"
            >
              {overview.topCategories.map((c) => (
                <BreakdownRow
                  key={c.categoryId}
                  slice={c}
                  total={categoryTotal}
                  onOpen={onOpenCategory}
                />
              ))}
            </motion.ul>
          ) : (
            <Empty icon="grid-2x2" title="Nothing to break down" body="Categorised spending shows up here." />
          )}
        </Card>

        <Card>
          <CardHead
            title="Daily rhythm"
            hint={span > 1 ? `Spend by day, ${monthLabel(month)}` : 'Spend by day of the month'}
          />
          <RhythmCalendar days={rhythmDays} />
        </Card>
      </div>
    </div>
  );
}

/**
 * A group row that unfolds to reveal the leaf categories inside it. The row
 * itself leads to the ledger — what a breakdown makes you want is the
 * entries behind the figure — so unfolding is the caret's job alone.
 */
function BreakdownRow({
  slice, total, onOpen,
}: {
  slice: CategorySlice;
  total: number;
  onOpen: (categoryId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const expandable = slice.children.length > 0;

  return (
    <motion.li variants={itemVariants} className={expandable ? 'is-expandable' : ''}>
      <div className="breakdown-line">
        <button
          className="breakdown-row"
          onClick={() => onOpen(slice.categoryId)}
          title={`Show every ${slice.name} entry`}
        >
          <span className="cat-swatch" style={{ background: slice.color }}>
            <Icon name={slice.icon} size={12} strokeWidth={2.3} />
          </span>
          <div className="breakdown-main">
            <div className="breakdown-top">
              <span>{slice.name}</span>
              <strong>{money(slice.total)}</strong>
            </div>
            <Meter value={slice.total / total} color={slice.color} />
          </div>
          <span className="breakdown-pct">{Math.round((slice.total / total) * 100)}%</span>
        </button>
        {expandable && (
          <button
            className="breakdown-caret"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            aria-label={open ? `Hide what is in ${slice.name}` : `What is in ${slice.name}`}
          >
            <motion.span animate={{ rotate: open ? 90 : 0 }} transition={spring}>
              <Icon name="chevron-right" size={13} />
            </motion.span>
          </button>
        )}
      </div>

      <AnimatePresence initial={false}>
        {open && (
          <motion.ul
            className="breakdown-children"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={spring}
          >
            {slice.children.map((child) => (
              <li key={child.categoryId}>
                <button
                  type="button"
                  className="child-row"
                  onClick={() => onOpen(child.categoryId)}
                  title={`Show every ${child.name} entry`}
                >
                  <span className="child-dot" style={{ background: child.color }} />
                  <span className="child-name">{child.name}</span>
                  <span className="child-count">{child.count}</span>
                  <strong>{money(child.total)}</strong>
                </button>
              </li>
            ))}
          </motion.ul>
        )}
      </AnimatePresence>
    </motion.li>
  );
}

const WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

/** Calendar heat-map of the month: Monday-first, one cell per day, inked in
 *  proportion to that day's spend. */
function RhythmCalendar({ days }: { days: FlowPoint[] }) {
  if (!days.length) return null;
  const peak = Math.max(1, ...days.map((d) => d.expense));
  const first = new Date(`${days[0].bucket}T00:00`);
  const offset = (first.getDay() + 6) % 7;
  const today = new Date().toISOString().slice(0, 10);

  return (
    <>
      <div className="rhythm">
        {WEEKDAYS.map((label, i) => (
          <span key={i} className="rhythm-weekday">{label}</span>
        ))}
        {Array.from({ length: offset }).map((_, i) => (
          <span key={`pad-${i}`} className="rhythm-pad" />
        ))}
        {days.map((day, i) => {
          const intensity = day.expense / peak;
          return (
            <motion.span
              key={day.bucket}
              className={`rhythm-cell ${intensity > 0.55 ? 'is-deep' : ''} ${
                day.bucket === today ? 'is-today' : ''
              }`}
              title={`${day.bucket} · ${money(day.expense)}`}
              initial={{ opacity: 0, scale: 0.7 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ ...spring, delay: i * 0.012 }}
              style={{
                background:
                  day.expense === 0
                    ? 'var(--surface-inset)'
                    : `color-mix(in srgb, var(--ink) ${14 + intensity * 76}%, var(--surface-inset))`,
              }}
            >
              {Number(day.bucket.slice(8))}
            </motion.span>
          );
        })}
      </div>
      <div className="rhythm-legend">
        <span>Quiet</span>
        <div className="rhythm-scale">
          {[0.05, 0.25, 0.5, 0.75, 1].map((t) => (
            <i
              key={t}
              style={{
                background: `color-mix(in srgb, var(--ink) ${14 + t * 76}%, var(--surface-inset))`,
              }}
            />
          ))}
        </div>
        <span>Heavy</span>
      </div>
    </>
  );
}

function Stat({
  label, value, hint, icon, tone = 'flat',
}: {
  label: string;
  value: string;
  hint: string;
  icon: string;
  tone?: 'good' | 'bad' | 'flat';
}) {
  return (
    <motion.div className={`stat stat-${tone}`} variants={itemVariants} whileHover={{ y: -2 }}>
      <span className="stat-glyph">
        <Icon name={icon} size={16} />
      </span>
      <span className="stat-label">{label}</span>
      <strong className="stat-value">{value}</strong>
      <span className="stat-hint">{hint}</span>
    </motion.div>
  );
}
