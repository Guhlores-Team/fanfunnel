"use client";

import Link from "next/link";
import ResendConfirmation from "./ResendConfirmation";
import { authLinkNotice, SUPPORT_EMAIL, type AuthLinkAction } from "@/lib/auth/authCopy";

/**
 * The failed e-mail link notice on /login?error=auth_link&type=…&reason=…
 * (WU-03). The copy is per link type; the actions are the ones that fit.
 * "Resend confirmation" needs the e-mail typed in the form below (`email`)
 * and a configured Supabase (`canResend`); the demo shows the notice only.
 */
export default function AuthLinkNotice({
  type,
  reason,
  email,
  canResend,
  onNeedEmail,
}: {
  type: string | null;
  reason: string | null;
  email: string;
  canResend: boolean;
  onNeedEmail?: () => void;
}) {
  const copy = authLinkNotice(type, reason);

  const action = (a: AuthLinkAction) => {
    switch (a) {
      case "reset_link":
        return (
          <Link key={a} href="/forgot-password" className="font-semibold text-white underline underline-offset-4">
            Send a new password reset link
          </Link>
        );
      case "resend_confirmation":
        return canResend ? <ResendConfirmation key={a} email={email} onNeedEmail={onNeedEmail} /> : null;
      case "sign_in":
        return (
          <span key={a} className="font-semibold text-white">
            Sign in below
          </span>
        );
      case "settings":
        return (
          <Link key={a} href="/dashboard?section=settings" className="font-semibold text-white underline underline-offset-4">
            Open Settings
          </Link>
        );
      case "contact_admin":
        return (
          <a key={a} href={`mailto:${SUPPORT_EMAIL}`} className="font-semibold text-white underline underline-offset-4">
            Ask for a new invitation
          </a>
        );
    }
  };

  return (
    <div
      data-testid="auth-link-error"
      data-link-type={type ?? ""}
      data-link-reason={reason ?? ""}
      role="alert"
      className="mt-4 rounded-xl border border-amber-300/30 bg-amber-300/10 p-3 text-sm text-amber-100"
    >
      <p className="font-bold text-amber-50">{copy.title}</p>
      <p className="mt-1">{copy.body}</p>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">{copy.actions.map(action)}</div>
    </div>
  );
}
