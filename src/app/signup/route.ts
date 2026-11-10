import { NextResponse } from "next/server";

// WC-08 / WU-18: the handoff notes send new creators to /signup. It is the
// sign-in page's "create your login" mode. A route handler, not a page: the
// proxy runs on /signup (a signed-in user is sent to the dashboard before this
// runs), and every PAGE under a proxied path gets the nonce CSP
// (src/lib/security/csp.ts), which a prerendered redirect page cannot carry.
export function GET(req: Request) {
  return NextResponse.redirect(new URL("/login?mode=signup", req.url));
}
