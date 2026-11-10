"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { safeNext } from "@/lib/auth/safeNext";
import TermsCheckbox from "@/components/TermsCheckbox";
import { isAcceptablePassword, PASSWORD_RULE_MESSAGE } from "@/lib/api/password";
import { displayNameErrorMessage, displayNameInputError } from "@/lib/profileErrors";
import { authErrorInfo } from "@/lib/auth/authCopy";
import { reportClientError } from "@/lib/monitoring/client";
import AuthLinkNotice from "@/components/auth/AuthLinkNotice";
import PasswordField from "@/components/auth/PasswordField";
import ResendConfirmation from "@/components/auth/ResendConfirmation";
import LoginNotices, { type LoginParams } from "@/components/auth/LoginNotices";

export type Mode = "signin" | "signup";

/** WC-07: the three real steps of getting a creator account, named honestly. */
export const SIGNUP_STEPS = ["Create your login", "Confirm your e-mail", "Tell us about you"] as const;

/** The sign-in form. `params` are the page's query parameters, read server-side. */
export default function LoginForm({ params }: { params: LoginParams }) {
  const router = useRouter();
  const next = safeNext(params.next);

  const [mode, setMode] = useState<Mode>(params.mode === "signup" ? "signup" : "signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // WU-10: "confirm your e-mail first" offers the resend right there.
  const [offerResend, setOfferResend] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const firstRender = useRef(true);

  // WU-17: switching modes swaps the heading and fields; move focus to the new
  // heading so a screen reader announces where it landed.
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    headingRef.current?.focus();
  }, [mode]);

  const linkFailed = params.error === "auth_link";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setMsg(null);
    setOfferResend(false);
    const supabase = createClient();

    try {
      if (mode === "signup") {
        // The clickwrap is required to create an account (the button is also
        // disabled without it).
        if (!agreed) {
          setError("Please agree to the Terms of Service and Privacy Policy.");
          return;
        }
        // WG-15 / b6 C9: a typed name carries into the creator request, so it
        // is checked here the way Settings checks it (e-mail-shaped, reserved
        // for staff, links). It stays optional: a blank one stays blank (M1).
        const nameError = displayName.trim() ? displayNameInputError(displayName.trim()) : null;
        if (nameError) {
          setError(displayNameErrorMessage(nameError));
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
            // blank (never the e-mail). Display only: the profiles trigger
            // copies it; it never decides anything (AGENTS.md rule 1).
            data: displayName.trim() ? { display_name: displayName.trim() } : {},
            // Only the legacy {{ .ConfirmationURL }} link uses this; the current
            // templates link to the Site URL's /auth/confirm?next=/pending.
            emailRedirectTo: `${window.location.origin}/auth/callback?next=/pending`,
          },
        });
        if (error) throw error;
        // If email confirmation is on, there's no session yet.
        if (!data.session) {
          setMsg(
            `Step 1 done. We sent a confirmation link to ${email.trim()}: open it on any device (it works for 1 hour), then sign in here to tell us about you. That's the last step before we review your request.`
          );
          setMode("signin");
          setPassword("");
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
      const info = authErrorInfo(err, mode);
      setError(info.message);
      setOfferResend(info.code === "email_not_confirmed");
      // TS-11 / WC-04: the creator sees plain words; the provider's own
      // sentence goes to Admin › Errors (it never contains the e-mail).
      if (info.code === null || info.code === "unexpected_failure" || info.code === "email_send_failed") {
        reportClientError({ message: `auth ${mode}: ${info.code ?? "unknown"}: ${info.raw}`, kind: "error" });
      }
    } finally {
      setBusy(false);
    }
  }

  const focusEmail = () => emailRef.current?.focus();

  return (
    <form onSubmit={submit} className="rounded-2xl border border-white/10 bg-white/5 p-6 text-white" data-mode={mode}>
      {mode === "signup" && (
        <ol data-testid="signup-steps" className="mb-3 flex flex-wrap gap-x-3 gap-y-1 text-[11px] font-semibold uppercase tracking-wider text-white/50" aria-label="Steps to a creator account">
          {SIGNUP_STEPS.map((label, i) => (
            <li key={label} aria-current={i === 0 ? "step" : undefined} className={i === 0 ? "text-pink-300" : undefined}>
              {i + 1}. {label}
            </li>
          ))}
        </ol>
      )}
      <h1 ref={headingRef} tabIndex={-1} className="text-lg font-bold outline-none">
        {mode === "signin" ? "Sign in" : "Create your login"}
      </h1>
      <p className="mt-1 text-sm text-white/50">
        {mode === "signin"
          ? "Welcome back to your creator dashboard."
          : "Step 1 of 3. You'll confirm your e-mail next, then tell us about you; creator accounts are approved by hand."}
      </p>

      <LoginNotices params={params} />
      {linkFailed && <AuthLinkNotice type={params.type ?? null} reason={params.reason ?? null} email={email} canResend onNeedEmail={focusEmail} />}

      <div className="mt-5 space-y-3">
        {mode === "signup" && (
          <div>
            <label htmlFor="login-display-name" className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.05em] text-white/60">
              Display name (optional)
            </label>
            <input
              id="login-display-name"
              name="display_name"
              autoComplete="nickname"
              maxLength={80}
              aria-label="Display name"
              className="ff-input w-full"
              placeholder="Display name (how fans know you)"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </div>
        )}
        <div>
          <label htmlFor="login-email" className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.05em] text-white/60">
            Email address
          </label>
          <input
            ref={emailRef}
            id="login-email"
            name="email"
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
        </div>
        <PasswordField
          value={password}
          onChange={setPassword}
          label="Password"
          name="password"
          minLength={mode === "signup" ? 8 : undefined}
          autoComplete={mode === "signin" ? "current-password" : "new-password"}
          invalid={!!error}
          describedBy={error ? "login-error" : undefined}
          placeholder={mode === "signup" ? "Password (8+ chars, a letter and a number)" : "Password"}
        />
        {mode === "signup" && <TermsCheckbox checked={agreed} onChange={setAgreed} disabled={busy} />}
        {mode === "signin" && (
          <div className="text-right">
            <Link href="/forgot-password" className="inline-flex min-h-11 items-center text-xs text-white/50 hover:text-white">
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
      {offerResend && (
        <div className="mt-2 flex flex-wrap text-sm">
          <ResendConfirmation email={email} onNeedEmail={focusEmail} />
        </div>
      )}
      {msg && (
        <p role="status" data-testid="login-message" className="mt-3 text-sm text-green-300">
          {msg}
        </p>
      )}

      <button
        type="submit"
        disabled={busy || (mode === "signup" && !agreed)}
        className="mt-5 inline-flex min-h-11 w-full items-center justify-center rounded-xl btn-brand py-2.5 font-bold disabled:opacity-50"
      >
        {busy ? "…" : mode === "signin" ? "Sign in" : "Create login & continue"}
      </button>

      <button
        type="button"
        onClick={() => {
          setMode(mode === "signin" ? "signup" : "signin");
          setError(null);
          setMsg(null);
          setOfferResend(false);
        }}
        className="mt-3 inline-flex min-h-11 w-full items-center justify-center text-center text-sm text-white/50 hover:text-white"
      >
        {mode === "signin" ? "Want a creator account? Request access" : "Already have a login? Sign in"}
      </button>
    </form>
  );
}
