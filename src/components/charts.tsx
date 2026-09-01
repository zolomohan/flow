import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { compactMoney, dayLabel, money, shortDayLabel, unitPrice } from '../lib/format';
import { spring } from '../lib/motion';
import type { FlowPoint, Paise, ValuePoint } from '../lib/types';

/**
 * What the numbers on a line mean: a per-gram or per-unit price, scaled by
 * 10^4, or money in paise. It decides how the axis and the readout are
 * written and nothing else — the shape of the line is the same either way.
 */
export type SeriesKind = 'price' | 'money';

/** The readout above the crosshair: exact, whatever the kind. */
function readValue(kind: SeriesKind, value: number) {
  return kind === 'money' ? money(value) : unitPrice(value);
}

/**
 * The axis, which has less room and more to say. Money goes compact; a price
 * follows its own range, since a NAV moving between ₹87.20 and ₹88.40 needs
 * its paise where a gold rate in the thousands does not.
 */
function readTick(kind: SeriesKind, value: number, span: number) {
  if (kind === 'money') return compactMoney(value);
  const spread = span / 10_000;
  const places = spread < 20 ? 2 : spread < 200 ? 1 : 0;
  return `₹${(value / 10_000).toLocaleString('en-IN', {
    minimumFractionDigits: places,
    maximumFractionDigits: places,
  })}`;
}

/** Two decimals is finer than a pixel, and it keeps the path a plain list of
 *  numbers — an unrounded coordinate can come out as `1e-7`, which nothing
 *  tweening one path into another knows how to read. */
const round = (n: number) => Math.round(n * 100) / 100;

/** Catmull-Rom through the points, emitted as cubic beziers. */
function smoothPath(points: [number, number][]) {
  if (points.length < 2) return '';
  let d = `M ${round(points[0][0])} ${round(points[0][1])}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] ?? p2;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C ${round(c1x)} ${round(c1y)}, ${round(c2x)} ${round(c2y)}, ${round(p2[0])} ${round(p2[1])}`;
  }
  return d;
}

/**
 * How many stations a morphing line is read at. One path can only be tweened
 * into another when the two are made of the same run of commands, and a month
 * has 31 readings where a year has 365 — so a line that morphs is sampled at
 * a fixed count instead, whatever it was measured at. Sixty-four is more
 * points than a sparkline this size can show apart.
 */
const MORPH_POINTS = 64;

/** How one shape settles into the next. Shorter than the draw-in: nothing is
 *  being revealed, only moved. */
const MORPH = { duration: 0.55, ease: [0.4, 0, 0.2, 1] } as const;

/** A series read at `count` evenly spaced stations, straight between the
 *  readings it actually has. */
function resample(values: number[], count: number) {
  if (values.length < 2 || values.length === count) return values;
  const last = values.length - 1;
  return Array.from({ length: count }, (_, i) => {
    const at = (i / (count - 1)) * last;
    const low = Math.floor(at);
    const high = Math.min(low + 1, last);
    return values[low] + (values[high] - values[low]) * (at - low);
  });
}

/* --------------------------------------------------------------- Sparkline */

/* ------------------------------------------------------------- Skeleton */

/** A placeholder wave, in the same proportions any line here ends up. */
const SKELETON_PATH = 'M 0 30 C 10 14, 18 33, 30 23 S 48 6, 62 17 S 82 7, 100 12';

/**
 * What a chart shows while its numbers are still on their way. A chart that
 * is only waiting used to print the line it keeps for having nothing to draw
 * — "not enough history yet" — which reads as an answer rather than a pause.
 * The trace runs until the real one replaces it.
 */
export function ChartSkeleton({ height = 240 }: { height?: number }) {
  return (
    <div className="chart-skeleton" style={{ height }} aria-hidden>
      <svg viewBox="0 0 100 40" preserveAspectRatio="none">
        {/* `pathLength` normalises the dash to the path itself, so the trace
            runs at the same pace whatever the chart is stretched to. */}
        <path d={SKELETON_PATH} pathLength={100} />
      </svg>
    </div>
  );
}

