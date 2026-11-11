import { LEGAL } from "@/lib/legal";
import { PASSWORD_RULE_MESSAGE } from "@/lib/api/password";

// Plain-words copy for the sign-in family. Pure and client-safe; the sign-in
// page, the new-password screens and the forgot-password form share it so a
// raw provider sentence ("AAL2 session is required", "Email rate limit
// exceeded") never reaches a creator (TS-11, WU-15, WC-04).

export type AuthLinkType = "recovery" | "invite" | "email_change" | "magiclink" | "email" | "signup";
export type AuthLinkReason = "expired" | "invalid" | "malformed" | "banned" | "busy";

/** One next step the failed-link notice offers. */
export type AuthLinkAction = "resend_confirmation" | "reset_link" | "sign_in" | "contact_admin" | "contact_support" | "settings";

export interface AuthLinkNoticeCopy {
  title: string;
  body: string;
  actions: AuthLinkAction[];
}

// No duration: the lifetime is the project's "Email OTP expiry" setting (1 h by
// default, up to 24 h; OWNER_STEPS stage 2), which the app cannot read.
const ANY_DEVICE = "Links work once, on any device or browser, for a limited time.";

/**
 * What the sign-in page says for /login?error=auth_link&type=…&reason=….
 * Supabase cannot tell a used link from an expired one (both are
 * `otp_expired`), so "expired" always covers "already used" too.
 */
export function authLinkNotice(type: string | null, reason: string | null): AuthLinkNoticeCopy {
  const r: AuthLinkReason = reason === "expired" || reason === "malformed" || reason === "banned" || reason === "busy" ? reason : "invalid";
  // A3: nothing was decided (rate limit, an outage, the network). The link
  // was not used up, so this must never read "already used or expired".
  if (r === "busy") {
    return {
      title: "We couldn't check your link just now",
      body: "That was a problem on our side or with the connection, not with your link: it is still good. Wait a few minutes, then open the link from your e-mail again and tap Continue.",
      actions: [],
    };
  }
  // A3: the token was fine; the account itself is blocked from signing in. A
  // new link would fail the same way, so none is offered.
  if (r === "banned") {
    return {
      title: "This account can't sign in right now",
      body: `Your link was fine, but sign-in is blocked for this account, so a new link won't help. If you think that's a mistake, write to ${LEGAL.contactEmail}.`,
      actions: ["contact_support"],
    };
  }
  if (r === "malformed") {
    return {
      title: "This link is incomplete",
      body: "Part of the link is missing, so it can't be checked. A mail app may have cut it: copy the whole link from the e-mail, or request a new one below.",
      actions: type === "email" || type === "signup" ? ["resend_confirmation", "sign_in"] : ["reset_link", "sign_in"],
    };
  }
  switch (type) {
    case "email":
    case "signup":
      return {
        title: "This confirmation link was already used or has expired",
        body: `If you already confirmed your e-mail, you're done here: sign in below. If you never got that far, type your e-mail and we'll send a fresh confirmation. ${ANY_DEVICE}`,
        actions: ["sign_in", "resend_confirmation"],
      };
    case "recovery":
      return {
        title: "This password reset link was already used or has expired",
        body: `Request a new reset link and open it soon after it arrives. ${ANY_DEVICE}`,
        actions: ["reset_link"],
      };
    case "invite":
      return {
        title: "This invitation has expired",
        body: `Invitations only work for a limited time after they're sent. Ask the admin who invited you to send a new one, or use "Send a new password reset link" with the invited address: that also finishes setting up the account. ${ANY_DEVICE}`,
        actions: ["reset_link", "contact_admin"],
      };
    case "email_change":
      return {
        title: "This e-mail change link has expired",
        body: `Your e-mail wasn't changed. Sign in with your current e-mail and start the change again from Settings › Account. ${ANY_DEVICE}`,
        actions: ["sign_in", "settings"],
      };
    case "magiclink":
      return {
        title: "This sign-in link was already used or has expired",
        body: `Sign in with your e-mail and password below, or request a password reset link if you don't have one. ${ANY_DEVICE}`,
        actions: ["sign_in", "reset_link"],
      };
    default:
      return {
        title: "This link didn't work",
        body: `It may have been used already, expired, or opened by a link checker in your mail app. Request a new one below. ${ANY_DEVICE}`,
        actions: ["reset_link", "resend_confirmation"],
      };
  }
}

