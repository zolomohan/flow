import type { Paise, Scaled } from './types';

const inr = new Intl.NumberFormat('en-IN', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

const inrPaise = new Intl.NumberFormat('en-IN', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** ₹1,20,450 — whole rupees, Indian digit grouping. */
export function money(paise: Paise, opts: { paise?: boolean; sign?: boolean } = {}) {
  const negative = paise < 0;
  const abs = Math.abs(paise);
  const body = opts.paise
    ? inrPaise.format(abs / 100)
    : inr.format(Math.round(abs / 100));
  const prefix = negative ? '−' : opts.sign ? '+' : '';
  return `${prefix}₹${body}`;
}

/** Splits into parts so the rupee mark and decimals can be styled down. */
export function moneyParts(paise: Paise) {
  const negative = paise < 0;
  const abs = Math.abs(paise);
  const whole = inr.format(Math.floor(abs / 100));
  const cents = String(abs % 100).padStart(2, '0');
  return { negative, symbol: '₹', whole, cents };
}

/** 1.2L / 45.6K / 2.4Cr — for axis ticks and dense chips. */
export function compactMoney(paise: Paise) {
  const rupees = Math.abs(paise) / 100;
  const sign = paise < 0 ? '−' : '';
  if (rupees >= 1e7) return `${sign}₹${trim(rupees / 1e7)}Cr`;
  if (rupees >= 1e5) return `${sign}₹${trim(rupees / 1e5)}L`;
  if (rupees >= 1e3) return `${sign}₹${trim(rupees / 1e3)}K`;
  return `${sign}₹${Math.round(rupees)}`;
}

function trim(n: number) {
  return n >= 100 ? String(Math.round(n)) : n.toFixed(1).replace(/\.0$/, '');
}

export function rupeesToPaise(input: string): Paise {
  const negative = input.trim().startsWith('-');
  const cleaned = input.replace(/[^0-9.]/g, '');
  if (!cleaned) return 0;
  const paise = Math.round(parseFloat(cleaned) * 100);
  return negative ? -paise : paise;
}

export function paiseToRupeeString(paise: Paise): string {
  if (!paise) return '';
  return paise % 100 === 0 ? String(paise / 100) : (paise / 100).toFixed(2);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const FULL_MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export function monthKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function shiftMonth(key: string, delta: number) {
  const [y, m] = key.split('-').map(Number);
  const total = y * 12 + (m - 1) + delta;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
}

export function monthLabel(key: string, full = false) {
  const [y, m] = key.split('-').map(Number);
  const name = (full ? FULL_MONTHS : MONTHS)[m - 1];
  return `${name} ${y}`;
}

export function shortMonthLabel(key: string) {
  const [, m] = key.split('-').map(Number);
  return MONTHS[m - 1];
}

/** "Today", "Yesterday", else "Thu, 14 Aug". */
export function dayLabel(iso: string) {
  const date = new Date(iso);
  const today = new Date();
  const same = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (same(date, today)) return 'Today';
  if (same(date, yesterday)) return 'Yesterday';
  return date.toLocaleDateString('en-IN', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(date.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}),
  });
}

/** "7 Aug" — a date with no weekday, for sitting beside another one. */
export function shortDayLabel(iso: string) {
  const date = new Date(iso);
  const today = new Date();
  return date.toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    ...(date.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}),
  });
}

export function timeLabel(iso: string) {
  return new Date(iso).toLocaleTimeString('en-IN', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

/** Local YYYY-MM-DDTHH:mm, the shape the datetime-local input wants. */
export function toLocalInput(d = new Date()) {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

export function dayKey(iso: string) {
  return iso.slice(0, 10);
}

export function initials(name: string) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

export function percentDelta(now: number, before: number) {
  if (!before) return null;
  return ((now - before) / Math.abs(before)) * 100;
}

/**
 * A scaled quantity as text: `12.5 g`, `142.3671 units`. Trailing zeros go,
 * because gold is bought in tenths of a gram and funds allot to four places —
 * padding both to the same width would only add noise.
 */
export function quantity(e4: Scaled, unit: 'g' | 'units' = 'g') {
  const negative = e4 < 0;
  const abs = Math.abs(e4);
  const whole = inr.format(Math.floor(abs / 10_000));
  const frac = String(abs % 10_000).padStart(4, '0').replace(/0+$/, '');
  const body = frac ? `${whole}.${frac}` : whole;
  return `${negative ? '−' : ''}${body} ${unit}`;
}

/** `+3.2%`, `−1.8%`, `0%` — the same minus sign `money` uses. */
export function percent(value: number, opts: { sign?: boolean } = {}) {
  const rounded = Math.abs(value) < 10 ? Math.round(value * 10) / 10 : Math.round(value);
  const prefix = rounded < 0 ? '−' : opts.sign && rounded > 0 ? '+' : '';
  return `${prefix}${Math.abs(rounded)}%`;
}

/** Rupees per gram or unit, from a scaled price. */
export function unitPrice(e4: Scaled) {
  return `₹${inrPaise.format(e4 / 10_000)}`;
}

/** What a lot worked out to per gram or unit, in paise. */
export function perUnit(amount: Paise, quantityE4: Scaled): Paise {
  if (!quantityE4) return 0;
  return Math.round((amount / quantityE4) * 10_000);
}
