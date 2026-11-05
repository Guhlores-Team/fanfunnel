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
