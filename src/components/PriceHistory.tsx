import { useEffect, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { PriceChart } from './charts';
import { Card, CardHead, Segmented, type SegmentOption } from './ui';
import { dayLabel, percent, unitPrice } from '../lib/format';
import { useStore } from '../lib/store';
import type { PricePoint } from '../lib/types';

type Range = '1M' | '6M' | '1Y' | '5Y' | 'Max';

/** Null means everything on file. */
const DAYS: Record<Range, number | null> = {
  '1M': 31,
  '6M': 183,
  '1Y': 366,
  '5Y': 1827,
  Max: null,
};

const RANGES: SegmentOption<Range>[] = (Object.keys(DAYS) as Range[]).map((value) => ({
  value,
  label: value,
}));

/**
 * A price line with its own range picker — the same card whether it is one
 * fund's NAV or the gold rate every piece is valued from. Whoever mounts it
 * says how to load a window; everything else is the same story either way.
 */
export function PriceHistory({
  title, hint, tint, load, reference, referenceLabel, footnote, filter, reloadOn,
  initialRange = '1Y',
}: {
  title: string;
  hint?: string;
  tint: string;
  /** `days` bounds the window; null asks for the whole line. */
  load: (days: number | null) => Promise<PricePoint[]>;
  /** A scaled price to rule across the chart — a fund's average cost. */
  reference?: number | null;
  referenceLabel?: string;
  footnote?: string;
  /** A control of the mounter's own, sat beside the range picker. */
  filter?: ReactNode;
  /** Anything else that changes what `load` returns — a purity, say. */
  reloadOn?: string | number;
  initialRange?: Range;
}) {
  const { revision } = useStore();
  const [range, setRange] = useState<Range>(initialRange);
  const [points, setPoints] = useState<PricePoint[] | null>(null);

  useEffect(() => {
    let live = true;
    load(DAYS[range])
      .then((series) => live && setPoints(series))
      .catch(() => live && setPoints([]));
    return () => {
      live = false;
    };
    // `load` is a fresh closure each render, so the window, the book's
    // revision and whatever the mounter filters by are what actually decide
    // when this refetches.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, revision, reloadOn]);

  const line = points ?? [];
  const first = line[0];
  const last = line[line.length - 1];
  // What the range itself did — the number a chart is read for before any
  // single day on it.
  const change = first && last ? last.priceE4 - first.priceE4 : 0;
  const changePct = first?.priceE4 ? (change / first.priceE4) * 100 : null;
  const high = line.length ? Math.max(...line.map((p) => p.priceE4)) : 0;
  const low = line.length ? Math.min(...line.map((p) => p.priceE4)) : 0;

  return (
    <Card className="price-history">
      <CardHead
        title={title}
        hint={hint}
        action={
          <span className="price-head-tools">
            {filter}
            <Segmented
              options={RANGES}
              value={range}
              onChange={setRange}
              size="sm"
              name={`range-${title}`}
            />
          </span>
        }
      />

      {line.length > 1 && (
        <div className="price-stats">
          <div className={`price-stat ${change >= 0 ? 'is-up' : 'is-down'}`}>
            <span>Change</span>
            <strong>{changePct === null ? '—' : percent(changePct, { sign: true })}</strong>
            <small>
              {unitPrice(Math.abs(change))} {change >= 0 ? 'up' : 'down'} since{' '}
              {dayLabel(first.asOf)}
            </small>
          </div>
          <div className="price-stat">
            <span>High</span>
            <strong>{unitPrice(high)}</strong>
            <small>over the range</small>
          </div>
          <div className="price-stat">
            <span>Low</span>
            <strong>{unitPrice(low)}</strong>
            <small>over the range</small>
          </div>
        </div>
      )}

      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={`${range}-${reloadOn ?? ''}`}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.14 }}
        >
          <PriceChart
            points={line}
            stroke={change >= 0 ? 'var(--green)' : 'var(--red)'}
            reference={reference}
            referenceLabel={referenceLabel}
          />
        </motion.div>
      </AnimatePresence>

      <div className="price-chart-foot">
        <span style={{ ['--tint' as any]: tint }} className="price-chart-dot" />
        {line.length > 1
          ? `${line.length} trading days · latest ${dayLabel(last.asOf)}`
          : 'Refresh prices to start building this line.'}
        {footnote && <em>{footnote}</em>}
      </div>
    </Card>
  );
}
