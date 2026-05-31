export function formatCents(c: number): string {
  return "$" + (c / 100).toFixed(2);
}