/* ------------------------------------------------------------ Sparkline */

export function Sparkline({
  values, height = 88, stroke = 'var(--blue)', fill = true, morph = false, loading = false,
}: {
  values: number[];
  height?: number;
  stroke?: string;
  fill?: boolean;
  /** Whether the numbers are still coming, which is a different silence from
   *  having none: one traces, the other draws nothing. */
  loading?: boolean;
  /**
   * Whether a new series bends the line it finds into shape rather than
   * replacing it. Off by default: it costs the line its own readings, which
   * is only worth paying where the series is swapped under a standing chart.
   */
  morph?: boolean;
}) {
  const gradientId = useId();
  const host = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  // The path is built in real pixels rather than a stretched viewBox: a
  // non-uniform scale would make `pathLength` (user units) and the stroke
  // dash (screen units) disagree, and the draw-in would stop short.
  useLayoutEffect(() => {
    const node = host.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(node);
    setWidth(node.clientWidth);
    return () => observer.disconnect();
  }, []);

  const path = useMemo(() => {
    const read = morph ? resample(values, MORPH_POINTS) : values;
    if (read.length < 2 || width <= 0) return { line: '', flat: false, area: '' };
    const min = Math.min(...read);
    const max = Math.max(...read);
    const pad = 6;
    // A month with no movement has nothing to plot against: sit the line in
    // the middle rather than pinning it to the floor, where it reads as a
    // stray rule under the card.
    const flat = max === min;
    const span = max - min || 1;
    const points = read.map((v, i) => {
      const x = (i / (read.length - 1)) * width;
      const y = flat
        ? height / 2
        : height - pad - ((v - min) / span) * (height - pad * 2);
      return [x, y] as [number, number];
    });
    const line = smoothPath(points);
    return {
      line,
      flat,
      area: `${line} L ${round(width)} ${round(height)} L 0 ${round(height)} Z`,
    };
  }, [values, width, height, morph]);

  return (
    <div ref={host} className="sparkline-host" style={{ height }}>
      {loading && <ChartSkeleton height={height} />}
      {!loading && path.line && (
        <svg className="sparkline" width={width} height={height}>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={stroke} stopOpacity="0.22" />
              <stop offset="100%" stopColor={stroke} stopOpacity="0" />
            </linearGradient>
          </defs>
          {fill && !path.flat && (
            <motion.path
              d={path.area}
              fill={`url(#${gradientId})`}
              initial={{ opacity: 0 }}
              animate={morph ? { opacity: 1, d: path.area } : { opacity: 1 }}
              transition={{ opacity: { duration: 0.5, delay: 0.25 }, d: MORPH }}
            />
          )}
          {/* The line is drawn in once, on arrival. After that a new series
              bends this one into its shape — starting the stroke over would
              read as a different chart rather than the same one, moved. */}
          <motion.path
            d={path.line}
            fill="none"
            stroke={stroke}
            strokeWidth={2.25}
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity={path.flat ? 0.28 : 1}
            initial={{ pathLength: 0 }}
            animate={morph ? { pathLength: 1, d: path.line } : { pathLength: 1 }}
            transition={{
              pathLength: { duration: 0.9, ease: [0.4, 0, 0.2, 1] },
              d: MORPH,
            }}
          />
        </svg>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ PriceChart */

/**
 * A price line with a readable y-axis and a crosshair that follows the
 * pointer. Days are plotted evenly rather than by calendar distance: a NAV is
 * only published on business days, and spacing the gaps would leave the line
 * limping across every long weekend for no information gained.
 *
 * The measuring is split from the drawing on purpose. The host below is
 * rendered whatever happens, so the observer always has something to watch —
 * hand the width back to a chart that only renders once it has one and the
 * two wait on each other for ever.
 */
export function PriceChart({
  points, height = 240, stroke = 'var(--violet)', kind = 'price', reference, referenceLabel,
  loading = false,
}: {
  points: ValuePoint[];
  height?: number;
  stroke?: string;
  kind?: SeriesKind;
  /** A figure to mark with a dashed rule, in the points' own units — a
   *  fund's average cost against its NAV. */
  reference?: number | null;
  referenceLabel?: string;
  /** Whether the series is still being read, rather than known to be short. */
  loading?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const node = host.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(node);
    setWidth(node.clientWidth);
    return () => observer.disconnect();
  }, []);

  const ready = width > 0 && points.length > 1;
  return (
    <div
      className={`price-chart ${ready ? '' : loading ? 'is-waiting' : 'is-empty'}`}
      ref={host}
      style={{ height }}
    >
      {ready ? (
        <PriceLine
          points={points}
          width={width}
          height={height}
          stroke={stroke}
          kind={kind}
          reference={reference}
          referenceLabel={referenceLabel}
        />
      ) : loading ? (
        <ChartSkeleton height={height} />
      ) : (
        width > 0 && (
          <span className="price-chart-empty">
            Not enough price history yet — refresh prices and it fills in.
          </span>
        )
      )}
    </div>
  );
}

function PriceLine({
  points, width, height, stroke, kind, reference, referenceLabel,
}: {
  points: ValuePoint[];
  width: number;
  height: number;
  stroke: string;
  kind: SeriesKind;
  reference?: number | null;
  referenceLabel?: string;
}) {
  const gradientId = useId();
  const [hover, setHover] = useState<number | null>(null);

  // Room on the right for the axis labels, and a little top and bottom so the
  // high and the low don't sit flush against the frame.
  const gutter = 52;
  const pad = 14;
  const plot = Math.max(1, width - gutter);

  const shape = useMemo(() => {
    const values = points.map((p) => p.value);
    const low = Math.min(...values);
    const high = Math.max(...values);
    // A line that never moved still deserves to sit in the middle rather than
    // on the floor, so a flat run is given a nominal span.
    const span = high - low || Math.max(1, high * 0.02);
    const floor = high === low ? high - span / 2 : low;
    const y = (value: number) =>
      height - pad - ((value - floor) / span) * (height - pad * 2);
    const x = (i: number) => (i / (points.length - 1)) * plot;
    const coords = points.map((p, i) => [x(i), y(p.value)] as [number, number]);
    const line = smoothPath(coords);
    return {
      line,
      area: `${line} L ${plot} ${height} L 0 ${height} Z`,
      coords,
      lowAt: values.indexOf(low),
      highAt: values.indexOf(high),
      y,
      floor,
      span,
    };
  }, [points, plot, height]);

  const at = Math.min(hover ?? points.length - 1, points.length - 1);
  const active = points[at];
  const [activeX, activeY] = shape.coords[at];
  // Five rules across the range, labelled in rupees on the right.
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => shape.floor + shape.span * t);
  const refY = reference != null && reference > 0 ? shape.y(reference) : null;

  return (
    <>
      <svg
        width={width}
        height={height}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          const ratio = (event.clientX - box.left) / plot;
          const index = Math.round(ratio * (points.length - 1));
          setHover(Math.max(0, Math.min(points.length - 1, index)));
        }}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={stroke} stopOpacity="0.2" />
            <stop offset="100%" stopColor={stroke} stopOpacity="0" />
          </linearGradient>
        </defs>

        {ticks.map((value, i) => (
          <g key={i}>
            <line
              className="price-rule"
              x1={0}
              x2={plot}
              y1={shape.y(value)}
              y2={shape.y(value)}
            />
            <text className="price-tick" x={plot + 8} y={shape.y(value) + 4}>
              {readTick(kind, value, shape.span)}
            </text>
          </g>
        ))}

        {refY !== null && refY > 0 && refY < height && (
          <g>
            <line className="price-reference" x1={0} x2={plot} y1={refY} y2={refY} />
            {referenceLabel && (
              <text className="price-reference-label" x={4} y={refY - 6}>
                {referenceLabel}
              </text>
            )}
          </g>
        )}

        <motion.path
          d={shape.area}
          fill={`url(#${gradientId})`}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.5, delay: 0.2 }}
        />
        <motion.path
          d={shape.line}
          fill="none"
          stroke={stroke}
          strokeWidth={2.25}
          strokeLinecap="round"
          strokeLinejoin="round"
          initial={{ pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: 0.9, ease: [0.4, 0, 0.2, 1] }}
        />

        {/* The high and the low, which is what anyone reads a price line for
            before they read any single day of it. */}
        {[shape.highAt, shape.lowAt].map((index, i) => (
          <circle
            key={i}
            className="price-extreme"
            cx={shape.coords[index][0]}
            cy={shape.coords[index][1]}
            r={2.5}
            style={{ fill: stroke }}
          />
        ))}

        <line
          className="price-crosshair"
          x1={activeX}
          x2={activeX}
          y1={0}
          y2={height}
          opacity={hover === null ? 0 : 1}
        />
        <circle className="price-dot" cx={activeX} cy={activeY} r={4} style={{ fill: stroke }} />
      </svg>

      <div
        className="price-readout"
        style={{ left: Math.min(Math.max(activeX, 0), Math.max(0, plot - 96)) }}
      >
        <strong>{readValue(kind, active.value)}</strong>
        <span>{shortDayLabel(active.asOf)}</span>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------- Donut */

