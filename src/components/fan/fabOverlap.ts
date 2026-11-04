// The fixed "Message" button sits bottom-right; on common phones (390×844,
// 360×780) it covered the right part of the PLAY/SPIN button at the top of the
// page, so a tap there opened the chat instead of playing. The button steps
// aside (hidden, not focusable) only while it actually covers the play button.
export interface Box { left: number; top: number; right: number; bottom: number }

/** True when the two boxes share any area (touching edges do not count). */
export function boxesOverlap(a: Box, b: Box): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

/** Hide the floating button only when it covers the play button and is not in use. */
export function shouldStepAside(fab: Box | null, play: Box | null, inUse: boolean): boolean {
  if (inUse || !fab || !play) return false;
  return boxesOverlap(fab, play);
}
