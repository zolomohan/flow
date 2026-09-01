import type { Account, Paise, Scaled } from './types';

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
  const abs = Math.abs(paise);
  const body = opts.paise
    ? inrPaise.format(abs / 100)
    : inr.format(Math.round(abs / 100));
  // What is printed, not what was passed: a figure that rounds away to
  // nothing has no sign to carry. "−₹0" is a rounding artifact reading as a
  // debt, and "+₹0" is a gain that didn't happen.
  const shown = opts.paise ? abs : Math.round(abs / 100);
  const prefix = shown === 0 ? '' : paise < 0 ? '−' : opts.sign ? '+' : '';
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

/* ------------------------------------------------------------ arithmetic */

/**
 * Amount fields take sums, not just numbers: a bill is often three things
 * added up, or a rate times a quantity, and doing that in your head before
 * typing is work the app can save you. `1200+350`, `4*249`, `(500+80)/2` and
 * `2x3` all read as what they come to.
 *
 * Hand-parsed rather than handed to `eval`: this is typed input, and a
 * calculator that can only ever return a number is worth thirty lines.
 */
export function evaluateAmount(input: string): number | null {
  // `x` is what people type for "times" — it is never anything else in a
  // field that only holds numbers.
  const text = input.replace(/[xX]/g, '*').replace(/\s+/g, '');
  if (!text) return null;
  let at = 0;

  const number = (): number | null => {
    // Unary sign, so `-500` and `100*-2` both read.
    let sign = 1;
    while (text[at] === '-' || text[at] === '+') {
      if (text[at] === '-') sign = -sign;
      at++;
    }
    if (text[at] === '(') {
      at++;
      const inner = sum();
      if (inner === null || text[at] !== ')') return null;
      at++;
      return sign * inner;
    }
    const start = at;
    while (at < text.length && (text[at] === '.' || (text[at] >= '0' && text[at] <= '9'))) at++;
    if (at === start) return null;
    const value = Number(text.slice(start, at));
    return Number.isFinite(value) ? sign * value : null;
  };

  const product = (): number | null => {
    let value = number();
    if (value === null) return null;
    while (text[at] === '*' || text[at] === '/') {
      const operator = text[at++];
      const next = number();
      if (next === null) return null;
      // Dividing by nothing is a half-typed expression, not an answer.
      if (operator === '/' && next === 0) return null;
      value = operator === '*' ? value * next : value / next;
    }
    return value;
  };

  function sum(): number | null {
    let value = product();
    if (value === null) return null;
    while (text[at] === '+' || text[at] === '-') {
      const operator = text[at++];
      const next = product();
      if (next === null) return null;
      value = operator === '+' ? value + next : value - next;
    }
    return value;
  }

  const value = sum();
  // Anything left over is a typo rather than a sum — `12..5`, `4+`, `(3`.
  return at === text.length && value !== null && Number.isFinite(value) ? value : null;
}

/** What an amount field is allowed to hold while it is being typed. */
export function amountChars(input: string) {
  return input.replace(/[^0-9.+\-*/()xX ]/g, '');
}

/** Whether there is a sum in there, as against a plain number. */
export function isSum(input: string) {
  return /[+*/xX]/.test(input) || /.-/.test(input.trim());
}

/**
 * What a field settles to when it loses focus: the sum worked out, so what
 * stands in the box is what will be saved. A half-typed expression is left
 * exactly as it is rather than being second-guessed.
 */
export function settleAmount(input: string) {
  if (!isSum(input)) return input;
  const value = evaluateAmount(input);
  if (value === null) return input;
  // Money is worth two places; a quantity may want four. Trailing zeros go
  // either way, so `50/2` settles to `25` rather than `25.0000`.
  return String(Number(value.toFixed(4)));
}

/** The running answer, for showing beside a sum as it is typed. */
export function sumPreview(input: string): number | null {
  return isSum(input) ? evaluateAmount(input) : null;
}

export function rupeesToPaise(input: string): Paise {
  const value = evaluateAmount(input);
  if (value === null) return 0;
  return Math.round(value * 100);
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

/** "August" — the month alone, for a header where the year is its own control. */
export function monthName(key: string) {
  const [, m] = key.split('-').map(Number);
  return FULL_MONTHS[m - 1];
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
export function quantity(e4: Scaled, unit: 'g' | 'units' | '' = 'g') {
  const negative = e4 < 0;
  const abs = Math.abs(e4);
  const whole = inr.format(Math.floor(abs / 10_000));
  const frac = String(abs % 10_000).padStart(4, '0').replace(/0+$/, '');
  const body = frac ? `${whole}.${frac}` : whole;
  // An empty unit is for places whose label already says what is being
  // counted, where "142.36 units" only repeats the column heading.
  return `${negative ? '−' : ''}${body}${unit ? ` ${unit}` : ''}`;
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

/**
 * What an account is actually worth: its ledger balance plus whatever the
 * holdings kept in it have grown to. Only an investment account ever differs
 * from its balance — and it differs by the whole of a holding that was never
 * paid for through the ledger.
 */
export function accountWorth(account: Account): Paise {
  return account.balance + account.revaluation;
}

/**
 * How a debt's bar reads: what came back, and what was let go.
 *
 * A settled debt is finished whether or not the money arrived — forgiving
 * the rest is a way of closing it — so the two together always fill the bar
 * once it is settled, and the part nobody paid is shown for what it is.
 */
/**
 * Whether a debt is one line of somebody else's bill, rather than one that
 * wrote its own transfer. Both are carried by a posting; the difference is
 * whose name is on it. A debt entered on the debts screen posts under the
 * counterparty's own name, so a label that matches the person is the debt
 * itself — calling that "Share of Pooja" under a debt with Pooja says
 * nothing, and says it twice.
 */
export function isShareOfBill(debt: {
  fromSplit: boolean;
  counterparty: string;
  transactionLabel: string | null;
}) {
  return debt.fromSplit && debt.transactionLabel?.trim() !== debt.counterparty.trim();
}

export function debtProgress(debt: {
  principal: Paise;
  paid: Paise;
  settled: boolean;
}): { repaid: number; forgiven: number; forgivenAmount: Paise } {
  if (debt.principal <= 0) return { repaid: 0, forgiven: 0, forgivenAmount: 0 };
  const back = Math.min(Math.max(debt.paid, 0), debt.principal);
  const written = debt.settled ? debt.principal - back : 0;
  return {
    repaid: (back / debt.principal) * 100,
    forgiven: (written / debt.principal) * 100,
    forgivenAmount: written,
  };
}