export interface DonutSlice {
  id: string;
  label: string;
  value: number;
  color: string;
}

export function Donut({
  slices, size = 188, thickness = 22, centerLabel, centerValue, onSelect,
}: {
  slices: DonutSlice[];
  size?: number;
  thickness?: number;
  centerLabel?: string;
  centerValue?: string;
  /** Clicking an arc, when it leads somewhere. */
  onSelect?: (id: string) => void;
  }) {
  const [hover, setHover] = useState<string | null>(null);
  const total = slices.reduce((sum, s) => sum + s.value, 0);
  const radius = (size - thickness) / 2;
  const circumference = 2 * Math.PI * radius;
  const gap = slices.length > 1 ? 2.5 : 0;

  let offset = 0;
  const arcs = slices.map((slice) => {
    const fraction = total ? slice.value / total : 0;
    const length = Math.max(0, fraction * circumference - gap);
    const arc = { ...slice, length, offset, fraction };
    offset += fraction * circumference;
    return arc;
  });

  const active = arcs.find((a) => a.id === hover);

  return (
    <div className="donut" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke="var(--surface-inset)"
            strokeWidth={thickness}
          />
          {arcs.map((arc, i) => (
            <motion.circle
              key={arc.id}
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              stroke={arc.color}
              strokeWidth={hover === arc.id ? thickness + 5 : thickness}
              strokeLinecap="round"
              strokeDasharray={`${arc.length} ${circumference}`}
              strokeDashoffset={-arc.offset}
              initial={{ opacity: 0, strokeDasharray: `0 ${circumference}` }}
              animate={{
                opacity: hover && hover !== arc.id ? 0.32 : 1,
                strokeDasharray: `${arc.length} ${circumference}`,
              }}
              transition={{
                strokeDasharray: { duration: 0.75, delay: 0.06 * i, ease: [0.4, 0, 0.2, 1] },
                opacity: { duration: 0.18 },
                strokeWidth: { duration: 0.18 },
              }}
              onMouseEnter={() => setHover(arc.id)}
              onMouseLeave={() => setHover(null)}
              onClick={onSelect ? () => onSelect(arc.id) : undefined}
              style={{ cursor: 'pointer' }}
            />
          ))}
        </g>
      </svg>
      <div className="donut-center">
        <AnimatePresence mode="wait">
          <motion.div
            key={active?.id ?? 'total'}
            initial={{ opacity: 0, y: 5 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -5 }}
            transition={{ duration: 0.15 }}
          >
            <span className="donut-label">{active ? active.label : centerLabel}</span>
            <span className="donut-value">
              {active ? money(active.value) : centerValue}
            </span>
            {active && (
              <span className="donut-pct">
                {Math.round(active.fraction * 100)}% of spend
              </span>
            )}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- FlowBars */

/** Paired income/expense columns with a hover readout. */
export function FlowBars({
  points, height = 190, labelOf,
}: {
  points: FlowPoint[];
  height?: number;
  labelOf: (bucket: string) => string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const peak = Math.max(
    1,
    ...points.map((p) => Math.max(p.income, p.expense)),
  );

  return (
    <div className="flow">
      <div className="flow-grid" style={{ height }}>
        {[1, 0.75, 0.5, 0.25, 0].map((t) => (
          <div key={t} className="flow-line" style={{ bottom: `${t * 100}%` }}>
            <span>{compactMoney(peak * t)}</span>
          </div>
        ))}
        <div className="flow-bars">
          {points.map((point, i) => (
            <div
              key={point.bucket}
              className={`flow-col ${hover === i ? 'is-hover' : ''}`}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
            >
              <div className="flow-pair">
                <motion.span
                  className="flow-bar flow-bar-in"
                  initial={{ height: 0 }}
                  animate={{ height: `${(point.income / peak) * 100}%` }}
                  transition={{ duration: 0.6, delay: 0.03 * i, ease: [0.06, 0.94, 0.67, 1.01] }}
                />
                <motion.span
                  className="flow-bar flow-bar-out"
                  initial={{ height: 0 }}
                  animate={{ height: `${(point.expense / peak) * 100}%` }}
                  transition={{ duration: 0.6, delay: 0.03 * i + 0.05, ease: [0.06, 0.94, 0.67, 1.01] }}
                />
              </div>
              <AnimatePresence>
                {hover === i && (
                  <motion.div
                    className="flow-tip"
                    initial={{ opacity: 0, y: 6, scale: 0.96 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: 4, scale: 0.97 }}
                    transition={spring}
                  >
                    <strong>{labelOf(point.bucket)}</strong>
                    <span className="tip-row">
                      <i style={{ background: 'var(--green)' }} />
                      In {money(point.income)}
                    </span>
                    <span className="tip-row">
                      <i style={{ background: 'var(--ink-3)' }} />
                      Out {money(point.expense)}
                    </span>
                    <span className="tip-net">
                      Net {money(point.income - point.expense, { sign: point.income >= point.expense })}
                    </span>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          ))}
        </div>
      </div>
      <div className="flow-axis">
        {points.map((point, i) => (
          <span key={point.bucket} className={hover === i ? 'is-hover' : ''}>
            {labelOf(point.bucket)}
          </span>
        ))}
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- SpendBars */

/** One bucket of spending: whatever it is called, and what went out in it. */
export interface SpendPoint {
  bucket: string;
  value: Paise;
}

/**
 * One bar per bucket, for the only question a card really asks: how much was
 * put on it, and when. A single series on purpose — money in and money out is
 * the language of a bank account, and a card only ever runs one way.
 */
export function SpendBars({
  points, height = 180, labelOf, color = 'var(--ink-3)', openLast = false,
}: {
  points: SpendPoint[];
  height?: number;
  labelOf: (bucket: string) => string;
  /** The bars' colour — a card's own, where the chart belongs to one card. */
  color?: string;
  /** Whether the last bucket is still running, and so still filling up. */
  openLast?: boolean;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const peak = Math.max(1, ...points.map((p) => p.value));

  return (
    <div className="flow flow-one">
      <div className="flow-grid" style={{ height }}>
        {[1, 0.75, 0.5, 0.25, 0].map((t) => (
          <div key={t} className="flow-line" style={{ bottom: `${t * 100}%` }}>
            <span>{compactMoney(peak * t)}</span>
          </div>
        ))}
        <div className="flow-bars">
          {points.map((point, i) => {
            const running = openLast && i === points.length - 1;
            return (
              <div
                key={point.bucket}
                className={`flow-col ${hover === i ? 'is-hover' : ''}`}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
              >
                <div className="flow-pair">
                  <motion.span
                    className={`flow-bar flow-bar-spend ${running ? 'is-running' : ''}`}
                    style={{ ['--bar' as any]: color }}
                    initial={{ height: 0 }}
                    animate={{ height: `${(point.value / peak) * 100}%` }}
                    transition={{ duration: 0.6, delay: 0.03 * i, ease: [0.06, 0.94, 0.67, 1.01] }}
                  />
                </div>
                <AnimatePresence>
                  {hover === i && (
                    <motion.div
                      className="flow-tip"
                      initial={{ opacity: 0, y: 6, scale: 0.96 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: 4, scale: 0.97 }}
                      transition={spring}
                    >
                      <strong>{labelOf(point.bucket)}</strong>
                      <span className="tip-figure">{money(point.value)}</span>
                      {running && <span className="tip-note">still running</span>}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            );
          })}
        </div>
      </div>
      <div className="flow-axis">
        {points.map((point, i) => (
          <span key={point.bucket} className={hover === i ? 'is-hover' : ''}>
            {labelOf(point.bucket)}
          </span>
        ))}
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- DailyBars */

/** One slim column per bucket, for the “how spiky was it” read. */
export function DailyBars({
  points, height = 64, labelOf,
}: {
  points: FlowPoint[];
  height?: number;
  /** How a bucket reads in the readout. Days speak for themselves. */
  labelOf?: (bucket: string) => string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const peak = Math.max(1, ...points.map((p) => p.expense));
  const today = new Date().toISOString().slice(0, 10);
  const read = (bucket: string) => (labelOf ? labelOf(bucket) : dayLabel(bucket));
  return (
    <div className="daily" style={{ height }}>
      {points.map((point, i) => (
        // The whole column takes the pointer, not the bar: on a quiet day the
        // bar is two pixels tall, and nobody can hover that.
        <div
          key={point.bucket}
          className={`daily-col ${hover === i ? 'is-hover' : ''}`}
          onMouseEnter={() => setHover(i)}
          onMouseLeave={() => setHover(null)}
        >
          <motion.span
            className={`daily-bar ${point.bucket === today ? 'is-today' : ''}`}
            initial={{ height: 2 }}
            animate={{ height: `${Math.max(2, (point.expense / peak) * 100)}%` }}
            transition={{ duration: 0.5, delay: 0.008 * i, ease: [0.06, 0.94, 0.67, 1.01] }}
          />
          <AnimatePresence>
            {hover === i && (
              // The readout is centred on its column, except at the ends,
              // where it would hang off the card and be clipped by it.
              <motion.div
                className={`flow-tip daily-tip ${
                  i < 2 ? 'is-start' : i > points.length - 3 ? 'is-end' : ''
                }`}
                initial={{ opacity: 0, y: 6, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 4, scale: 0.97 }}
                transition={spring}
              >
                <strong>{read(point.bucket)}</strong>
                <span className="tip-figure">{money(point.expense)}</span>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      ))}
    </div>
  );
}

/** Two-tone bar showing the in/out split of a single period. */
export function SplitBar({ income, expense }: { income: Paise; expense: Paise }) {
  const total = income + expense || 1;
  return (
    <div className="split">
      <motion.span
        className="split-in"
        initial={{ width: 0 }}
        animate={{ width: `${(income / total) * 100}%` }}
        transition={{ duration: 0.7, ease: [0.06, 0.94, 0.67, 1.01] }}
      />
      <motion.span
        className="split-out"
        initial={{ width: 0 }}
        animate={{ width: `${(expense / total) * 100}%` }}
        transition={{ duration: 0.7, delay: 0.07, ease: [0.06, 0.94, 0.67, 1.01] }}
      />
    </div>
  );
}
