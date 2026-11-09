"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { safeNext } from "@/lib/auth/safeNext";
import TermsCheckbox from "@/components/TermsCheckbox";
import { isAcceptablePassword, PASSWORD_RULE_MESSAGE } from "@/lib/api/password";

/** /auth/callback and /auth/confirm send a failed e-mail link here. */
export const AUTH_LINK_MESSAGE =
  "This link was opened in a different browser than the one that asked for it, or it expired. Request a new one here and open it in the same browser.";

type Mode = "signin" | "signup";

// Map known Supabase auth error codes to specific, friendly copy (mirrors how
// SpinClient maps spin error codes). Falls back to the raw message, then a
// generic line, so nothing is ever swallowed.
const AUTH_MESSAGES: Record<string, string> = {
  invalid_credentials: "That email and password don't match. Try again.",
  email_not_confirmed: "Confirm your email first — check your inbox for the link.",
  user_already_exists: "An account with that email already exists. Sign in instead.",
  email_exists: "An account with that email already exists. Sign in instead.",
  weak_password: PASSWORD_RULE_MESSAGE,
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
  const next = safeNext(params.get("next"));

  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  // After "Close my account" the server signs the browser out and sends it here.
  const [msg, setMsg] = useState<string | null>(
    params.get("closed") === "1"
      ? "Your account is closed and its data deleted. Thanks for using FanFunnel."
      : null
  );
  const [error, setError] = useState<string | null>(null);
  const linkFailed = params.get("error") === "auth_link";
  const [resent, setResent] = useState(false);

  // A failed confirmation link: send the sign-up confirmation again to the
  // address typed above (Supabase answers the same whether or not it exists).
  async function resendConfirmation() {
    setError(null);
    if (!email.trim()) {
      setError("Type your email below, then tap “Resend confirmation email”.");
      return;
    }
    setBusy(true);
    try {
      await createClient().auth.resend({
        type: "signup",
        email: email.trim(),
        options: { emailRedirectTo: `${window.location.origin}/auth/callback?next=/pending` },
      });
    } catch {
      /* same answer either way: never reveal whether the address has an account */
    } finally {
      setBusy(false);
      setResent(true);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setMsg(null);
    const supabase = createClient();

    try {
      if (mode === "signup") {
        // The clickwrap is required to create an account (the button is also
        // disabled without it).
        if (!agreed) {
          setError("Please agree to the Terms of Service and Privacy Policy.");
          return;
        }
        // The same rule as reset, Settings and admin invites (api/password.ts).
        if (!isAcceptablePassword(password)) {
          setError(PASSWORD_RULE_MESSAGE);
          return;
        }
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            // M1: the name is shown on public pages, so a blank one stays
            // blank (never the e-mail); the creator can set it in Settings.
            data: displayName.trim() ? { display_name: displayName.trim() } : {},
            // Only the legacy {{ .ConfirmationURL }} link uses this; the current
            // templates link to the Site URL's /auth/confirm?next=/pending.
            emailRedirectTo: `${window.location.origin}/auth/callback?next=/pending`,
          },
        });
        if (error) throw error;
        // If email confirmation is on, there's no session yet.
        if (!data.session) {
          setMsg("Check your email to confirm, then sign in to request access.");
          setMode("signin");
          return;
        }
        // Signed in straight away: record the acceptance now (server-side: the
        // session user, the current Terms version, the server's clock). If this
        // fails, the access-request form records it instead.
        await fetch("/api/account/terms", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ accept: true }),
        }).catch(() => {});
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
        // Two-factor: an account with a verified authenticator signs in at
        // aal1 and must enter a code (aal2) before the dashboard. The proxy
        // enforces it server-side; this just goes straight to the code step.
        const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
        if (aal?.nextLevel === "aal2" && aal.currentLevel !== "aal2") {
          router.push("/mfa?next=" + encodeURIComponent(next));
          router.refresh();
          return;
        }
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

      {linkFailed && (
        <div data-testid="auth-link-error" role="alert" className="mt-4 rounded-xl border border-amber-300/30 bg-amber-300/10 p-3 text-sm text-amber-100">
          <p>{AUTH_LINK_MESSAGE}</p>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
            <Link href="/forgot-password" className="font-semibold text-white underline underline-offset-4">
              Send a new password reset link
            </Link>
            <button
              type="button"
              onClick={resendConfirmation}
              disabled={busy}
              className="font-semibold text-white underline underline-offset-4 disabled:opacity-50"
            >
              Resend confirmation email
            </button>
          </div>
          {resent && (
            <p role="status" className="mt-2 text-green-300">
              If that address has an unconfirmed account, a new confirmation link is on its way.
            </p>
          )}
        </div>
      )}

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
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "login-error" : undefined}
          className="ff-input w-full"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <input
          type="password"
          required
          minLength={mode === "signup" ? 8 : undefined}
          autoComplete={mode === "signin" ? "current-password" : "new-password"}
          aria-label="Password"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "login-error" : undefined}
          className="ff-input w-full"
          placeholder={mode === "signup" ? "Password (8+ chars, a letter and a number)" : "Password"}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {mode === "signup" && <TermsCheckbox checked={agreed} onChange={setAgreed} disabled={busy} />}
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
        <p id="login-error" role="alert" className="mt-3 text-sm text-amber-300">
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
        disabled={busy || (mode === "signup" && !agreed)}
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
