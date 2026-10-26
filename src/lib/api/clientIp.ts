// The ONE place a client IP is derived from request headers (a static test,
// clientIpSingleSource.test.ts, fails if any other module reads these headers).
// It keys every per-visitor rate limit, so it must not be steerable by a caller.
//
// Precedence (FanFunnel deploys on Vercel):
//   1. `x-vercel-forwarded-for`: written by Vercel's edge; unlike XFF it survives
//      a proxy placed in front of Vercel.
//   2. `x-real-ip`: also written by Vercel's edge (what `@vercel/functions`'
//      `ipAddress()` reads).
//   3. `x-forwarded-for`, RIGHT-most hop only, for local/unproxied runs. Every
//      hop appends to the right, so the left-most entry is whatever the client
//      sent and rotating it would mint a fresh rate-limit bucket per request.
//      Self-hosted `next start` keeps a client-sent XFF and only fills it from
//      the socket address when absent, so this fallback is not spoof-proof
//      without a proxy that sets `x-real-ip`.
//   4. "local": no usable header (unit tests, scripts). Never throws.
//
// `cf-connecting-ip` and friends are deliberately ignored: Vercel does not set
// them, so here they are plain client input.
//
// Limits keyed on this are a front-line shield only. The authoritative abuse
// guards (spins remaining, the atomic per-fan rate window in `claim_spin`) live
// in the database and trust no client header.

function firstEntry(value: string | null): string | null {
  const first = value?.split(",")[0]?.trim();
  return first || null;
}

function lastEntry(value: string | null): string | null {
  if (!value) return null;
  const hops = value
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  return hops.length ? hops[hops.length - 1] : null;
}

export function clientIp(req: Request): string {
  const h = req.headers;
  return (
    firstEntry(h.get("x-vercel-forwarded-for")) ??
    firstEntry(h.get("x-real-ip")) ??
    lastEntry(h.get("x-forwarded-for")) ??
    "local"
  );
}
