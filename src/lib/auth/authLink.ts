import { NextResponse } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { createClient, isSupabaseConfigured } from "@/lib/supabase/server";
import { isOwnPagePost } from "@/lib/security/sameOrigin";
import { hasSessionCookie, limitRoute } from "@/lib/api/limit";
import { safeNext } from "./safeNext";
import { defaultNextFor, OTP_TYPES, signedInLinkFailurePath, withQueryFlag } from "./linkNotice";
import { revokeSession, verifiedSession } from "./sessions";

export { defaultNextFor, OTP_TYPES };

// Every e-mail link lands on this site through /auth/confirm (the current
// templates, supabase/templates/*.html, which link to
// {{ .SiteURL }}/auth/confirm?token_hash=…&type=…&next=<fixed page>) or
// /auth/callback (the app's `redirectTo`, used only by the legacy
// {{ .ConfirmationURL }} PKCE links).
//
// WU-02 / WA-05 (batch 7): a token_hash is single-use, and mail scanners
// (Microsoft Safe Links, corporate URL sandboxes, chat-app previews) fetch
// every link in a message before the reader does. So a GET never verifies
// anything: /auth/confirm renders a small page with a "Continue" button whose
// form POSTs the token to /auth/confirm/verify, and only that POST calls
// verifyOtp. The legacy `code` links (/auth/callback?code=…) are exchanged on
// GET as before: a code is useless without the code-verifier cookie that only
// the requesting browser holds, so a scanner cannot consume it.
//
// Review A2: that POST creates a session, so it must come from this site's own
// Continue page (isOwnPagePost: the browser's Sec-Fetch-Site / Origin, with or
// without cookies). Anything else is sent back to the Continue page with the
// token UNSPENT, so a human still has to press the button on our page: a
// cross-site form holding an attacker's own token can never sign a visitor's
// browser in as the attacker.
//
// `next` stays on this site (safeNext). A bad, used or expired link goes to
// /login?error=auth_link&type=<type>&reason=<reason>, where the sign-in page
// says what happened for that kind of link and offers the right next step.

export const TOKEN_HASH = /^[A-Za-z0-9_-]{8,256}$/;

/**
 * Why a link could not be used; the sign-in page words each one.
 *   expired    Supabase's "invalid or has expired" (a used link reads the same)
 *   invalid    any other refusal of the token itself
 *   malformed  the link's own parts are missing or cut
 *   banned     the token was fine but the account is blocked from signing in
 *   busy       nothing was decided (rate limit, provider 5xx, network): the
 *              link is still good; the verify route sends these back to the
 *              Continue page, and the sign-in page words it for old URLs
 */
export type AuthLinkReason = "expired" | "invalid" | "malformed" | "banned" | "busy";

/** The sign-in page path that explains a failed link of this type. */
export function authLinkFailurePath(type: string | null, reason: AuthLinkReason): string {
  const q = new URLSearchParams({ error: "auth_link" });
  if (type && OTP_TYPES.has(type)) q.set("type", type);
  q.set("reason", reason);
  return `/login?${q}`;
}

export function authLinkFailureUrl(origin: string, type: string | null, reason: AuthLinkReason): string {
  return `${origin}${authLinkFailurePath(type, reason)}`;
}

/** Page shown after the first of the secure e-mail change's two links. */
export const EMAIL_CHANGE_HALF_PATH = "/auth/email-change";

/** The parts of a token_hash link, validated; null when the link is malformed. */
export function parseTokenLink(params: URLSearchParams | FormData): { tokenHash: string; type: EmailOtpType; next: string } | null {
  const read = (key: string): string | null => {
    const v = params.get(key);
    return typeof v === "string" ? v : null;
  };
  const tokenHash = read("token_hash");
  const type = read("type");
  if (!tokenHash || !TOKEN_HASH.test(tokenHash) || !type || !OTP_TYPES.has(type)) return null;
  return { tokenHash, type: type as EmailOtpType, next: safeNext(read("next"), defaultNextFor(type)) };
}

