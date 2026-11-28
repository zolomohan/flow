/**
 * The phone's drawer, and the back swipe that shares the left edge with it.
 *
 * The shape is drivea's instructor app: an under-drawer. The sidebar is the
 * layer *below*, and the screen slides off it to the right — rounding the
 * corners it leaves by — rather than a panel sliding in over the screen.
 * Nothing dims; the screen's edge and the shadow it casts are what separate
 * the two.
 *
 * There is no button. A sideways swipe right from anywhere on the screen
 * brings it out, and a swipe left (or a tap on the screen's exposed edge)
 * puts it away. The very left edge is kept for back whenever there is
 * somewhere to go back to — iOS draws that line in the same place — and is
 * the drawer's like everywhere else when there is not.
 *
 * Both gestures are driven from motion values rather than state: the screen,
 * the panel and the shade move together on every frame of a drag, and a
 * render per frame would be the whole shell redrawn to follow a thumb.
 */

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { animate, motionValue, type MotionValue, type Transition } from 'motion/react';

/** How far the screen slides right, and the width of the panel behind it.
 *  Must agree with `.phone-drawer` in `mobile.css`. */
export const DRAWER_WIDTH = Math.min(320, window.innerWidth * 0.8);

/** The leading corners the screen rounds off to as it comes away. */
export const DRAWER_RADIUS = 32;

/** Quick, and barely any overshoot — a panel, not a toy. */
export const DRAWER_SPRING: Transition = { type: 'spring', stiffness: 220, damping: 22, mass: 0.7 };

/** Past this fraction of the way out, letting go settles open. */
const OPEN_THRESHOLD = 0.5;
/** Thrown this fast, the direction decides rather than the distance. */
const FLING_VELOCITY = 400;

/** The drag has to be clearly sideways before it is the drawer's. Below these
 *  it belongs to whatever is underneath — a list that scrolls, a row of chips. */
const CLAIM_X = 24;
const CLAIM_Y = 16;

/** How far in from the left a drag may start and still be the drawer's even
 *  over something with swipes of its own (`data-no-swipe`). */
const EDGE_CLAIM = 28;

/** How far in from the left edge a drag has to start to be the back swipe. */
const BACK_EDGE = 28;
/** A drag that starts at the edge and goes right has nothing else it could be. */
const BACK_CLAIM = 12;
const BACK_DRIFT = 16;
/** Past this much of the way across, letting go goes back. */
const BACK_THRESHOLD = 0.32;
const BACK_FLING = 450;
const BACK_SPRING: Transition = { type: 'spring', stiffness: 320, damping: 38, mass: 0.9 };

/** How long after a claimed drag the click WebKit sends on release is still
 *  that drag's own, and swallowed. A deadline rather than a flag: a drag
 *  often ends with no click at all, and a flag would eat the next real tap. */
const SWALLOW_WINDOW = 250;

/** 0 shut, 1 open. */
export const drawerProgress: MotionValue<number> = motionValue(0);
/** 0 the page where it was, 1 dragged fully off the right edge. */
export const backProgress: MotionValue<number> = motionValue(0);
/** The page's opacity, which hides the hand-over at the end of a back swipe:
 *  the page leaving is already off-screen, and the one arriving fades in. */
export const backFade: MotionValue<number> = motionValue(1);

/** Anything the person is typing into, or a sheet over the page, keeps its
 *  touches: neither gesture means anything there. */
const IGNORE = 'input, textarea, select, [contenteditable], .sheet, .scrim, .palette';

