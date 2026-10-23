"use client";

import { useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";

// Self-serve password reset request. Sends a Supabase recovery email whose link
// returns to /auth/callback (which establishes a session) then /reset-password.
// Always shows the same "check your inbox" state — even on error — so the page
// can't be used to probe which emails have accounts (enumeration).
export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const supabase = createClient();
      const redirectTo = `${window.location.origin}/auth/callback?next=/reset-password`;
      await supabase.auth.resetPasswordForEmail(email, { redirectTo });
    } catch {
      /* swallow — never reveal whether the address exists */
    } finally {
      setBusy(false);
      setSent(true);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-gradient-to-b from-zinc-950 via-zinc-900 to-black px-4">
      <div className="w-full max-w-sm">
        <Link
          href="/"
          className="mb-6 block text-center text-2xl font-extrabold text-white"
        >
          🎡 FanFunnel
        </Link>

        {sent ? (
          <div className="rounded-2xl border border-white/10 bg-white/5 p-6 text-white">
            <h1 className="text-lg font-bold">Check your inbox</h1>
            <p className="mt-2 text-sm text-white/60">
              If an account exists for <span className="font-medium">{email}</span>,
              we&rsquo;ve sent a link to reset your password. It expires soon, so
              use it shortly.
            </p>
            <Link
              href="/login"
              className="mt-5 inline-block text-sm text-white/50 hover:text-white"
            >
              ← Back to sign in
            </Link>
          </div>
        ) : (
          <form
            onSubmit={submit}
            className="rounded-2xl border border-white/10 bg-white/5 p-6 text-white"
          >
            <h1 className="text-lg font-bold">Reset your password</h1>
            <p className="mt-1 text-sm text-white/50">
              Enter your account email and we&rsquo;ll send you a reset link.
            </p>

            <input
              type="email"
              required
              autoComplete="email"
              aria-label="Email address"
              className="ff-input mt-5 w-full"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />

            <button
              type="submit"
              disabled={busy}
              className="mt-5 w-full rounded-xl bg-pink-600 py-2.5 font-bold text-white hover:bg-pink-500 disabled:opacity-50"
            >
              {busy ? "…" : "Send reset link"}
            </button>

            <Link
              href="/login"
              className="mt-4 block text-center text-sm text-white/50 hover:text-white"
            >
              ← Back to sign in
            </Link>
          </form>
        )}
      </div>
    </main>
  );
}
