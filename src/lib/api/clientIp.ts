// Best-effort client IP for per-visitor rate-limit keys.
//
// The left-most `x-forwarded-for` entry is supplied by the client and can be
// spoofed to rotate rate-limit buckets, so we prefer headers that a trusted
// proxy sets (Vercel's `x-real-ip`, Cloudflare's `cf-connecting-ip`). XFF is a
// last-resort fallback for unproxied/local runs.
//
// IMPORTANT: limits keyed on this are a front-line shield only. The authoritative
// abuse guard (e.g. spins-remaining + the atomic per-fan rate window) lives in
// the database and does not trust any client header.
export function clientIp(req: Request): string {
  const realIp = req.headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;

  const cf = req.headers.get("cf-connecting-ip")?.trim();
  if (cf) return cf;

  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }

  return "local";
}
