import { NextResponse } from "next/server";
import { verifyAuthLink } from "@/lib/auth/authLink";

// The one place an e-mail link's token_hash is spent: the landing page's
// "Continue" form POSTs here (src/app/auth/confirm/page.tsx). A GET only ever
// shows the landing page again, so a scanner that follows the form's action
// cannot consume the link either.
export async function POST(req: Request) {
  return verifyAuthLink(req);
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  url.pathname = "/auth/confirm";
  return NextResponse.redirect(url);
}
