/**
 * A list row that slides sideways to show what can be done to it, the way a
 * row in Mail or Messages does.
 *
 * Swiping left uncovers the actions on the right edge, swiping right the ones
 * on the left. A row left open closes on the next tap anywhere on it, and a
 * long press is its own gesture, handed to `onLongPress` (the ledger reads it
 * as "start selecting, with this one").
 *
 * The row is marked `data-no-swipe`, which is how the drawer knows a sideways
 * drag that starts here is the row's and not the screen's. The left edge still
 * opens the drawer: `lib/drawer` keeps the first 28px for itself.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { animate, motion, useMotionValue } from 'motion/react';
import { Icon } from './Icon';

export type SwipeTone = 'blue' | 'orange' | 'red' | 'purple' | 'green' | 'gray';

export interface SwipeAction {
  icon: string;
  label: string;
  tone: SwipeTone;
  onClick: () => void;
}

/** Each action's width. Wide enough for a glyph over a short word. */
const ACTION_W = 72;
const LONG_PRESS_MS = 450;
const SNAP = { type: 'spring', stiffness: 520, damping: 44 } as const;

/** Only one row is open at a time: opening one closes whichever was. */
let closeOpenRow: (() => void) | null = null;

export function SwipeRow({
  leading = [],
  trailing = [],
  onLongPress,
  disabled,
  children,
}: {
  /** Uncovered by swiping right, nearest the left edge first. */
  leading?: SwipeAction[];
  /** Uncovered by swiping left, nearest the row first. */
  trailing?: SwipeAction[];
  onLongPress?: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  const x = useMotionValue(0);
  const [open, setOpen] = useState<'none' | 'leading' | 'trailing'>('none');
  const [dragging, setDragging] = useState(false);
  const pressTimer = useRef<number | null>(null);
  const pressFrom = useRef<{ x: number; y: number } | null>(null);
  const swallowClick = useRef(false);

  const leadW = leading.length * ACTION_W;
  const trailW = trailing.length * ACTION_W;

  // The registry needs one function per row for the life of the row.
  const closeNow = useRef<() => void>(() => {});
  closeNow.current = () => {
    setOpen('none');
    animate(x, 0, SNAP);
  };
  const close = useRef(() => closeNow.current()).current;

  const settle = (to: 'none' | 'leading' | 'trailing') => {
    setOpen(to);
    animate(x, to === 'leading' ? leadW : to === 'trailing' ? -trailW : 0, SNAP);
    if (to !== 'none') {
      if (closeOpenRow && closeOpenRow !== close) closeOpenRow();
      closeOpenRow = close;
    } else if (closeOpenRow === close) {
      closeOpenRow = null;
    }
  };
  useEffect(() => () => {
    if (closeOpenRow === close) closeOpenRow = null;
    if (pressTimer.current) window.clearTimeout(pressTimer.current);
  }, []);

  const cancelPress = () => {
    if (pressTimer.current) window.clearTimeout(pressTimer.current);
    pressTimer.current = null;
    pressFrom.current = null;
  };

  const run = (action: SwipeAction) => {
    settle('none');
    action.onClick();
  };

  const swipes = !disabled && (leadW > 0 || trailW > 0);

  return (
    <div className={`swipe-row ${open !== 'none' || dragging ? 'is-moving' : ''}`} data-no-swipe>
      {leading.length > 0 && (
        <div className="swipe-actions is-leading" style={{ width: leadW }} aria-hidden={open !== 'leading'}>
          {leading.map((a) => (
            <button
              key={a.label}
              type="button"
              className={`swipe-action tone-${a.tone}`}
              onClick={() => run(a)}
              tabIndex={open === 'leading' ? 0 : -1}
            >
              <Icon name={a.icon} size={19} />
              <span>{a.label}</span>
            </button>
          ))}
        </div>
      )}
      {trailing.length > 0 && (
        <div className="swipe-actions is-trailing" style={{ width: trailW }} aria-hidden={open !== 'trailing'}>
          {trailing.map((a) => (
            <button
              key={a.label}
              type="button"
              className={`swipe-action tone-${a.tone}`}
              onClick={() => run(a)}
              tabIndex={open === 'trailing' ? 0 : -1}
            >
              <Icon name={a.icon} size={19} />
              <span>{a.label}</span>
            </button>
          ))}
        </div>
      )}
      <motion.div
        className="swipe-face"
        style={{ x }}
        drag={swipes ? 'x' : false}
        dragDirectionLock
        dragMomentum={false}
        dragConstraints={{ left: -trailW, right: leadW }}
        dragElastic={0.12}
        onDragStart={() => {
          cancelPress();
          setDragging(true);
        }}
        onDragEnd={(_, info) => {
          setDragging(false);
          swallowClick.current = true;
          window.setTimeout(() => (swallowClick.current = false), 60);
          const at = x.get();
          const fling = info.velocity.x;
          if (at > leadW / 2 || (fling > 500 && at > 0 && leadW)) settle('leading');
          else if (at < -trailW / 2 || (fling < -500 && at < 0 && trailW)) settle('trailing');
          else settle('none');
        }}
        onPointerDown={(e) => {
          if (!onLongPress || e.pointerType === 'mouse') return;
          pressFrom.current = { x: e.clientX, y: e.clientY };
          pressTimer.current = window.setTimeout(() => {
            pressTimer.current = null;
            swallowClick.current = true;
            onLongPress();
          }, LONG_PRESS_MS);
        }}
        onPointerMove={(e) => {
          const from = pressFrom.current;
          if (from && Math.hypot(e.clientX - from.x, e.clientY - from.y) > 8) cancelPress();
        }}
        onPointerUp={() => {
          cancelPress();
          if (swallowClick.current) window.setTimeout(() => (swallowClick.current = false), 60);
        }}
        onPointerCancel={cancelPress}
        onClickCapture={(e) => {
          // An open row's first tap closes it rather than opening the entry,
          // and the tap that ends a drag or a long press is not a tap at all.
          if (swallowClick.current || open !== 'none') {
            e.stopPropagation();
            e.preventDefault();
            if (open !== 'none') settle('none');
          }
        }}
      >
        {children}
      </motion.div>
    </div>
  );
}
