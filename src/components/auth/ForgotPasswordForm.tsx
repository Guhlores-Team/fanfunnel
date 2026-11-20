"use client";

import { useState } from "react";
import Link from "next/link";
import { createClient, isSupabaseConfigured } from "@/lib/supabase/client";
import { EMAIL_REQUEST_ANSWER, emailRequestOutcome } from "@/lib/auth/authCopy";

// Self-serve password reset request. Sends a Supabase recovery email whose link
// lands on /auth/confirm (Continue button) then /reset-password. The page shows
// the same "check your inbox" state for any address, known or not, INCLUDING
// when Supabase refused the send for that address (its per-address cooldown
// and the hourly e-mail cap only ever answer for an address that exists, so
// wording them differently would tell which e-mails have accounts; review
// A7). A request that never got an answer (offline, a 5xx, a thrown error) or
// a per-network limit says so honestly (A8): see emailRequestOutcome.
export default function ForgotPasswordForm() {
  const [configured] = useState(isSupabaseConfigured);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    let err: unknown = null;
    try {
      const supabase = createClient();
      const redirectTo = `${window.location.origin}/auth/callback?next=/reset-password`;
      const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo });
      err = error;
    } catch (e) {
      err = e;
    } finally {
      setBusy(false);
    }
    const outcome = emailRequestOutcome(err);
    if (outcome.kind === "error") {
      setError(outcome.message);
      return;
    }
    setSent(true);
  }

  if (!configured) {
    return (
      <div className="rounded-2xl border border-white/10 bg-white/5 p-6 text-white">
        <h1 className="text-lg font-bold">Password reset isn&rsquo;t available here</h1>
        <p className="mt-2 text-sm text-white/60">This is the demo workspace, which has no accounts or passwords. Open the dashboard to keep exploring.</p>
        <Link href="/dashboard" className="mt-5 inline-flex min-h-11 items-center rounded-xl btn-brand px-4 py-2 text-sm font-bold">
          Open the demo dashboard
        </Link>
      </div>
    );
  }

  if (sent) {
    return (
      <div className="rounded-2xl border border-white/10 bg-white/5 p-6 text-white" data-testid="forgot-sent">
        <h1 className="text-lg font-bold">Check your inbox</h1>
        <p className="mt-2 text-sm text-white/60" data-testid="forgot-answer">
          {EMAIL_REQUEST_ANSWER}
        </p>
        <p className="mt-2 text-sm text-white/60">
          We used <span className="font-medium text-white/80">{email}</span>. The link works once, on any device, for a limited time: open it
          soon, tap Continue, and choose a new password.
        </p>
        <p className="mt-2 text-sm text-white/60">Nothing after a few minutes? Check spam, then ask again.</p>
        <button
          type="button"
          onClick={() => setSent(false)}
          className="mt-4 inline-flex min-h-11 items-center text-sm font-semibold text-white underline underline-offset-4"
        >
          Ask again
        </button>
        <Link href="/login" className="mt-1 flex min-h-11 items-center text-sm text-white/50 hover:text-white">
          ← Back to sign in
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="rounded-2xl border border-white/10 bg-white/5 p-6 text-white">
      <h1 className="text-lg font-bold">Reset your password</h1>
      <p className="mt-1 text-sm text-white/50">Enter your account email and we&rsquo;ll send you a reset link.</p>

      <label htmlFor="forgot-email" className="mt-5 block text-[11px] font-semibold uppercase tracking-[0.05em] text-white/60">
        Email address
      </label>
      <input
        id="forgot-email"
        name="email"
        type="email"
        required
        autoComplete="email"
        aria-label="Email address"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? "forgot-error" : undefined}
        className="ff-input mt-1 w-full"
        placeholder="you@example.com"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
      {error && (
        <p id="forgot-error" role="alert" data-testid="forgot-error" className="mt-3 text-sm text-amber-300">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={busy}
        className="mt-5 inline-flex min-h-11 w-full items-center justify-center rounded-xl btn-brand py-2.5 font-bold disabled:opacity-50"
      >
        {busy ? "…" : "Send reset link"}
      </button>

      <Link href="/login" className="mt-3 inline-flex min-h-11 w-full items-center justify-center text-center text-sm text-white/50 hover:text-white">
        ← Back to sign in
      </Link>
    </form>
  );
}
