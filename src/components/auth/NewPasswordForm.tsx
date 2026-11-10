"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient, isSupabaseConfigured } from "@/lib/supabase/client";
import { isAcceptablePassword, PASSWORD_RULE_MESSAGE } from "@/lib/api/password";
import { switchedAccountNotice } from "@/lib/auth/authCopy";
import AuthShell from "./AuthShell";
import PasswordField from "./PasswordField";
import { TotpChallenge } from "./totp";

// Set a new password. Reached through an e-mail link → /auth/confirm (Continue)
// → /auth/confirm/verify, which establishes a session before redirecting here:
// "reset" from the recovery e-mail (/reset-password), "welcome" from an admin's
// invite (/set-password). The password is set by POST /api/account/password/reset
// (WU-06): a session an e-mail link opened in the last hour may set it
// outright; any other signed-in session must give its current password; a
// two-factor account enters its code first (WU-07). Without a session the
// link was bad or expired, so we point the user back to request a fresh one.
// Review A4: when the link switched this browser to another account
// (`?switched=1`, a flag that only turns the sentence on) the screen names the
// account, using the e-mail the route read from the session.
const COPY = {
  reset: {
    checking: "Checking your reset link…",
    expiredBody: "This reset link is invalid or has expired. Request a fresh one; it works on any device.",
    title: "Choose a new password",
    intro: "Enter a new password for your account.",
    label: "New password",
    cta: "Update password",
    doneTitle: "Password updated",
  },
  welcome: {
    checking: "Checking your invite…",
    expiredBody:
      "This invite link is invalid or has expired. Use “Send a new link” with the invited address to get a fresh one (that also finishes setting up the account), or ask the admin who invited you.",
    title: "Welcome to FanFunnel",
    intro: "Your creator account is ready. Choose a password to finish setting it up.",
    label: "Password",
    cta: "Set password",
    doneTitle: "Password set",
  },
} as const;

/** What the route said this session still needs before a password can be set. */
export type ResetRequirement = "none" | "current_password" | "mfa";

/** The route's answer → the screen to show (pure; unit-tested). */
export function resetRequirementFromResponse(status: number, body: { error?: unknown; requires?: unknown; [k: string]: unknown } | null): ResetRequirement | "no_session" | "error" {
  if (status === 401) return "no_session";
  if (status === 403 && body?.error === "mfa_required") return "mfa";
  if (status === 403 && body?.error === "current_password_required") return "current_password";
  if (status === 200) return "none";
  return "error";
}

/** The sentence for a /api/account/password/reset error code (never the provider's). */
export function resetErrorMessage(status: number, code: unknown): string {
  if (status === 429) return "Too many tries for this account. Wait an hour, then try again.";
  switch (code) {
    case "wrong_password":
      return "Your current password is incorrect.";
    case "weak_password":
      return PASSWORD_RULE_MESSAGE;
    case "same_password":
      return "That's your current password. Choose a different one.";
    case "demo_mode":
      return "Password changes need Supabase configured (demo mode).";
    default:
      return "Couldn't update your password. Try again, or request a new reset link.";
  }
}

/** The switched-account sentence, or null: the flag AND the session's own e-mail are both needed. */
export function switchedNoticeFor(search: string, sessionEmail: unknown): { title: string; body: string } | null {
  if (new URLSearchParams(search).get("switched") !== "1") return null;
  return typeof sessionEmail === "string" && sessionEmail.includes("@") ? switchedAccountNotice(sessionEmail) : null;
}

