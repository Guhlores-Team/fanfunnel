/**
 * Avatar initials for a fan name/handle: the first two letters or digits,
 * ignoring a leading "@" and punctuation ("@mia_rose" → "MI", "Demo Fan" → "DE").
 * Falls back to "?" when the name has nothing usable.
 */
export function initials(name: string): string {
  const chars = (name ?? "").replace(/^@+/, "").match(/[\p{L}\p{N}]/gu) ?? [];
  return chars.length ? chars.slice(0, 2).join("").toUpperCase() : "?";
}
