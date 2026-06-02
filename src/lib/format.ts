export function formatCents(c: number): string {
  return "$" + (c / 100).toFixed(2);
}

/**
 * Normalize a user-entered external link so it always works as an absolute URL.
 * "onlyfans.com/x" → "https://onlyfans.com/x" (otherwise the browser treats it
 * as a same-site relative path and 404s). Leaves http(s)/mailto links as-is;
 * returns "" for blank input.
 */
export function externalUrl(raw: string | null | undefined): string {
  const s = (raw ?? "").trim();
  if (!s) return "";
  if (/^(https?:|mailto:|tel:)/i.test(s)) return s;
  return "https://" + s.replace(/^\/+/, "");
}