/** What the Continue page says above its button when it was sent back to. */
export type LandingNotice = "origin" | "busy";

/** /auth/confirm for this link, token unspent (optionally with a fixed-text notice flag). */
export function authLinkLandingPath(link: { tokenHash: string; type: string; next: string }, notice?: LandingNotice): string {
  const q = new URLSearchParams({ token_hash: link.tokenHash, type: link.type, next: link.next });
  if (notice) q.set("retry", notice);
  return `/auth/confirm?${q}`;
}

/**
 * What a failed verifyOtp means for the person holding the link (review A3).
 * Only a refusal of the token itself may say "used or expired": a rate limit
 * (429), a provider failure (5xx), a response that is not the provider's JSON
 * or a network error decided nothing, so the token is unspent ("busy"); a
 * blocked account is told so ("banned") instead of being sent for a new link
 * that would fail the same way.
 */
export function verifyFailureFor(error: { code?: unknown; status?: unknown; name?: unknown } | null | undefined): Exclude<AuthLinkReason, "malformed"> {
  const code = error?.code;
  const status = error?.status;
  if (code === "user_banned") return "banned";
  if (code === "otp_expired") return "expired";
  if (code === "over_request_rate_limit" || code === "over_email_send_rate_limit" || status === 429) return "busy";
  if (error?.name === "AuthRetryableFetchError" || error?.name === "AuthUnknownError") return "busy";
  if (typeof status !== "number" || status === 0 || status >= 500) return "busy";
  // Auth servers that predate error codes answer a used link with a bare 403.
  return status === 403 ? "expired" : "invalid";
}

/**
 * POST /auth/confirm/verify: the only place a token_hash is spent. The form
 * fields come from the landing page; the response is a redirect either way,
 * so a browser never shows the token in a page it keeps.
 */
export async function verifyAuthLink(req: Request): Promise<NextResponse> {
  const { origin } = new URL(req.url);
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.redirect(authLinkFailureUrl(origin, null, "malformed"), { status: 303 });
  }
  const link = parseTokenLink(form);
  if (!link) return NextResponse.redirect(authLinkFailureUrl(origin, typeof form.get("type") === "string" ? String(form.get("type")) : null, "malformed"), { status: 303 });
  // A2: only this site's own Continue page may spend a token. Checked before
  // anything touches Supabase or a cookie, in the demo too.
  if (
    !isOwnPagePost({
      headers: req.headers,
      requestUrl: req.url,
      allowedOrigins: [process.env.NEXT_PUBLIC_SITE_URL],
      onVercel: process.env.VERCEL === "1",
    })
  ) {
    return NextResponse.redirect(`${origin}${authLinkLandingPath(link, "origin")}`, { status: 303, headers: { "Cache-Control": "no-store" } });
  }
  // A3: a per-client ceiling in front of the provider call. A refusal spends
  // nothing, so it goes back to the Continue page ("still good, try again").
  const busy = () => NextResponse.redirect(`${origin}${authLinkLandingPath(link, "busy")}`, { status: 303, headers: { "Cache-Control": "no-store" } });
  if (await limitRoute(req, "auth-confirm-verify:POST", "costly")) return busy();
  // The demo has no accounts: nothing to verify (and no client to build).
  if (!isSupabaseConfigured()) return NextResponse.redirect(`${origin}/login`, { status: 303 });

  const supabase = await createClient();
  // A4 / A5: who (if anyone) this browser is signed in as before the link is
  // spent. Asked of the Auth server (getUser), never read from a cookie alone.
  const previous = hasSessionCookie(req) ? await verifiedSession(supabase) : null;
  let data: Awaited<ReturnType<typeof supabase.auth.verifyOtp>>["data"] | null = null;
  let failure: ReturnType<typeof verifyFailureFor> | null = null;
  try {
    const result = await supabase.auth.verifyOtp({ type: link.type, token_hash: link.tokenHash });
    data = result.data;
    if (result.error) failure = verifyFailureFor(result.error);
  } catch {
    failure = "busy";
  }
  if (failure === "busy") return busy();
  if (failure) {
    // A5 / A6: a visitor who is already signed in is not sent to the sign-in
    // page (the proxy would bounce them to the dashboard with no explanation).
    const to = previous ? signedInLinkFailurePath(link.type, failure, link.next) : authLinkFailurePath(link.type, failure);
    return NextResponse.redirect(`${origin}${to}`, { status: 303 });
  }
  // Secure e-mail change: the first of the two links answers with no session
  // (auth-js documents it: "Some /verify responses (e.g. secure email_change
  // first-confirmation) return only { msg, code }"). The change is NOT done
  // yet; the other address holds the second link.
  if (link.type === "email_change" && !data?.session) {
    return NextResponse.redirect(`${origin}${EMAIL_CHANGE_HALF_PATH}`, { status: 303 });
  }
  // A4: the link belonged to a different account than the one signed in here.
  // The cookies now hold the new session; end the old one at the Auth server
  // too, and tell the landing page to say whose session this is (the page
  // reads the e-mail from the session; the flag only switches the sentence on).
  const newUserId = data?.user?.id ?? data?.session?.user?.id ?? null;
  if (previous && newUserId && previous.userId !== newUserId) {
    await revokeSession(previous.accessToken);
    return NextResponse.redirect(`${origin}${withQueryFlag(link.next, "switched", "1")}`, { status: 303 });
  }
  return NextResponse.redirect(`${origin}${link.next}`, { status: 303 });
}

