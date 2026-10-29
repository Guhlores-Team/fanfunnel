/** Cosmetic foil coverage only. This module never chooses a prize or changes a ticket. */
export interface ScratchPoint { x: number; y: number }
export const SCRATCH_GRID = 28;
export const SCRATCH_BRUSH_FRACTION = 0.07;
export const SCRATCH_REVEAL_FRACTION = 0.45;
const clamp = (value: number) => Math.max(0, Math.min(1, value));
export function scratchPoint(clientX: number, clientY: number, rect: { left: number; top: number; width: number; height: number }): ScratchPoint | null {
  if (![clientX, clientY, rect.left, rect.top, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) return null;
  return { x: clamp((clientX - rect.left) / rect.width), y: clamp((clientY - rect.top) / rect.height) };
}
/** Normalized stroke coverage survives resize and device-pixel-ratio changes. */
export function addScratchCoverage(covered: Set<number>, from: ScratchPoint, to: ScratchPoint) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const lengthSquared = dx * dx + dy * dy;
  for (let row = 0; row < SCRATCH_GRID; row++) for (let column = 0; column < SCRATCH_GRID; column++) {
    const x = (column + 0.5) / SCRATCH_GRID;
    const y = (row + 0.5) / SCRATCH_GRID;
    const along = lengthSquared > 0 ? clamp(((x - from.x) * dx + (y - from.y) * dy) / lengthSquared) : 0;
    const distance = Math.hypot(x - from.x - along * dx, y - from.y - along * dy);
    if (distance <= SCRATCH_BRUSH_FRACTION) covered.add(row * SCRATCH_GRID + column);
  }
  return covered.size / (SCRATCH_GRID * SCRATCH_GRID);
}
