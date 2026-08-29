import { useEffect, useRef, useState } from 'react';
import { animate } from 'motion/react';
import { money, moneyParts } from '../lib/format';
import type { Paise } from '../lib/types';

/** Counts from the previous value to the next one whenever the amount changes. */
function useCountUp(value: number, duration = 0.7) {
  const [display, setDisplay] = useState(value);
  const previous = useRef(value);

  useEffect(() => {
    const from = previous.current;
    previous.current = value;
    if (from === value) return;
    const controls = animate(from, value, {
      duration,
      ease: [0.06, 0.94, 0.67, 1.01],
      onUpdate: (v) => setDisplay(v),
    });
    return () => controls.stop();
  }, [value, duration]);

  return display;
}

/** Big hero figure: rupee mark and paise set smaller than the rupees. */
export function BigMoney({
  value, animated = true, className = '',
}: { value: Paise; animated?: boolean; className?: string }) {
  const live = useCountUp(animated ? value : value);
  const parts = moneyParts(Math.round(animated ? live : value));
  return (
    <span className={`big-money ${className}`}>
      {parts.negative && <span className="big-money-sign">−</span>}
      <span className="big-money-symbol">{parts.symbol}</span>
      <span className="big-money-whole">{parts.whole}</span>
      <span className="big-money-cents">.{parts.cents}</span>
    </span>
  );
}

/**
 * Inline amount that counts to its new value. The flow figures swing hard when
 * the window changes from a month to a year, and the jump reads better rolled.
 */
export function CountMoney({ value, className = '' }: { value: Paise; className?: string }) {
  const live = useCountUp(value);
  return <span className={className}>{money(Math.round(live))}</span>;
}

/** Inline amount, tinted by the direction money moved. */
export function Amount({
  value, kind, showSign = true, className = '',
}: {
  value: Paise;
  kind?: 'income' | 'expense' | 'transfer';
  showSign?: boolean;
  className?: string;
}) {
  const signed =
    kind === 'income' ? value : kind === 'expense' ? -value : value;
  const text =
    kind === 'transfer' || !showSign
      ? money(value)
      : money(Math.abs(signed), { sign: signed > 0 });
  return (
    <span className={`amount amount-${kind ?? 'neutral'} ${className}`}>
      {kind === 'expense' && showSign ? `−${money(value)}` : text}
    </span>
  );
}
