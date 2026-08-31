import { useState } from 'react';
import { Icon } from './Icon';
import { merchantLogo } from '../lib/merchants';

/**
 * The square at the head of a posting: the payee's own logo when we have
 * one, and the category's glyph when we don't.
 *
 * A logo is drawn on a plain light chip rather than the category's tint,
 * because a brand mark is coloured already and a second colour behind it
 * only muddies both. The glyph keeps the tint, so the two kinds of row
 * still line up down the left edge of the ledger.
 */
export function MerchantLogo({
  merchant, icon, tint, size = 36, glyphSize = 17, className = '',
}: {
  /** The payee as the posting names it. */
  merchant: string | null | undefined;
  /** What to draw when there is no logo — the category's icon, usually. */
  icon: string;
  /** The colour the fallback glyph wears. */
  tint: string;
  size?: number;
  glyphSize?: number;
  className?: string;
}) {
  // A logo that fails to load falls back for the rest of the session, so a
  // missing file leaves a glyph rather than a broken picture.
  const [broken, setBroken] = useState(false);
  const src = broken ? null : merchantLogo(merchant);

  return (
    <span
      className={`tx-avatar ${src ? 'is-logo' : ''} ${className}`.trim()}
      style={{ ['--tint' as any]: tint, width: size, height: size }}
    >
      {src ? (
        <img src={src} alt="" loading="lazy" draggable={false} onError={() => setBroken(true)} />
      ) : (
        <Icon name={icon} size={glyphSize} strokeWidth={2.05} />
      )}
    </span>
  );
}
