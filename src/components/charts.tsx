import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { compactMoney, money, shortDayLabel, unitPrice } from '../lib/format';
import { spring } from '../lib/motion';
import type { FlowPoint, Paise, PricePoint } from '../lib/types';

/** Catmull-Rom through the points, emitted as cubic beziers. */
function smoothPath(points: [number, number][]) {
  if (points.length < 2) return '';
  let d = `M ${points[0][0]} ${points[0][1]}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] ?? p2;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C ${c1x} ${c1y}, ${c2x} ${c2y}, ${p2[0]} ${p2[1]}`;
  }
  return d;
}

/* --------------------------------------------------------------- Sparkline */

export function Sparkline({
  values, height = 88, stroke = 'var(--blue)', fill = true,
}: { values: number[]; height?: number; stroke?: string; fill?: boolean }) {
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
    if (values.length < 2 || width <= 0) return { line: '', flat: false, area: '' };
    const min = Math.min(...values);
    const max = Math.max(...values);
    const pad = 6;
    // A month with no movement has nothing to plot against: sit the line in
    // the middle rather than pinning it to the floor, where it reads as a
    // stray rule under the card.
    const flat = max === min;
    const span = max - min || 1;
    const points = values.map((v, i) => {
      const x = (i / (values.length - 1)) * width;
      const y = flat
        ? height / 2
        : height - pad - ((v - min) / span) * (height - pad * 2);
      return [x, y] as [number, number];
    });
    const line = smoothPath(points);
    return { line, flat, area: `${line} L ${width} ${height} L 0 ${height} Z` };
  }, [values, width, height]);

  return (
    <div ref={host} className="sparkline-host" style={{ height }}>
      {path.line && (
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
              animate={{ opacity: 1 }}
              transition={{ duration: 0.5, delay: 0.25 }}
            />
          )}
          <motion.path
            d={path.line}
            fill="none"
            stroke={stroke}
            strokeWidth={2.25}
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity={path.flat ? 0.28 : 1}
            initial={{ pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={{ duration: 0.9, ease: [0.4, 0, 0.2, 1] }}
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
 */
export function PriceChart({
  points, height = 240, stroke = 'var(--violet)', reference, referenceLabel,
}: {
  points: PricePoint[];
  height?: number;
  stroke?: string;
  /** A scaled price to mark with a dashed rule — a fund's average cost. */
  reference?: number | null;
  referenceLabel?: string;
}) {
  const gradientId = useId();
  const host = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<number | null>(null);

  useLayoutEffect(() => {
    const node = host.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(node);
    setWidth(node.clientWidth);
    return () => observer.disconnect();
  }, []);

  // Room on the right for the axis labels, and a little top and bottom so the
  // high and the low don't sit flush against the frame.
  const gutter = 52;
  const pad = 14;
  const plot = Math.max(0, width - gutter);

  const shape = useMemo(() => {
    if (points.length < 2 || plot <= 0) return null;
    const values = points.map((p) => p.priceE4);
    const low = Math.min(...values);
    const high = Math.max(...values);
    // A line that never moved still deserves to sit in the middle rather than
    // on the floor, so a flat run is given a nominal span.
    const span = high - low || Math.max(1, high * 0.02);
    const floor = high === low ? high - span / 2 : low;
    const y = (value: number) =>
      height - pad - ((value - floor) / span) * (height - pad * 2);
    const x = (i: number) => (i / (points.length - 1)) * plot;
    const coords = points.map((p, i) => [x(i), y(p.priceE4)] as [number, number]);
    const line = smoothPath(coords);
    return {
      line,
      area: `${line} L ${plot} ${height} L 0 ${height} Z`,
      coords,
      low,
      high,
      lowAt: values.indexOf(low),
      highAt: values.indexOf(high),
      y,
      floor,
      span,
    };
  }, [points, plot, height]);

  if (!shape) {
    return (
      <div className="price-chart-empty" style={{ height }}>
        <span>Not enough price history yet — refresh prices and it fills in.</span>
      </div>
    );
  }

  // Axis labels follow the range rather than the number: a NAV moving between
  // ₹87.20 and ₹88.40 needs its paise, a gold rate in the thousands does not.
  const tickLabel = (e4: number) => {
    const rupees = e4 / 10_000;
    const spread = shape.span / 10_000;
    const places = spread < 20 ? 2 : spread < 200 ? 1 : 0;
    return `₹${rupees.toLocaleString('en-IN', {
      minimumFractionDigits: places,
      maximumFractionDigits: places,
    })}`;
  };

  const at = hover ?? points.length - 1;
  const active = points[at];
  const [activeX, activeY] = shape.coords[at];
  // Four rules across the range, labelled in rupees on the right.
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => shape.floor + shape.span * t);
  const refY =
    reference != null && reference > 0 ? shape.y(reference) : null;

  return (
    <div className="price-chart" ref={host} style={{ height }}>
      <svg
        width={width}
        height={height}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          const ratio = (event.clientX - box.left) / (plot || 1);
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
              {tickLabel(value)}
            </text>
          </g>
        ))}

        {refY !== null && refY > 0 && refY < height && (
          <g>
            <line
              className="price-reference"
              x1={0}
              x2={plot}
              y1={refY}
              y2={refY}
            />
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
        style={{
          left: Math.min(Math.max(activeX, 0), Math.max(0, plot - 96)),
        }}
      >
        <strong>{unitPrice(active.priceE4)}</strong>
        <span>{shortDayLabel(active.asOf)}</span>
      </div>
    </div>
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
  slices, size = 188, thickness = 22, centerLabel, centerValue,
}: {
  slices: DonutSlice[];
  size?: number;
  thickness?: number;
  centerLabel?: string;
  centerValue?: string;
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

/* --------------------------------------------------------------- DailyBars */

/** One slim column per bucket, for the “how spiky was it” read. */
export function DailyBars({
  points, height = 64, labelOf,
}: {
  points: FlowPoint[];
  height?: number;
  /** How a bucket reads in the tooltip. Days speak for themselves. */
  labelOf?: (bucket: string) => string;
}) {
  const peak = Math.max(1, ...points.map((p) => p.expense));
  const today = new Date().toISOString().slice(0, 10);
  return (
    <div className="daily" style={{ height }}>
      {points.map((point, i) => (
        <motion.span
          key={point.bucket}
          className={`daily-bar ${point.bucket === today ? 'is-today' : ''}`}
          title={`${labelOf ? labelOf(point.bucket) : point.bucket} · ${money(point.expense)}`}
          initial={{ height: 2 }}
          animate={{ height: `${Math.max(2, (point.expense / peak) * 100)}%` }}
          transition={{ duration: 0.5, delay: 0.008 * i, ease: [0.06, 0.94, 0.67, 1.01] }}
        />
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
