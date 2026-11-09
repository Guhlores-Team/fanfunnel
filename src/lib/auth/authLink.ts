import { NextResponse } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { safeNext } from "./safeNext";

// Every e-mail link lands here, through /auth/confirm or /auth/callback.
//
// - `token_hash` + `type` (the current templates, supabase/templates/*.html):
//   verified server-side with verifyOtp, so the link works in ANY browser or
//   device, including the in-app browsers of mail and social apps.
// - `code` (the PKCE flow, the templates' previous {{ .ConfirmationURL }}
//   links): exchanged with the code-verifier cookie, which only exists in the
//   browser that asked for the e-mail. Kept so links already sent, and
//   projects whose templates are not updated yet, keep working.
// - `message` alone: the first of the secure e-mail change's two links.
//
// `next` stays on this site (safeNext); a bad, used or expired link, or one
// opened in another browser (PKCE), goes to /login?error=auth_link, which says
// what happened and offers a fresh link.

const OTP_TYPES: ReadonlySet<string> = new Set(["signup", "invite", "magiclink", "recovery", "email_change", "email"]);
const TOKEN_HASH = /^[A-Za-z0-9_-]{8,256}$/;

/** Where a link of this type goes when it carries no (usable) `next`. */
export function defaultNextFor(type: string | null): string {
  if (type === "recovery") return "/reset-password";
  if (type === "invite") return "/set-password";
  if (type === "signup" || type === "email") return "/pending";
  return "/dashboard";
}

export async function completeAuthLink(req: Request): Promise<NextResponse> {
  const { searchParams, origin } = new URL(req.url);
  const type = searchParams.get("type");
  const next = safeNext(searchParams.get("next"), defaultNextFor(type));
  const tokenHash = searchParams.get("token_hash");
  const code = searchParams.get("code");
  const failed = NextResponse.redirect(`${origin}/login?error=auth_link`);

  if (tokenHash !== null) {
    if (!tokenHash || !TOKEN_HASH.test(tokenHash) || !type || !OTP_TYPES.has(type)) return failed;
    const supabase = await createClient();
    const { error } = await supabase.auth.verifyOtp({ type: type as EmailOtpType, token_hash: tokenHash });
    return error ? failed : NextResponse.redirect(`${origin}${next}`);
  }

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(`${origin}${next}`);
  }

  if (searchParams.get("message")) return NextResponse.redirect(`${origin}${next}`);

  return failed;
}
