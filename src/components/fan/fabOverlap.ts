// The fixed "Message" button sits bottom-right; on common phones (390×844,
// 360×780) it covered the right part of the PLAY/SPIN button at the top of the
// page, so a tap there opened the chat instead of playing. The button steps
// aside (hidden, not focusable) only while it actually covers a play control.
export interface Box { left: number; top: number; right: number; bottom: number }

/** True when the two boxes share any area (touching edges do not count). */
export function boxesOverlap(a: Box, b: Box): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

/**
 * Hide the floating button only when it covers a play control and is not in
 * use. The controls are the play button and whatever sits beside it during a
 * play (the Sound pill, a scratch ticket's Reveal all): QA b5 m12 found the
 * button over the Sound pill on a 390×844 phone mid-scratch.
 */
export function shouldStepAside(fab: Box | null, controls: Box | null | readonly (Box | null)[], inUse: boolean): boolean {
  if (inUse || !fab) return false;
  const list = Array.isArray(controls) ? controls : [controls];
  return list.some((box) => !!box && boxesOverlap(fab, box));
}

/** Marks a control the floating Message button must never cover. */
export const FAB_AVOID_SELECTOR = "[data-fab-avoid]";

/**
 * WF-10: instead of vanishing, the button moves up just enough to clear the
 * controls it covers (so "Message" stays in reach on the first screen). It
 * hides only when no upward room is left.
 */
export function fabNudge(fab: Box | null, controls: readonly (Box | null)[], inUse: boolean, gap = 8): { up: number; hide: boolean } {
  if (inUse || !fab) return { up: 0, hide: false };
  let up = 0;
  for (let round = 0; round < controls.length + 1; round++) {
    const moved = { ...fab, top: fab.top - up, bottom: fab.bottom - up };
    const hit = controls.filter((box): box is Box => !!box && boxesOverlap(moved, box));
    if (hit.length === 0) break;
    up = Math.max(up, ...hit.map((box) => fab.bottom - box.top + gap));
  }
  if (up === 0) return { up: 0, hide: false };
  return fab.top - up < gap ? { up: 0, hide: true } : { up, hide: false };
}

