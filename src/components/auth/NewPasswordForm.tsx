"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient, isSupabaseConfigured } from "@/lib/supabase/client";
import { isAcceptablePassword, PASSWORD_RULE_MESSAGE } from "@/lib/api/password";

// Set a new password. Reached through an e-mail link → /auth/callback or
// /auth/confirm, which establishes a session before redirecting here:
// "reset" from the recovery e-mail (/reset-password), "welcome" from an admin's
// invite (/set-password). We confirm a session exists, then call
// updateUser({ password }). Without a session the link was bad or expired, so
// we point the user back to request a fresh one.
const COPY = {
  reset: {
    checking: "Checking your reset link…",
    expiredBody: "This reset link is invalid or has expired. Request a fresh one.",
    title: "Choose a new password",
    intro: "Enter a new password for your account.",
    label: "New password",
    cta: "Update password",
    doneTitle: "Password updated",
  },
  welcome: {
    checking: "Checking your invite…",
    expiredBody:
      "This invite link is invalid or has expired. Use “Forgot password” with the invited address to get a fresh link, or ask the admin who invited you.",
    title: "Welcome to FanFunnel",
    intro: "Your creator account is ready. Choose a password to finish setting it up.",
    label: "Password",
    cta: "Set password",
    doneTitle: "Password set",
  },
} as const;

export default function NewPasswordForm({ variant }: { variant: keyof typeof COPY }) {
  const copy = COPY[variant];
  const router = useRouter();
  // Without Supabase (demo mode) there are no accounts: creating a client
  // would throw on the missing URL and crash the page (QA b5 m10).
  const [configured] = useState(isSupabaseConfigured);
  const [checking, setChecking] = useState(configured);
  const [hasSession, setHasSession] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!configured) return;
    let live = true;
    try {
      createClient().auth.getSession().then(({ data }) => {
        if (!live) return;
        setHasSession(Boolean(data.session));
        setChecking(false);
      }, () => { if (live) setChecking(false); });
    } catch {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- a client that can't start means no session to use
      setChecking(false);
    }
    return () => { live = false; };
  }, [configured]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!isAcceptablePassword(password)) {
      setError(PASSWORD_RULE_MESSAGE);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const supabase = createClient();
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
      setDone(true);
      setTimeout(() => {
        router.push("/dashboard");
        router.refresh();
      }, 1200);
    } catch (err) {
      const message =
        err && typeof err === "object" && "message" in err
          ? String((err as { message?: unknown }).message)
          : "Couldn't update your password. Try the reset link again.";
      setError(message);
    } finally {
      setBusy(false);
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

        <div className="rounded-2xl border border-white/10 bg-white/5 p-6 text-white">
          {!configured ? (
            <>
              <h1 className="text-lg font-bold">Password reset isn&rsquo;t available here</h1>
              <p className="mt-2 text-sm text-white/60">
                This is the demo workspace, which has no accounts or passwords. Open the dashboard to keep exploring.
              </p>
              <Link
                href="/dashboard"
                className="mt-5 inline-block rounded-xl bg-pink-600 px-4 py-2 text-sm font-bold text-white hover:bg-pink-500"
              >
                Open the demo dashboard
              </Link>
            </>
          ) : checking ? (
            <p className="text-sm text-white/60">{copy.checking}</p>
          ) : !hasSession ? (
            <>
              <h1 className="text-lg font-bold">Link expired</h1>
              <p className="mt-2 text-sm text-white/60">
                {copy.expiredBody}
              </p>
              <Link
                href="/forgot-password"
                className="mt-5 inline-block rounded-xl bg-pink-600 px-4 py-2 text-sm font-bold text-white hover:bg-pink-500"
              >
                Send a new link
              </Link>
            </>
          ) : done ? (
            <>
              <h1 className="text-lg font-bold">{copy.doneTitle}</h1>
              <p className="mt-2 text-sm text-white/60">
                You&rsquo;re signed in — taking you to your dashboard…
              </p>
            </>
          ) : (
            <form onSubmit={submit}>
              <h1 className="text-lg font-bold">{copy.title}</h1>
              <p className="mt-1 text-sm text-white/50">{copy.intro}</p>
              <input
                type="password"
                required
                minLength={8}
                autoComplete="new-password"
                aria-label={copy.label}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? "reset-error" : undefined}
                className="ff-input mt-5 w-full"
                placeholder="8+ characters, a letter and a number"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              {error && (
                <p id="reset-error" role="alert" className="mt-3 text-sm text-amber-300">
                  {error}
                </p>
              )}
              <button
                type="submit"
                disabled={busy}
                className="mt-5 w-full rounded-xl bg-pink-600 py-2.5 font-bold text-white hover:bg-pink-500 disabled:opacity-50"
              >
                {busy ? "…" : copy.cta}
              </button>
            </form>
          )}
        </div>
      </div>
    </main>
  );
}
