import { NextResponse } from "next/server";
import { safeNext } from "@/lib/auth/safeNext";

// WC-08 / WU-18: the handoff notes send new creators to /signup. It is the
// sign-in page's "create your login" mode. A route handler, not a page: the
// proxy runs on /signup (a signed-in user is sent to the dashboard before this
// runs), and every PAGE under a proxied path gets the nonce CSP
// (src/lib/security/csp.ts), which a prerendered redirect page cannot carry.
// A `next` that stays on this site travels along (the sign-in form uses it
// after sign-in); anything else is dropped, never forwarded.
export function GET(req: Request) {
  const url = new URL(req.url);
  const to = new URL("/login?mode=signup", url);
  const next = safeNext(url.searchParams.get("next"), "");
  if (next) to.searchParams.set("next", next);
  return NextResponse.redirect(to);
}
