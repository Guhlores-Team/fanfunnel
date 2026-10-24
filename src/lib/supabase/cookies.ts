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
