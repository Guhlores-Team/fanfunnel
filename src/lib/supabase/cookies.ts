import type { CookieOptionsWithName } from "@supabase/ssr";

/**
 * Attributes for the Supabase session cookie, shared by the browser, server and
 * proxy clients so all three write the same attributes (a mismatch leaves two
 * cookies with the same name and a flapping session).
 *
 * `httpOnly` MUST stay `false`: `@supabase/ssr`'s `createBrowserClient` reads and
 * writes the session through `document.cookie` (it has no other storage), and
 * this app signs in, signs up, resets passwords and subscribes to Realtime from
 * Client Components. An httpOnly cookie is invisible to `document.cookie`, so
 * `supabase.auth.*` in the browser would silently see no session. The modules
 * that need it are inventoried in `cookies.test.ts`; when that list is empty the
 * test fails on purpose so this flag gets re-evaluated.
 *
 * `secure` is derived from the request/page protocol instead of NODE_ENV so a
 * plain-http `next start` (e2e, local demo) keeps working while every https
 * deploy sends `Secure`. `@supabase/ssr` never sets `secure` on its own.
 */
/**
 * The protocol a server-written cookie should assume when there is no page
 * context: the proxy's `x-forwarded-proto` (first hop if comma-separated; Vercel
 * always sends it), else the scheme of `NEXT_PUBLIC_SITE_URL` (self-hosted https
 * behind a terminator that strips the header), else plain http.
 */
export function serverRequestProtocol(
  forwardedProto: string | null | undefined,
  siteUrl: string | undefined = process.env.NEXT_PUBLIC_SITE_URL
): string {
  const hop = (forwardedProto ?? "").split(",")[0].trim();
  if (hop) return hop;
  try {
    return new URL((siteUrl ?? "").trim()).protocol;
  } catch {
    return "http";
  }
}

export function sessionCookieOptions(
  protocol: string | null | undefined
): CookieOptionsWithName {
  const scheme = (protocol ?? "").trim().toLowerCase().replace(/:$/, "");
  return {
    path: "/",
    sameSite: "lax",
    httpOnly: false,
    secure: scheme === "https",
  };
}
