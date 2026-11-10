"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { isRateLimited, tooManyEmailsMessage } from "@/lib/auth/authCopy";

/**
 * "Resend confirmation email" for a login whose confirmation link was lost,
 * used or scanned (WU-03, WU-10). Supabase answers the same whether or not the
 * address exists; only a rate limit (WU-05) is reported, and it reveals
 * nothing about the address either.
 */
export default function ResendConfirmation({
  email,
  onNeedEmail,
  className = "font-semibold text-white underline underline-offset-4 disabled:opacity-50",
}: {
  email: string;
  onNeedEmail?: () => void;
  className?: string;
}) {
  const [status, setStatus] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function resend() {
    if (!email.trim()) {
      setStatus({ tone: "error", text: "Type your email in the form, then tap “Resend confirmation email”." });
      onNeedEmail?.();
      return;
    }
    setBusy(true);
    setStatus(null);
    let err: unknown = null;
    try {
      const { error } = await createClient().auth.resend({
        type: "signup",
        email: email.trim(),
        options: { emailRedirectTo: `${window.location.origin}/auth/callback?next=/pending` },
      });
      err = error;
    } catch (e) {
      err = e;
    } finally {
      setBusy(false);
    }
    if (err && isRateLimited(err)) setStatus({ tone: "error", text: tooManyEmailsMessage(err) });
    else setStatus({ tone: "ok", text: "If that address has an unconfirmed login, a new confirmation link is on its way. Already confirmed? Just sign in." });
  }

  return (
    <>
      <button type="button" onClick={resend} disabled={busy} className={className}>
        Resend confirmation email
      </button>
      {status && (
        <p role="status" data-testid="resend-status" className={`mt-2 basis-full text-sm ${status.tone === "ok" ? "text-green-300" : "text-amber-200"}`}>
          {status.text}
        </p>
      )}
    </>
  );
}
