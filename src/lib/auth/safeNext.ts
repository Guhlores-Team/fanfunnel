/**
 * A post-sign-in destination that can only point back into this site: a path
 * starting with one "/" (no "//host", no "/\\host", no scheme), else the
 * fallback. Stops `?next=` from becoming an open redirect.
 */
export function safeNext(value: unknown, fallback = "/dashboard"): string {
  if (typeof value !== "string" || value.length > 512) return fallback;
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return fallback;
  if (/[\u0000-\u001f]/.test(value)) return fallback;
  return value;
}