export function useDrawer({
  page,
  enabled,
  canBack,
  onBack,
}: {
  /** The page, whose width the back swipe travels. */
  page: RefObject<HTMLElement | null>;
  enabled: boolean;
  canBack: boolean;
  onBack: () => void;
}) {
  const [open, setOpenState] = useState(false);
  const openNow = useRef(false);

  const setOpen = useCallback((next: boolean) => {
    openNow.current = next;
    setOpenState(next);
    animate(drawerProgress, next ? 1 : 0, DRAWER_SPRING);
  }, []);

  // Read from listeners bound once.
  const back = useRef({ canBack, onBack });
  back.current = { canBack, onBack };

  // The drawer belongs to the phone layout: widening past it shuts it.
  useEffect(() => {
    if (!enabled && openNow.current) setOpen(false);
  }, [enabled, setOpen]);

  /* Read from the window rather than the shell: the shell is not there on
     the first render (the boot screen is), and a listener bound to a ref that
     was still empty when the effect ran is never bound at all. */
  useEffect(() => {
    if (!enabled) return;
    const node = window;

    type Mode = 'drawer' | 'back';
    let pointer: number | null = null;
    let mode: Mode = 'drawer';
    let startX = 0;
    let startY = 0;
    let from = 0;
    let width = window.innerWidth;
    let claimed = false;
    let lastX = 0;
    let lastAt = 0;
    let velocity = 0;
    let swallowUntil = 0;
    let busy = false;

    const release = () => {
      pointer = null;
      claimed = false;
    };

    const onDown = (e: PointerEvent) => {
      swallowUntil = 0;
      if (pointer !== null || busy || e.pointerType === 'mouse' || !e.isPrimary) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest(IGNORE)) return;

      const shut = drawerProgress.get() === 0;
      if (shut && e.clientX <= BACK_EDGE && back.current.canBack) {
        mode = 'back';
        width = page.current?.clientWidth || window.innerWidth;
      } else {
        // Something with sideways gestures of its own keeps them — except at
        // the very edge, which stays the drawer's so it can always be reached.
        if (e.clientX > EDGE_CLAIM && target?.closest('[data-no-swipe]')) return;
        mode = 'drawer';
      }
      pointer = e.pointerId;
      startX = lastX = e.clientX;
      startY = e.clientY;
      lastAt = e.timeStamp;
      from = drawerProgress.get();
      claimed = false;
      velocity = 0;
    };

    const onMove = (e: PointerEvent) => {
      if (pointer !== e.pointerId) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      if (!claimed) {
        // Up or down first: a scroll, and not ours.
        if (Math.abs(dy) > (mode === 'back' ? BACK_DRIFT : CLAIM_Y)) return release();
        if (mode === 'back') {
          if (dx < BACK_CLAIM) return;
        } else {
          if (Math.abs(dx) < CLAIM_X) return;
          // Nothing to open by swiping left when it is already shut.
          if (from === 0 && dx < 0) return release();
        }
        claimed = true;
      }

      const elapsed = e.timeStamp - lastAt;
      if (elapsed > 0) velocity = ((e.clientX - lastX) / elapsed) * 1000;
      lastX = e.clientX;
      lastAt = e.timeStamp;

      if (mode === 'back') backProgress.set(Math.max(0, Math.min(1, dx / width)));
      else drawerProgress.set(Math.max(0, Math.min(1, from + dx / DRAWER_WIDTH)));
      // Non-passive, so the page cannot scroll under a claimed drag.
      e.preventDefault();
    };

    const onUp = (e: PointerEvent) => {
      if (pointer !== e.pointerId) return;
      const wasClaimed = claimed;
      release();
      if (!wasClaimed) return;
      swallowUntil = e.timeStamp + SWALLOW_WINDOW;

      if (mode === 'drawer') {
        let next = drawerProgress.get() > OPEN_THRESHOLD;
        if (velocity > FLING_VELOCITY) next = true;
        else if (velocity < -FLING_VELOCITY) next = false;
        setOpen(next);
        return;
      }

      let leaves = backProgress.get() > BACK_THRESHOLD;
      if (velocity > BACK_FLING) leaves = true;
      else if (velocity < -BACK_FLING) leaves = false;
      if (!leaves) {
        animate(backProgress, 0, BACK_SPRING);
        return;
      }
      busy = true;
      animate(backProgress, 1, {
        ...BACK_SPRING,
        onComplete: () => {
          /* The page is off the right edge. Hide it, put it back where pages
             live, and go back: the screen leaving fades out unseen and the
             one arriving comes in under a fade of its own. */
          backFade.set(0);
          backProgress.set(0);
          back.current.onBack();
          window.setTimeout(() => {
            animate(backFade, 1, { duration: 0.18, ease: [0.22, 1, 0.36, 1] });
            busy = false;
          }, 140);
        },
      });
    };

    const onClick = (e: MouseEvent) => {
      if (e.timeStamp > swallowUntil) return;
      swallowUntil = 0;
      e.preventDefault();
      e.stopPropagation();
    };

    node.addEventListener('click', onClick, true);
    node.addEventListener('pointerdown', onDown, { passive: true });
    node.addEventListener('pointermove', onMove, { passive: false });
    node.addEventListener('pointerup', onUp, { passive: true });
    node.addEventListener('pointercancel', onUp, { passive: true });
    return () => {
      node.removeEventListener('click', onClick, true);
      node.removeEventListener('pointerdown', onDown);
      node.removeEventListener('pointermove', onMove);
      node.removeEventListener('pointerup', onUp);
      node.removeEventListener('pointercancel', onUp);
      if (claimed && mode === 'back') animate(backProgress, 0, BACK_SPRING);
    };
  }, [enabled, page, setOpen]);

  // Escape shuts it, on a keyboard paired to a phone or a narrowed window.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, setOpen]);

  return { open, setOpen };
}

/**
 * Whether the screen has moved off the panel at all — true from the first
 * pixel of a drag, not only once it has settled open. The native tab bar
 * cannot follow a finger frame by frame, so it steps down the moment the
 * screen starts to move and comes back once it is home.
 */
export function useDrawerMoving() {
  const [moving, setMoving] = useState(drawerProgress.get() > 0);
  useEffect(() => drawerProgress.on('change', (v) => setMoving(v > 0.001)), []);
  return moving;
}
