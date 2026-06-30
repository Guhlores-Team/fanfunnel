"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";

// Set a new password. Reached via the recovery email → /auth/callback, which
// establishes a (recovery) session before redirecting here. We confirm a session
// exists, then call updateUser({ password }). Without a session the link was bad
// or expired, so we point the user back to request a fresh one.
export default function ResetPasswordPage() {
  const router = useRouter();
  const [checking, setChecking] = useState(true);
  const [hasSession, setHasSession] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getSession().then(({ data }) => {
      setHasSession(Boolean(data.session));
      setChecking(false);
    });
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
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
          {checking ? (
            <p className="text-sm text-white/60">Checking your reset link…</p>
          ) : !hasSession ? (
            <>
              <h1 className="text-lg font-bold">Link expired</h1>
              <p className="mt-2 text-sm text-white/60">
                This reset link is invalid or has expired. Request a fresh one.
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
              <h1 className="text-lg font-bold">Password updated</h1>
              <p className="mt-2 text-sm text-white/60">
                You&rsquo;re signed in — taking you to your dashboard…
              </p>
            </>
          ) : (
            <form onSubmit={submit}>
              <h1 className="text-lg font-bold">Choose a new password</h1>
              <p className="mt-1 text-sm text-white/50">
                Enter a new password for your account.
              </p>
              <input
                type="password"
                required
                minLength={6}
                autoComplete="new-password"
                aria-label="New password"
                className="ff-input mt-5 w-full"
                placeholder="New password (min 6 chars)"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              {error && (
                <p role="alert" className="mt-3 text-sm text-amber-300">
                  {error}
                </p>
              )}
              <button
                type="submit"
                disabled={busy}
                className="mt-5 w-full rounded-xl bg-pink-600 py-2.5 font-bold text-white hover:bg-pink-500 disabled:opacity-50"
              >
                {busy ? "…" : "Update password"}
              </button>
            </form>
          )}
        </div>
      </div>
    </main>
  );
}
