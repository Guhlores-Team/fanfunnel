/** Fixed Fisher–Yates order: i=n-1..1, one checked float per step. */
export function shuffled<T>(items: readonly T[], rng: () => number): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(randomFloat(rng) * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export function randomFloat(rng: () => number): number {
  const value = rng();
  if (!Number.isFinite(value) || value < 0 || value >= 1) throw new Error("Invalid game random draw");
  return value;
}