export const SUPPORT_EMAIL = LEGAL.contactEmail;

/**
 * Review A4: the fixed sentences around an e-mail link that changes which
 * account this browser is signed in to. The e-mail is always the one the Auth
 * server returned for the session (getUser), never a query parameter.
 */
export function switchedAccountNotice(email: string): { title: string; body: string } {
  return {
    title: `You're now signed in as ${email}`,
    body: "The link you opened belongs to this account, so this browser was switched to it. The account that was signed in here before has been signed out of this browser.",
  };
}

/** Review A4: on the Continue page, when this browser already has a session. */
export function alreadySignedInNotice(email: string): string {
  return `You're signed in as ${email}. Continuing will switch this browser to the account this link belongs to.`;
}

/**
 * Review A6: what a visitor who is ALREADY signed in is told when an e-mail
 * link failed (they never see the sign-in page's notice: the proxy sends a
 * signed-in visitor on). Shown above the dashboard or the request page; the
 * query flags only choose among these fixed sentences.
 */
export function signedInLinkNotice(type: string | null, reason: string | null): { title: string; body: string } {
  if (reason === "busy") {
    return {
      title: "We couldn't check your link just now",
      body: "That was a problem on our side or with the connection, not with your link: it is still good. Wait a few minutes, then open it from your e-mail again. Nothing was changed.",
    };
  }
  if (reason === "malformed") {
    return {
      title: "That link was incomplete",
      body: "Part of the link was missing, so nothing was changed. A mail app may have cut it: copy the whole link from the e-mail and open it again.",
    };
  }
  if (reason === "banned") {
    return {
      title: "That link's account can't sign in right now",
      body: `Sign-in is blocked for the account the link belongs to, so nothing was changed here. If you think that's a mistake, write to ${LEGAL.contactEmail}.`,
    };
  }
  switch (type) {
    case "email_change":
      return {
        title: "That e-mail change link was already used or has expired",
        body: "Nothing was changed by it. Check the address in Settings › Account: if it isn't the new one, start the change again there.",
      };
    case "recovery":
      return {
        title: "That password reset link was already used or has expired",
        body: "Your password wasn't changed by it. You can change it in Settings › Security, or request a new reset link from the sign-in page.",
      };
    case "invite":
      return {
        title: "That invitation link was already used or has expired",
        body: "Nothing was changed by it. If it was for this account, you're already in; to choose a password, use Settings › Security.",
      };
    case "signup":
    case "email":
      return {
        title: "That confirmation link was already used or has expired",
        body: "Nothing was changed by it. If it was for this account, your e-mail is already confirmed and there is nothing more to do.",
      };
    case "magiclink":
      return {
        title: "That sign-in link was already used or has expired",
        body: "Nothing was changed by it; you're still signed in.",
      };
    default:
      return {
        title: "That link didn't work",
        body: "It was already used or has expired, so nothing was changed; you're still signed in.",
      };
  }
}

/** A 429 from Supabase Auth: the wait, when the response says how long. */
export function retryAfterMinutes(err: unknown): number {
  const headers = (err as { headers?: unknown } | null)?.headers;
  const raw = headers instanceof Headers ? headers.get("retry-after") : null;
  const seconds = raw && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
  if (Number.isFinite(seconds) && seconds > 0) return Math.max(1, Math.ceil(seconds / 60));
  const message = String((err as { message?: unknown } | null)?.message ?? "");
  const m = /after (\d+) (second|minute)s?/i.exec(message);
  if (m) return m[2].toLowerCase().startsWith("minute") ? Number(m[1]) : Math.max(1, Math.ceil(Number(m[1]) / 60));
  return 0;
}

