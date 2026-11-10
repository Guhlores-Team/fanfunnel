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
