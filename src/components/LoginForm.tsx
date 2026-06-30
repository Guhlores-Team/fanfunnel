"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

type Mode = "signin" | "signup";

// Map known Supabase auth error codes to specific, friendly copy (mirrors how
// SpinClient maps spin error codes). Falls back to the raw message, then a
// generic line, so nothing is ever swallowed.
const AUTH_MESSAGES: Record<string, string> = {
  invalid_credentials: "That email and password don't match. Try again.",
  email_not_confirmed: "Confirm your email first — check your inbox for the link.",
  user_already_exists: "An account with that email already exists. Sign in instead.",
  email_exists: "An account with that email already exists. Sign in instead.",
  weak_password: "Pick a stronger password (at least 6 characters).",
  over_request_rate_limit: "Too many attempts — wait a moment and try again.",
  validation_failed: "Check your email and password and try again.",
};

function authErrorMessage(err: unknown): string {
  if (err && typeof err === "object") {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string" && AUTH_MESSAGES[code]) return AUTH_MESSAGES[code];
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string" && message) return message;
  }
  return "Something went wrong. Try again.";
}

export default function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next") || "/dashboard";

  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setMsg(null);
    const supabase = createClient();

    try {
      if (mode === "signup") {
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: { data: { display_name: displayName || email } },
        });
        if (error) throw error;
        // If email confirmation is on, there's no session yet.
        if (!data.session) {
          setMsg("Check your email to confirm, then sign in to request access.");
          setMode("signin");
          return;
        }
        // New accounts are pending approval → send them to the request page.
        router.push("/pending");
        router.refresh();
        return;
      } else {
        const { error } = await supabase.auth.signInWithPassword({
          email,
          password,
        });
        if (error) throw error;
      }
      router.push(next);
      router.refresh();
    } catch (err) {
      setError(authErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="rounded-2xl border border-white/10 bg-white/5 p-6 text-white"
    >
      <h1 className="text-lg font-bold">
        {mode === "signin" ? "Sign in" : "Request creator access"}
      </h1>
      <p className="mt-1 text-sm text-white/50">
        {mode === "signin"
          ? "Welcome back to your creator dashboard."
          : "Creator accounts are reviewed by hand — sign up, then tell us about you."}
      </p>

      <div className="mt-5 space-y-3">
        {mode === "signup" && (
          <input
            aria-label="Display name"
            className="ff-input w-full"
            placeholder="Display name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
        )}
        <input
          type="email"
          required
          autoComplete="email"
          aria-label="Email address"
          className="ff-input w-full"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <input
          type="password"
          required
          minLength={6}
          autoComplete={mode === "signin" ? "current-password" : "new-password"}
          aria-label="Password"
          className="ff-input w-full"
          placeholder="Password (min 6 chars)"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {mode === "signin" && (
          <div className="text-right">
            <Link
              href="/forgot-password"
              className="text-xs text-white/50 hover:text-white"
            >
              Forgot password?
            </Link>
          </div>
        )}
      </div>

      {error && (
        <p role="alert" className="mt-3 text-sm text-amber-300">
          {error}
        </p>
      )}
      {msg && (
        <p role="status" className="mt-3 text-sm text-green-300">
          {msg}
        </p>
      )}

      <button
        type="submit"
        disabled={busy}
        className="mt-5 w-full rounded-xl bg-pink-600 py-2.5 font-bold text-white hover:bg-pink-500 disabled:opacity-50"
      >
        {busy ? "…" : mode === "signin" ? "Sign in" : "Request access"}
      </button>

      <button
        type="button"
        onClick={() => {
          setMode(mode === "signin" ? "signup" : "signin");
          setError(null);
          setMsg(null);
        }}
        className="mt-4 w-full text-center text-sm text-white/50 hover:text-white"
      >
        {mode === "signin"
          ? "Want a creator account? Request access"
          : "Already have an account? Sign in"}
      </button>
    </form>
  );
}