/** WU-05: the honest line for a send that Supabase refused (429). */
export function tooManyEmailsMessage(err: unknown): string {
  const minutes = retryAfterMinutes(err);
  const wait = minutes > 0 ? `${minutes} minute${minutes === 1 ? "" : "s"}` : "a few minutes";
  return `Too many e-mails were sent just now, so this one wasn't. Try again in ${wait}.`;
}

/** Supabase answers 429 with one of these for a refused e-mail or request. */
export function isRateLimited(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  const status = (err as { status?: unknown } | null)?.status;
  return code === "over_email_send_rate_limit" || code === "over_request_rate_limit" || status === 429;
}

/**
 * Review A7 / A8: what the forgot-password form and "Resend confirmation"
 * show for a request that sends an e-mail to a typed address.
 *
 * The answer must not tell an account apart from no account. Supabase sends
 * nothing for an unknown address and answers 200, so every refusal that only
 * an actual send can trigger is an oracle if the page words it differently:
 * the per-address 60 second cooldown and the project's hourly e-mail cap both
 * answer 429 `over_email_send_rate_limit`, and only for an address that
 * exists. Those get the SAME sentence as a send ("…is on its way. You can ask
 * again in a minute."), which is also true for the cooldown: an e-mail went
 * out less than a minute ago.
 *
 * Honest wording stays where the refusal does not depend on the address: a
 * per-network request limit (`over_request_rate_limit`), and a failure to
 * reach or get an answer from the server at all (offline, a 5xx, a thrown
 * error), where "check your inbox" would simply be untrue (A8).
 *
 * What the app cannot change: the same oracle exists at the Supabase endpoint
 * itself for anyone holding the public anon key (docs/ACCOUNT_SECURITY.md).
 */
export const EMAIL_REQUEST_ANSWER = "If an account exists for that address, an e-mail is on its way. You can ask again in a minute.";
export const EMAIL_REQUEST_FAILED = "We couldn't send that just now. Check your connection and try again.";

export type EmailRequestOutcome = { kind: "sent" } | { kind: "error"; message: string };

export function emailRequestOutcome(err: unknown): EmailRequestOutcome {
  if (!err) return { kind: "sent" };
  const code = (err as { code?: unknown }).code;
  const status = (err as { status?: unknown }).status;
  const name = (err as { name?: unknown }).name;
  const message = String((err as { message?: unknown }).message ?? "");
  // Only a real send can hit these, so they must look like one.
  if (code === "over_email_send_rate_limit" || /only request this after|e-?mail rate limit/i.test(message)) return { kind: "sent" };
  if (code === "over_request_rate_limit" || status === 429) {
    const minutes = retryAfterMinutes(err);
    const wait = minutes > 0 ? `${minutes} minute${minutes === 1 ? "" : "s"}` : "a few minutes";
    return { kind: "error", message: `Too many requests from this network just now. Wait ${wait}, then try again.` };
  }
  if (code === "email_address_invalid" || code === "validation_failed") return { kind: "error", message: COMMON.email_address_invalid };
  // Not an answer from the Auth server at all, or one that says it failed.
  if (name === "AuthRetryableFetchError" || name === "AuthUnknownError" || typeof status !== "number" || status === 0 || status >= 500) {
    return { kind: "error", message: EMAIL_REQUEST_FAILED };
  }
  // Any other refusal: never more specific than a send.
  return { kind: "sent" };
}

export type AuthContext = "signin" | "signup" | "password";

