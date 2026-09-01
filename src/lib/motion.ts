import type { Transition, Variants } from 'motion/react';

/** The spring everything interactive uses — quick, barely any overshoot. */
export const spring: Transition = {
  type: 'spring',
  stiffness: 420,
  damping: 38,
  mass: 0.9,
};

/** Softer spring for large surfaces (sheets, panels) so they settle, not snap. */
export const springSoft: Transition = {
  type: 'spring',
  stiffness: 260,
  damping: 30,
  mass: 1,
};

export const ease: Transition = { duration: 0.18, ease: [0.4, 0, 0.2, 1] };
export const easeSlow: Transition = { duration: 0.32, ease: [0.4, 0, 0.2, 1] };

/** Screen swap: lift in from just below, leave straight up. */
export const screenVariants: Variants = {
  initial: { opacity: 0, y: 10 },
  animate: { opacity: 1, y: 0, transition: { ...easeSlow, duration: 0.26 } },
  exit: { opacity: 0, y: -6, transition: { duration: 0.14, ease: [0.4, 0, 1, 1] } },
};

/**
 * A sheet that has pages inside it — a form, and the editor one of its
 * fields opens. Pages travel the way you are going: in from the right, back
 * out to the left. `custom` carries the direction, so the page leaving and
 * the page arriving agree about which way the sheet moved.
 */
export const pageVariants: Variants = {
  enter: (dir: number) => ({ opacity: 0, x: dir * 28 }),
  settled: { opacity: 1, x: 0, transition: { duration: 0.2, ease: [0.22, 1, 0.36, 1] } },
  leave: (dir: number) => ({
    opacity: 0,
    x: dir * -28,
    transition: { duration: 0.14, ease: [0.4, 0, 1, 1] },
  }),
};

/** Parent of a list that should cascade its children in. */
export const listVariants: Variants = {
  initial: {},
  animate: { transition: { staggerChildren: 0.028, delayChildren: 0.02 } },
};

export const itemVariants: Variants = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0, transition: spring },
  exit: { opacity: 0, y: -4, transition: { duration: 0.12 } },
};

export const sheetBackdrop: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: 0.2 } },
  exit: { opacity: 0, transition: { duration: 0.16 } },
};

export const sheetPanel: Variants = {
  initial: { opacity: 0, y: 28, scale: 0.975 },
  animate: { opacity: 1, y: 0, scale: 1, transition: springSoft },
  exit: { opacity: 0, y: 14, scale: 0.985, transition: { duration: 0.15 } },
};

/**
 * A sheet opened on top of another sheet — the ledger you pick a record from,
 * over the form asking for one. It comes up further and settles slower than a
 * sheet opened over the page: what it covers is already a panel, so a small
 * hop would read as that panel resizing rather than a second one arriving.
 */
export const stackedPanel: Variants = {
  initial: { opacity: 0, y: 46, scale: 0.96 },
  animate: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: { type: 'spring', stiffness: 230, damping: 32, mass: 1.05 },
  },
  exit: {
    opacity: 0,
    y: 22,
    scale: 0.975,
    transition: { duration: 0.17, ease: [0.4, 0, 1, 1] },
  },
};

export const popover: Variants = {
  initial: { opacity: 0, y: -6, scale: 0.97 },
  animate: { opacity: 1, y: 0, scale: 1, transition: spring },
  exit: { opacity: 0, y: -4, scale: 0.98, transition: { duration: 0.12 } },
};

export const press = { scale: 0.97 };
