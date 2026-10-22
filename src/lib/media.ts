/**
 * How wide the window is, as a question the app can answer in JavaScript
 * rather than only in CSS.
 *
 * Most of the phone work is a stylesheet, and it should be: a grid that
 * stacks is a grid that stacks, and nothing in React needs to know. But three
 * things cannot be said in CSS. A sidebar of sixteen destinations does not
 * *become* a tab bar of five — it is replaced by one, and the replacement is
 * a different component with a different list. A centred modal does not
 * *become* a bottom sheet you can throw downwards — the drag is behaviour.
 * And the back gesture is an event listener or it is nothing.
 *
 * So the breakpoint is named once, here, and read from both sides. The CSS
 * value in `mobile.css` and `PHONE` below have to agree; they are commented
 * against each other so a change to one is a change nobody can make alone.
 */

import { useEffect, useState } from 'react';

/**
 * A phone, or a window narrowed to the width of one.
 *
 * 760px rather than something snugger: an iPad in portrait is 768 and wants
 * the sidebar, a phone in landscape is 844 and — being 390 tall — wants the
 * tab bar even less than it wants the sidebar. Width is the wrong question
 * for the second case and the right one for every case that matters, so it
 * is the one asked. Must match `--phone` in `mobile.css`.
 */
export const PHONE = '(max-width: 760px)';

/** Narrow enough that even the phone layout has to give something up. */
export const NARROW = '(max-width: 400px)';

export function useMediaQuery(query: string): boolean {
  // Read during the first render rather than in an effect: a shell that
  // mounted desktop-shaped and corrected itself a frame later would flash the
  // sidebar on every launch, and `matchMedia` needs no measuring to answer.
  const [matches, setMatches] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(query).matches,
  );

  useEffect(() => {
    const list = window.matchMedia(query);
    const onChange = () => setMatches(list.matches);
    // Asked again on subscribe: the query can have changed between the first
    // render and here — a rotation during launch is the ordinary way.
    onChange();
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}

export const usePhone = () => useMediaQuery(PHONE);