const COMMON: Record<string, string> = {
  invalid_credentials: "That email and password don't match. Try again.",
  email_not_confirmed: "Confirm your email first: open the link we sent you, or resend it below.",
  user_already_exists: "An account with that email already exists. Sign in instead.",
  email_exists: "An account with that email already exists. Sign in instead.",
  weak_password: PASSWORD_RULE_MESSAGE,
  same_password: "That's your current password. Choose a different one.",
  validation_failed: "Check your email and password and try again.",
  email_address_invalid: "That doesn't look like an e-mail address we can send to. Check it and try again.",
  email_address_not_authorized: "That e-mail address can't be used here. Try another, or write to " + LEGAL.contactEmail + ".",
  signup_disabled: "New accounts are closed right now. Write to " + LEGAL.contactEmail + " and we'll help.",
  user_banned: "This account is closed. If you think that's a mistake, write to " + LEGAL.contactEmail + ".",
  email_provider_disabled: "E-mail sign-in is switched off right now. Write to " + LEGAL.contactEmail + ".",
  insufficient_aal: "Enter your two-factor code first, then try again.",
  otp_expired: "That link has expired. Request a new one.",
  reauthentication_needed: "For safety, sign in again before changing this.",
  session_expired: "Your session ended. Sign in again.",
  session_not_found: "Your session ended. Sign in again.",
  unexpected_failure: "Something went wrong on our side. Try again in a minute.",
};

const FALLBACK: Record<AuthContext, string> = {
  signin: "We couldn't sign you in. Check your e-mail and password, or reset your password.",
  signup: `We couldn't create your login. Try again in a minute, or write to ${LEGAL.contactEmail}.`,
  password: "Couldn't update your password. Try again, or request a new reset link.",
};

export interface AuthErrorInfo {
  code: string | null;
  message: string;
  /** The provider's own sentence, for the error log only (never shown). */
  raw: string;
}

/** The sentence a creator sees for a Supabase Auth error; never the raw text. */
export function authErrorInfo(err: unknown, context: AuthContext): AuthErrorInfo {
  const code = typeof (err as { code?: unknown } | null)?.code === "string" ? ((err as { code: string }).code) : null;
  const raw = String((err as { message?: unknown } | null)?.message ?? "");
  if (isRateLimited(err)) {
    return {
      code: code ?? "rate_limited",
      message: code === "over_email_send_rate_limit" || /email/i.test(raw) ? tooManyEmailsMessage(err) : "Too many attempts. Wait a minute, then try again.",
      raw,
    };
  }
  // Supabase 500 "Error sending confirmation email" (WC-04): the login may or
  // may not exist yet; the honest next step is to wait, then sign in or retry.
  if (/sending (confirmation|recovery|magic link|invite|email change)? ?e-?mail/i.test(raw)) {
    return {
      code: "email_send_failed",
      message: `We couldn't send the e-mail. Try again in a minute; if it keeps failing, write to ${LEGAL.contactEmail}.`,
      raw,
    };
  }
  // The sign-up trigger refused the profile row (0073: a display name that is
  // reserved for staff, e-mail-shaped or otherwise unshowable). Supabase only
  // says "Database error saving new user"; the name is the one thing to change.
  if (context === "signup" && /database error saving new user/i.test(raw)) {
    return {
      code: "signup_profile_refused",
      message: `We couldn't create your login with that display name. Try another (no e-mail addresses, links or names reserved for FanFunnel staff), or leave it blank and add it later. Still stuck? Write to ${LEGAL.contactEmail}.`,
      raw,
    };
  }
  if (code && COMMON[code]) return { code, message: COMMON[code], raw };
  return { code, message: FALLBACK[context], raw };
}

export function authErrorMessage(err: unknown, context: AuthContext = "signin"): string {
  return authErrorInfo(err, context).message;
}

/** WU-01 / WG-01: what /login?suspended=1 says (the dashboard shows the same notice). */
export const SUSPENDED_LOGIN_MESSAGE = `This account is suspended. You can sign in and look at your dashboard, but changes can't be saved and your games are paused for fans until an admin reactivates it. Questions? Email ${LEGAL.contactEmail}.`;
