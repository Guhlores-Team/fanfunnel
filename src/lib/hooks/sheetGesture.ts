/**
 * Drag-to-dismiss decision for a bottom sheet's handle: close on a long enough
 * pull (a quarter of the sheet, between 48px and 120px) or a quick flick
 * downward. `dy` is the downward distance in px, `velocity` in px/ms.
 */
export function shouldDismissSheet(dy: number, velocity: number, sheetHeight: number): boolean {
  if (dy <= 0) return false;
  const distance = Math.min(120, Math.max(48, sheetHeight * 0.25));
  return dy >= distance || (velocity >= 0.5 && dy >= 24);
}