async function postReset(body: Record<string, string>): Promise<{ status: number; body: { error?: unknown; requires?: unknown; othersSignedOut?: unknown; email?: unknown } | null }> {
  const res = await fetch("/api/account/password/reset", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

export default function NewPasswordForm({ variant }: { variant: keyof typeof COPY }) {
  const copy = COPY[variant];
  const router = useRouter();
  // Without Supabase (demo mode) there are no accounts: creating a client
  // would throw on the missing URL and crash the page (QA b5 m10).
  const [configured] = useState(isSupabaseConfigured);
  const [checking, setChecking] = useState(configured);
  const [hasSession, setHasSession] = useState(false);
  const [requires, setRequires] = useState<ResetRequirement>("none");
  const [password, setPassword] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ othersSignedOut: boolean } | null>(null);
  const [switched, setSwitched] = useState<{ title: string; body: string } | null>(null);

  // Ask the route what this session still needs (a probe sets nothing).
  const probe = useCallback(async () => {
    try {
      const { status, body } = await postReset({});
      const need = resetRequirementFromResponse(status, body);
      if (need === "no_session") {
        setHasSession(false);
      } else if (need === "error") {
        setHasSession(true);
        setError(resetErrorMessage(status, body?.error));
      } else {
        setHasSession(true);
        setRequires(need);
        setSwitched(switchedNoticeFor(window.location.search, body?.email));
      }
    } catch {
      setHasSession(true);
      setError("Couldn't check your link. Reload the page to try again.");
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    if (!configured) return;
    let live = true;
    try {
      createClient()
        .auth.getSession()
        .then(({ data }) => {
          if (!live) return;
          if (!data.session) {
            setHasSession(false);
            setChecking(false);
            return;
          }
          void probe();
        }, () => { if (live) setChecking(false); });
    } catch {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- a client that can't start means no session to use
      setChecking(false);
    }
    return () => { live = false; };
  }, [configured, probe]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!isAcceptablePassword(password)) {
      setError(PASSWORD_RULE_MESSAGE);
      return;
    }
    if (requires === "current_password" && !currentPassword) {
      setError("Enter your current password too.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { status, body } = await postReset(
        requires === "current_password" ? { newPassword: password, currentPassword } : { newPassword: password }
      );
      if (status === 200) {
        setDone({ othersSignedOut: body?.othersSignedOut === true });
        setTimeout(() => {
          router.push("/dashboard");
          router.refresh();
        }, 1600);
        return;
      }
      const need = resetRequirementFromResponse(status, body);
      if (need === "no_session") {
        setHasSession(false);
        return;
      }
      if (need === "mfa" || need === "current_password") {
        setRequires(need);
        return;
      }
      setError(resetErrorMessage(status, body?.error));
    } catch {
      setError("Couldn't reach FanFunnel. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell>
      <div className="rounded-2xl border border-white/10 bg-white/5 p-6 text-white">
        {!configured ? (
          <>
            <h1 className="text-lg font-bold">Password reset isn&rsquo;t available here</h1>
            <p className="mt-2 text-sm text-white/60">
              This is the demo workspace, which has no accounts or passwords. Open the dashboard to keep exploring.
            </p>
            <Link
              href="/dashboard"
              className="mt-5 inline-flex min-h-11 items-center rounded-xl btn-brand px-4 py-2 text-sm font-bold"
            >
              Open the demo dashboard
            </Link>
          </>
        ) : checking ? (
          <p className="text-sm text-white/60" role="status">{copy.checking}</p>
        ) : !hasSession ? (
          <>
            <h1 className="text-lg font-bold">Link expired</h1>
            <p className="mt-2 text-sm text-white/60">
              {copy.expiredBody}
            </p>
            <Link
              href="/forgot-password"
              className="mt-5 inline-flex min-h-11 items-center rounded-xl btn-brand px-4 py-2 text-sm font-bold"
            >
              Send a new link
            </Link>
          </>
        ) : done ? (
          <>
            <h1 className="text-lg font-bold">{copy.doneTitle}</h1>
            <p className="mt-2 text-sm text-white/60">
              You&rsquo;re signed in here{done.othersSignedOut ? ", and every other device was signed out" : ""}. Taking you to your dashboard…
            </p>
          </>
        ) : requires === "mfa" ? (
          <div data-testid="reset-mfa-step">
            <h1 className="text-lg font-bold">Enter your sign-in code first</h1>
            <p className="mt-1 text-sm text-white/50">
              Your account uses two-factor sign-in, so a link alone can&rsquo;t change its password. Open your authenticator app and enter the
              6-digit code for FanFunnel; then choose the new password.
            </p>
            <div className="mt-4">
              <TotpChallenge onVerified={() => { setRequires("none"); void probe(); }} submitLabel="Continue" />
            </div>
          </div>
        ) : (
          <form onSubmit={submit}>
            <h1 className="text-lg font-bold">{copy.title}</h1>
            <p className="mt-1 text-sm text-white/50">{copy.intro}</p>
            {switched && (
              <p role="status" data-testid="account-switched" className="mt-3 rounded-xl border border-amber-300/30 bg-amber-300/10 p-3 text-sm text-amber-100">
                <span className="font-bold text-amber-50">{switched.title}.</span> {switched.body}
              </p>
            )}
            {requires === "current_password" && (
              <>
                <p data-testid="reset-current-required" className="mt-3 rounded-xl border border-amber-300/30 bg-amber-300/10 p-3 text-sm text-amber-100">
                  A link from your e-mail lets you choose a new password for one hour after you open it. This sign-in is older than that, or
                  didn&rsquo;t come from a link, so enter your current password too. Forgot it?{" "}
                  <Link href="/forgot-password" className="font-semibold text-white underline underline-offset-4">
                    Send a new reset link
                  </Link>{" "}
                  and open it.
                </p>
                <PasswordField
                  value={currentPassword}
                  onChange={setCurrentPassword}
                  label="Current password"
                  name="current_password"
                  autoComplete="current-password"
                  placeholder="Current password"
                  className="mt-4"
                />
              </>
            )}
            <PasswordField
              value={password}
              onChange={setPassword}
              label={copy.label}
              name="new_password"
              autoComplete="new-password"
              minLength={8}
              invalid={!!error}
              describedBy={error ? "reset-error" : undefined}
              placeholder="8+ characters, a letter and a number"
              className="mt-4"
            />
            <p className="mt-2 text-xs text-white/50">{PASSWORD_RULE_MESSAGE} Changing it signs out every other device.</p>
            {error && (
              <p id="reset-error" role="alert" className="mt-3 text-sm text-amber-300">
                {error}
              </p>
            )}
            <button
              type="submit"
              disabled={busy}
              className="mt-5 inline-flex min-h-11 w-full items-center justify-center rounded-xl btn-brand py-2.5 font-bold disabled:opacity-50"
            >
              {busy ? "…" : copy.cta}
            </button>
          </form>
        )}
      </div>
    </AuthShell>
  );
}
