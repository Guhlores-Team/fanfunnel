"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { EMAIL_REQUEST_ANSWER, emailRequestOutcome } from "@/lib/auth/authCopy";

/**
 * "Resend confirmation email" for a login whose confirmation link was lost,
 * used or scanned (WU-03, WU-10). The answer is the forgot-password form's,
 * word for word, for any address: Supabase's per-address cooldown and e-mail
 * cap only ever answer for an address that has a login, so they are shown as
 * a send too (review A7). Only a failure that does not depend on the address
 * (offline, a 5xx, a per-network limit) is worded as one: emailRequestOutcome.
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
    const outcome = emailRequestOutcome(err);
    if (outcome.kind === "error") setStatus({ tone: "error", text: outcome.message });
    else setStatus({ tone: "ok", text: `${EMAIL_REQUEST_ANSWER} Already confirmed? Just sign in.` });
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