/**
 * Supabase's own redirect when a legacy {{ .ConfirmationURL }} link fails at
 * its /verify endpoint: `?error=access_denied&error_code=otp_expired&
 * error_description=…` on the app's redirect URL. That is a refused link, not
 * a cut one, so it gets the matching reason instead of "incomplete". Null when
 * the URL carries no such error. (The implicit flow puts the same fields in
 * the #fragment, which no server sees; the app only uses PKCE.)
 */
export function legacyErrorReason(params: URLSearchParams): AuthLinkReason | null {
  const code = params.get("error_code");
  const error = params.get("error");
  if (!code && !error) return null;
  if (code === "user_banned") return "banned";
  // Older Auth servers: error=unauthorized_client&error_code=401 with only the sentence.
  if (code === "otp_expired" || /invalid or has expired/i.test(params.get("error_description") ?? "")) return "expired";
  if (code === "over_request_rate_limit" || code === "over_email_send_rate_limit" || code === "unexpected_failure" || code === "request_timeout" || error === "server_error" || error === "temporarily_unavailable") return "busy";
  return "invalid";
}

/**
 * GET /auth/callback: the app's `redirectTo`. A legacy PKCE `code` is
 * exchanged here (same browser only). A token_hash link that reaches this
 * route is sent to the landing page unspent; the `message`-only form of the
 * legacy e-mail change (Supabase's own redirect after the first link) goes to
 * the half-done page.
 */
export async function completeAuthLink(req: Request): Promise<NextResponse> {
  const { searchParams, origin } = new URL(req.url);
  const type = searchParams.get("type");
  const next = safeNext(searchParams.get("next"), defaultNextFor(type));
  const code = searchParams.get("code");

  if (searchParams.get("token_hash") !== null) {
    const link = parseTokenLink(searchParams);
    if (!link) return NextResponse.redirect(authLinkFailureUrl(origin, type, "malformed"));
    return NextResponse.redirect(`${origin}${authLinkLandingPath(link)}`);
  }

  if (searchParams.get("message")) return NextResponse.redirect(`${origin}${EMAIL_CHANGE_HALF_PATH}`);

  const legacy = code ? null : legacyErrorReason(searchParams);
  if (legacy) return NextResponse.redirect(authLinkFailureUrl(origin, type, legacy));

  // The demo has no accounts: nothing to exchange (and no client to build).
  if (!isSupabaseConfigured()) return NextResponse.redirect(`${origin}/login`);

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(`${origin}${next}`);
    return NextResponse.redirect(authLinkFailureUrl(origin, type, "invalid"));
  }

  return NextResponse.redirect(authLinkFailureUrl(origin, type, "malformed"));
}
