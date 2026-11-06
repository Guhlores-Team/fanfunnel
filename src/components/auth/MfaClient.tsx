"use client";

import Link from "next/link";
import { TotpChallenge, TotpEnrol } from "./totp";

/**
 * The /mfa page body. "challenge": the account has an authenticator, so the
 * session must pass a code (aal2) before the dashboard. "enrol": an admin
 * without one must set it up before the admin area opens (anyone else can set
 * it up here or in Settings › Security).
 *
 * After success it does a full navigation (not a client route change) so the
 * server, the proxy and RLS all see the upgraded session cookie at once.
 */
export default function MfaClient({
  mode,
  next,
  reason,
  email,
}: {
  mode: "challenge" | "enrol";
  next: string;
  reason: "admin" | null;
  email: string | null;
}) {
  const done = () => window.location.assign(next);

  return (
    <div className="card w-full rounded-2xl p-6">
      <h1 className="text-lg font-bold text-ink">
        {mode === "challenge" ? "Enter your sign-in code" : "Set up two-factor sign-in"}
      </h1>
      <p className="mt-1 text-[13.5px] text-muted">
        {mode === "challenge"
          ? "Your account uses two-factor sign-in. Open your authenticator app and enter the 6-digit code for FanFunnel."
          : reason === "admin"
            ? "Admin tools need two-factor sign-in. Set it up once; after that you'll enter a code when you sign in."
            : "Add a code from an authenticator app to your sign-in, so a stolen password alone can't open your account."}
      </p>
      {email && (
        <p className="mt-2 text-xs text-muted">
          Signed in as <span className="break-all font-semibold text-ink">{email}</span>
        </p>
      )}
      <div className="mt-5">
        {mode === "challenge" ? (
          <TotpChallenge onVerified={done} submitLabel="Continue" />
        ) : (
          <TotpEnrol onEnrolled={done} />
        )}
      </div>
      <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4 text-xs text-muted">
        {mode === "enrol" && reason === "admin" ? (
          <Link href="/dashboard" className="underline underline-offset-4 hover:text-ink">
            Not now: go to my dashboard
          </Link>
        ) : (
          <span>Lost your authenticator? Ask a FanFunnel admin to reset it.</span>
        )}
        <form action="/auth/signout" method="post">
          <button type="submit" className="underline underline-offset-4 hover:text-ink">
            Sign out
          </button>
        </form>
      </div>
    </div>
  );
}
