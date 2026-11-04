// Content-Security-Policy for every response. Two script policies:
//
// - "strict" (per request, set by src/proxy.ts): the signed-in surfaces the
//   proxy already runs on (/dashboard, /admin, /agency, /pending, /login,
//   /signup, /mfa). These are dynamically rendered, so Next reads the nonce
//   from the request's CSP header and stamps it on its own scripts. Only
//   nonced scripts (and what they load, via 'strict-dynamic') run: an injected
//   <script> or inline handler is refused.
// - "public" (static, from next.config.ts): every other route. /, /c/[slug]
//   (ISR), /privacy, /terms, /forgot-password and /reset-password are
//   prerendered, and a prerendered page has no per-request nonce to carry.
//   Next's inline RSC payload scripts then need 'unsafe-inline'; scripts from
//   any other origin and eval stay blocked. /spin, /share, /verify and
//   /leaderboard are dynamic but are deliberately kept off the proxy (PERF-4:
//   no extra hop on the fan's hot path), so they get this policy too.
//
// Everything except script-src is identical in both. The session cookie is
// readable by JS (src/lib/supabase/cookies.ts), so script-src is the part that
// matters. style-src keeps 'unsafe-inline' (and no nonce, which would disable
// it): React renders style="" attributes and the theme uses inline CSS
// variables throughout. Dependency-free: next.config.ts imports this.

export type CspMode = "strict" | "public";

export interface CspOptions {
  mode: CspMode;
  /** Required for "strict". */
  nonce?: string;
  /** NODE_ENV === "development": React's dev build needs eval for its
   *  server-error stack reconstruction. Never set in production. */
  dev?: boolean;
  /** NEXT_PUBLIC_SUPABASE_URL (any path is ignored). Absent in demo mode. */
  supabaseUrl?: string;
}

/** Origins for the browser Supabase client: REST/auth/storage over http(s)
 *  and realtime over ws(s), both on the project origin. */
export function supabaseOrigins(raw: string | undefined): { http: string; ws: string } | null {
  if (!raw?.trim()) return null;
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return { http: u.origin, ws: `${u.protocol === "https:" ? "wss:" : "ws:"}//${u.host}` };
  } catch {
    return null;
  }
}

/** Nonce: 128 random bits, base64 (what Next's nonce parser accepts). */
export function createNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function buildCsp({ mode, nonce, dev = false, supabaseUrl }: CspOptions): string {
  if (mode === "strict" && !(nonce && /^[A-Za-z0-9+/]+={0,2}$/.test(nonce))) {
    throw new Error("strict CSP needs a base64 nonce");
  }
  const sb = supabaseOrigins(supabaseUrl);
  const script =
    mode === "strict"
      ? ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'"]
      : ["'self'", "'unsafe-inline'"];
  if (dev) script.push("'unsafe-eval'");

  const directives: [string, string[]][] = [
    ["default-src", ["'self'"]],
    ["script-src", script],
    ["style-src", ["'self'", "'unsafe-inline'"]],
    // data: QR codes and canvas exports, blob: local upload previews, the
    // Supabase origin for avatars and theme photos in Storage.
    ["img-src", ["'self'", "data:", "blob:", ...(sb ? [sb.http] : [])]],
    // next/font self-hosts the fonts under /_next/static/media.
    ["font-src", ["'self'"]],
    // The app's own API and /api/errors, plus the browser Supabase client.
    // Upstash and web-push delivery are server-side only.
    ["connect-src", ["'self'", ...(sb ? [sb.http, sb.ws] : [])]],
    // The dashboard service worker (/sw.js). Explicit because with
    // 'strict-dynamic' a fallback to script-src would ignore 'self'.
    ["worker-src", ["'self'"]],
    ["manifest-src", ["'self'"]],
    ["frame-src", ["'none'"]],
    ["object-src", ["'none'"]],
    ["base-uri", ["'self'"]],
    ["form-action", ["'self'"]],
    ["frame-ancestors", ["'self'"]],
  ];
  return directives.map(([name, sources]) => `${name} ${sources.join(" ")}`).join("; ");
}
