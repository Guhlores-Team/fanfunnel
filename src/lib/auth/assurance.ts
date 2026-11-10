import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Two-factor (Supabase Auth MFA) state of a signed-in session.
 *
 * `aal` is the Authenticator Assurance Level in the session's access token:
 * "aal1" after a password sign-in, "aal2" only after a verified TOTP challenge.
 * Supabase Auth signs it, and the database reads the same claim (is_admin()
 * requires aal2, migration 0054), so it is a server-controlled value, not
 * user-editable metadata.
 *
 * `hasVerifiedFactor` comes from the user object `getUser()` returns, which the
 * Auth server builds; an unverified (half-enrolled) factor does not count.
 */
export type Aal = "aal1" | "aal2";
export type MfaStep = "ok" | "enrol" | "challenge";

export interface SessionAssurance {
  aal: Aal | null;
  hasVerifiedFactor: boolean;
}

type FactorLike = { status?: unknown };

/** Decode the `aal` claim of a JWT. No signature check: call it only on a token
 *  the Auth server has just accepted (getUser), as getSessionAssurance does. */
export function aalFromAccessToken(token: string | null | undefined): Aal | null {
  const json = decodeClaims(token) as { aal?: unknown } | null;
  if (!json) return null;
  return json.aal === "aal2" ? "aal2" : json.aal === "aal1" ? "aal1" : null;
}

function decodeClaims(token: string | null | undefined): unknown {
  if (!token) return null;
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const json = JSON.parse(
      typeof atob === "function"
        ? atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "="))
        : Buffer.from(b64, "base64").toString("utf8")
    ) as unknown;
    return json && typeof json === "object" ? json : null;
  } catch {
    return null;
  }
}

/**
 * The `amr` claim (authentication method references) of a Supabase access
 * token: one entry per method the session used, newest first, each with the
 * Auth server's own timestamp. "recovery" and "invite" mean the session was
 * opened by the matching e-mail link (verifyOtp). Like the aal claim it is
 * signed by the Auth server; read it only from a token getUser() accepted.
 */
export function amrFromAccessToken(token: string | null | undefined): { method: string; timestamp: number }[] {
  const claims = decodeClaims(token) as { amr?: unknown } | null;
  if (!claims || !Array.isArray(claims.amr)) return [];
  return claims.amr
    .filter((e): e is { method: string; timestamp?: unknown } => !!e && typeof e === "object" && typeof (e as { method?: unknown }).method === "string")
    .map((e) => ({ method: e.method, timestamp: typeof e.timestamp === "number" ? e.timestamp : 0 }));
}

/** How long an e-mail link's session may set a password without the current one. */
export const LINK_SESSION_MAX_AGE_MS = 2 * 60 * 60 * 1000;

/**
 * WU-06: /reset-password and /set-password may set a password without the
 * current one only on a session that an e-mail link opened recently
 * ("recovery" or "invite" in amr, within LINK_SESSION_MAX_AGE_MS). Any other
 * session (a creator's ordinary sign-in on an unlocked laptop) must give the
 * current password, exactly as Settings › Security does.
 */
export function openedByRecentLink(token: string | null | undefined, now = Date.now()): boolean {
  return amrFromAccessToken(token).some(
    (e) => (e.method === "recovery" || e.method === "invite") && e.timestamp > 0 && now - e.timestamp * 1000 <= LINK_SESSION_MAX_AGE_MS
  );
}

/** True when the user has at least one VERIFIED MFA factor. */
export function hasVerifiedFactor(user: { factors?: FactorLike[] | null } | null | undefined): boolean {
  return (user?.factors ?? []).some((f) => f?.status === "verified");
}

/**
 * What a session still needs before a two-factor-gated action:
 *   ok        — the session is aal2 (or 2FA is neither required nor enrolled)
 *   challenge — a verified factor exists, but this session hasn't used it yet
 *   enrol     — 2FA is required here and the user has no verified factor
 */
export function mfaStep(a: SessionAssurance, required: boolean): MfaStep {
  if (a.aal === "aal2") return "ok";
  if (a.hasVerifiedFactor) return "challenge";
  return required ? "enrol" : "ok";
}

export type AssuranceClient = Pick<SupabaseClient, "auth">;

/**
 * The signed-in user plus their session's assurance. `getUser()` asks the Auth
 * server (so the user, its factors and the session token are verified), then
 * the aal claim is read from that same session's access token.
 */
export async function getSessionAssurance(sb: AssuranceClient): Promise<{
  userId: string | null;
  email: string | null;
  assurance: SessionAssurance;
}> {
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { userId: null, email: null, assurance: { aal: null, hasVerifiedFactor: false } };
  const {
    data: { session },
  } = await sb.auth.getSession();
  return {
    userId: user.id,
    email: user.email ?? null,
    assurance: {
      aal: aalFromAccessToken(session?.access_token),
      hasVerifiedFactor: hasVerifiedFactor(user),
    },
  };
}
