"use client";

import { exportDownloadWarning } from "@/lib/privacy/exportRecords";

import { useCallback, useEffect, useId, useState } from "react";
import type { ReactNode } from "react";
import { createClient, isSupabaseConfigured } from "@/lib/supabase/client";
import { useToast } from "@/components/ui/Toast";
import { TotpChallenge, TotpEnrol } from "@/components/auth/totp";
import { ACCOUNT_CLEANUP_PENDING_MESSAGE, deletionResponseState } from "@/lib/privacy/deletionResult";
import { CLOSE_ACCOUNT_PHRASE } from "@/lib/privacy/config";
import { closeAccountErrorMessage } from "@/lib/privacy/messages";
import { Field } from "./ui";
import PasswordInput from "./PasswordInput";
import CreatorMfaRecovery from "@/components/auth/CreatorMfaRecovery";
import { sectionHref } from "./dashboardSection";

/**
 * Settings cards for the privacy & safety pack:
 *   • TwoFactorCard — Settings › Security: turn on TOTP two-factor, see your
 *     authenticators, remove one (only from a session that used two-factor).
 *   • DataExportCard — download everything your account owns (JSON).
 *   • CloseAccountCard — permanently delete the account (password + phrase).
 * Every decision is made on the server; these only collect input.
 */

const raised = "border border-[var(--hair)] [background:var(--s1)] shadow-[var(--lift)]";
const secondaryBtn =
  "inline-flex min-h-10 items-center justify-center gap-1.5 rounded-[10px] border border-line px-4 text-sm font-semibold text-ink transition-colors hover:border-[var(--brand-ui)]/60 hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-50";
const dangerBtn =
  "inline-flex min-h-10 items-center justify-center gap-1.5 rounded-[10px] bg-[#dc2626] px-4 text-sm font-bold text-white transition-colors hover:bg-[#ef4444] disabled:cursor-not-allowed disabled:opacity-40";

const P = {
  shield: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10ZM9.5 12l2 2 3.5-4",
  download: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3",
  alert: "M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z",
};

function Glyph({ d, size = 17 }: { d: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className="shrink-0"
    >
      <path d={d} />
    </svg>
  );
}

function Card({ id, icon, title, hint, children, tone }: {
  id: string;
  icon: string;
  title: string;
  hint?: ReactNode;
  children: ReactNode;
  tone?: "danger";
}) {
  return (
    <section
      aria-labelledby={id}
      className={`min-w-0 space-y-4 rounded-2xl p-5 ${raised} ${tone === "danger" ? "border-[#ef4444]/40" : ""}`}
    >
      <div>
        <h3 id={id} className="flex items-center gap-2 text-[15px] font-bold text-ink">
          <span className={tone === "danger" ? "text-[#f87171]" : "text-brand"}>
            <Glyph d={icon} />
          </span>
          {title}
        </h3>
        {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

const DEMO_NOTE = "Demo mode has no sign-in, so there is nothing to protect or close here.";

// ---------------------------------------------------------------------------
// Two-factor
// ---------------------------------------------------------------------------
interface FactorRow {
  id: string;
  name: string;
  createdAt: string;
}

/** The browser session's verified authenticators and whether it used one. */
async function readTwoFactor(): Promise<{ factors: FactorRow[]; aal2: boolean } | { error: string }> {
  const sb = createClient();
  try {
    const [{ data: list }, { data: level }] = await Promise.all([
      sb.auth.mfa.listFactors(),
      sb.auth.mfa.getAuthenticatorAssuranceLevel(),
    ]);
    return {
      factors: (list?.totp ?? []).map((f) => ({
        id: f.id,
        name: f.friendly_name ?? "Authenticator app",
        createdAt: f.created_at,
      })),
      aal2: level?.currentLevel === "aal2",
    };
  } catch {
    return { error: "Couldn't load your two-factor settings." };
  }
}

export function TwoFactorCard() {
  const toast = useToast();
  const configured = isSupabaseConfigured();
  const [factors, setFactors] = useState<FactorRow[] | null>(null);
  const [aal2, setAal2] = useState(false);
  const [mode, setMode] = useState<"idle" | "enrol" | "confirm-remove">("idle");
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();

  const load = useCallback(async () => {
    const r = await readTwoFactor();
    if ("error" in r) setError(r.error);
    else {
      setFactors(r.factors);
      setAal2(r.aal2);
    }
  }, []);

  useEffect(() => {
    if (!configured) return;
    let live = true;
    readTwoFactor().then((r) => {
      if (!live) return;
      if ("error" in r) setError(r.error);
      else {
        setFactors(r.factors);
        setAal2(r.aal2);
      }
    });
    return () => {
      live = false;
    };
  }, [configured]);

  async function remove(id: string) {
    setRemoving(id);
    setError(null);
    try {
      const res = await fetch("/api/account/mfa/unenroll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ factorId: id }),
      });
      if (res.status === 403) {
        setMode("confirm-remove");
        return;
      }
      if (!res.ok) throw new Error();
      // The session's token still says aal2 until it refreshes; reload the list.
      await createClient().auth.refreshSession();
      toast("Two-factor removed", { tone: "success" });
      setMode("idle");
      await load();
    } catch {
      setError("Couldn't remove it. Try again.");
    } finally {
      setRemoving(null);
    }
  }

  const on = (factors?.length ?? 0) > 0;
  return (
    <Card
      id={titleId}
      icon={P.shield}
      title="Two-factor sign-in"
      hint="A 6-digit code from an authenticator app, asked for when you sign in. Required for admins; recommended for everyone."
    >
      {!configured ? (
        <p className="text-[13px] text-muted">{DEMO_NOTE}</p>
      ) : factors === null && !error ? (
        <p className="text-[13px] text-muted" aria-busy="true">Loading…</p>
      ) : mode === "enrol" ? (
        <TotpEnrol
          onEnrolled={() => {
            toast("Two-factor is on", { tone: "success" });
            setMode("idle");
            void load();
          }}
          onCancel={() => setMode("idle")}
        />
      ) : mode === "confirm-remove" ? (
        <div className="space-y-3">
          <p className="text-[13px] text-muted">
            To turn two-factor off, first confirm with a code from your authenticator app.
          </p>
          <TotpChallenge
            submitLabel="Confirm"
            onVerified={() => {
              setAal2(true);
              setMode("idle");
              toast("Confirmed. You can remove it now.", { tone: "success" });
            }}
          />
          <button type="button" className={secondaryBtn} onClick={() => setMode("idle")}>
            Cancel
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="flex items-center gap-2 text-[13px] text-ink" role="status">
            <span
              aria-hidden="true"
              className={`h-2 w-2 rounded-full ${on ? "bg-[#10b981]" : "bg-[color-mix(in_oklab,var(--color-ink)_30%,transparent)]"}`}
            />
            {on ? "Two-factor is on." : "Two-factor is off."}
          </p>
          {on && (
            <ul className="divide-y divide-line rounded-xl border border-line">
              {factors!.map((f) => (
                <li key={f.id} className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2.5">
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] font-semibold text-ink">{f.name}</span>
                    <span className="block text-xs text-muted">
                      Added {new Date(f.createdAt).toLocaleDateString()}
                    </span>
                  </span>
                  <button
                    type="button"
                    className={secondaryBtn}
                    disabled={removing === f.id}
                    aria-label={`Remove ${f.name}`}
                    onClick={() => (aal2 ? remove(f.id) : setMode("confirm-remove"))}
                  >
                    {removing === f.id ? "Removing…" : "Remove"}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {!on && (
            <button type="button" className={secondaryBtn} onClick={() => setMode("enrol")}>
              Set up two-factor
            </button>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="text-[13px] text-[#fcd34d]">
          {error}
        </p>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Download my data
// ---------------------------------------------------------------------------
/**
 * WG-16: end every other session of this account and keep this one. The route
 * asks for the two-factor step when the account is enrolled; nothing here
 * grants access, it only removes it.
 */
export function OtherDevicesCard() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [mfaRequired, setMfaRequired] = useState(false);
  async function signOutOthers() {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/account/sessions", { method: "POST" });
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      if (res.ok) {
        setMfaRequired(false);
        toast("Every other device was signed out. This one stays signed in.", { tone: "success", duration: 6000 });
        return;
      }
      if (d.error === "mfa_required") {
        setMfaRequired(true);
        return;
      }
      toast(
        d.error === "demo_mode"
          ? "Signing out other devices needs a real account (demo mode)."
          : d.error === "rate_limited"
            ? "Too many tries. Wait a little and try again."
            : "Couldn't sign out the other devices. Try again.",
        { tone: "error" }
      );
    } catch {
      toast("Couldn't sign out the other devices. Check your connection and try again.", { tone: "error" });
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card
      id="settings-other-devices"
      icon={P.shield}
      title="Other devices"
      hint="Lost a phone or used a shared computer? This ends every other session; you stay signed in here. Changing your password does the same."
    >
      <CreatorMfaRecovery required={mfaRequired} destination="settings" />
      <button type="button" data-testid="sign-out-others" onClick={() => void signOutOthers()} disabled={busy} className={secondaryBtn}>
        {busy ? "Signing out…" : "Sign out other devices"}
      </button>
    </Card>
  );
}

export function DataExportCard() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const titleId = useId();

  async function download() {
    setBusy(true);
    try {
      const res = await fetch("/api/account/export", { cache: "no-store" });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        toast(
          d.error === "mfa_required"
            ? "Sign in with your two-factor code first, then try again."
            : d.error === "rate_limited"
              ? "You've downloaded a few times already. Try again in an hour."
              : "Couldn't prepare your download. Try again.",
          { tone: "error" }
        );
        return;
      }
      const blob = await res.blob();
      const name =
        /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ?? "fanfunnel-account-data.json";
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      const warning = exportDownloadWarning(JSON.parse(await blob.text()));
      if (warning) {
        toast(warning, { tone: "error" });
      } else {
        toast("Your data is downloading", { tone: "success" });
      }
    } catch {
      toast("Couldn't prepare your download. Try again.", { tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      id={titleId}
      icon={P.download}
      title="Download my data"
      hint="One JSON file with everything your account owns: account and settings, wheels and prizes, campaigns, fans (with your notes), spins, redemptions, top-ups and messages. Fan link codes are shortened so the file can't open them. It has your fans' names and chats, so keep it private."
    >
      <button type="button" onClick={download} disabled={busy} className={secondaryBtn}>
        <Glyph d={P.download} size={15} />
        {busy ? "Preparing…" : "Download my data"}
      </button>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Close my account
// ---------------------------------------------------------------------------
export function CloseAccountCard() {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [phrase, setPhrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // T4: the server refused because fans are still owed prizes; show the way to Fulfilment.
  const [owed, setOwed] = useState(false);
  const titleId = useId();
  const panelId = useId();
  const errId = useId();
  const ready = password.length > 0 && phrase.trim() === CLOSE_ACCOUNT_PHRASE;
  // WG-04: an agency owner is told that closing dissolves their agency.
  const [agency, setAgency] = useState<{ orgName: string; seats: number; creators: number } | null>(null);
  useEffect(() => {
    if (!open) return;
    let live = true;
    fetch("/api/agency/impact", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { impact?: { orgName: string; seats: number; creators: number } | null } | null) => { if (live) setAgency(d?.impact ?? null); })
      .catch(() => {});
    return () => { live = false; };
  }, [open]);

  async function close() {
    setBusy(true);
    setError(null);
    setOwed(false);
    try {
      const res = await fetch("/api/account/close", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword: password, confirm: phrase.trim() }),
      });
      const d = await res.json().catch(() => ({}));
      const state = deletionResponseState(res.status, d);
      if (state === "pending") {
        setError(ACCOUNT_CLEANUP_PENDING_MESSAGE);
        return;
      }
      if (state !== "complete") {
        setOwed(d.error === "prizes_owed");
        setError(closeAccountErrorMessage(d.error));
        return;
      }
      // Full navigation after closure avoids keeping this closed page as the current history entry.
      window.location.replace("/login?closed=1");
    } catch {
      setError(closeAccountErrorMessage(undefined));
    } finally {
      setBusy(false);
      setPassword("");
    }
  }

  return (
    <Card
      id={titleId}
      tone="danger"
      icon={P.alert}
      title="Close my account"
      hint="Permanently deletes your account and everything it owns. This can't be undone. Download your data first if you want a copy."
    >
      {!open ? (
        <button
          type="button"
          className={secondaryBtn}
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen(true)}
        >
          Close my account…
        </button>
      ) : (
        <div id={panelId} className="space-y-3.5">
          <ul className="list-disc space-y-1 pl-5 text-[13px] text-muted">
            <li>Your wheels, prizes, fans, spins, redemptions, campaigns, messages and settings are deleted.</li>
            <li>Every fan link stops working and shows that you&rsquo;ve left FanFunnel.</li>
            {agency && (
              <li data-testid="close-agency-impact" className="text-[#fcd34d]">
                You run the agency <strong className="text-ink">{agency.orgName}</strong> with {agency.seats} staff {agency.seats === 1 ? "seat" : "seats"} and {agency.creators} managed{" "}
                {agency.creators === 1 ? "creator" : "creators"}. Closing dissolves it: every seat ends, the creators keep their own accounts, and all of them get a notice.
              </li>
            )}
            <li>You&rsquo;re signed out everywhere. The email can sign up again later as a new account.</li>
            <li>
              You can&rsquo;t close while fans are still owed prizes. Deliver or cancel every pending prize in{" "}
              <a href={sectionHref("prizes")} className="text-ink underline underline-offset-2">Fulfilment</a> first.
            </li>
          </ul>
          <div className="grid gap-3.5 sm:grid-cols-2">
            <Field label="Current password">
              <PasswordInput label="Current password" autoComplete="current-password" value={password} onChange={setPassword} describedBy={error ? errId : undefined} />
            </Field>
            <Field label={`Type ${CLOSE_ACCOUNT_PHRASE}`}>
              <input
                className="ff-input w-full"
                autoComplete="off"
                spellCheck={false}
                value={phrase}
                onChange={(e) => setPhrase(e.target.value)}
                placeholder={CLOSE_ACCOUNT_PHRASE}
                aria-describedby={error ? errId : undefined}
              />
            </Field>
          </div>
          {error && (
            <p id={errId} role="alert" data-testid="close-account-error" className="text-[13px] text-[#fcd34d]">
              {error}
              {owed && (
                <>
                  {" "}
                  <a href={sectionHref("prizes")} className="font-semibold underline underline-offset-2">Open Fulfilment</a>
                </>
              )}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <button type="button" className={dangerBtn} disabled={!ready || busy} onClick={close}>
              {busy ? "Closing…" : "Permanently close my account"}
            </button>
            <button
              type="button"
              className={secondaryBtn}
              disabled={busy}
              onClick={() => {
                setOpen(false);
                setPassword("");
                setPhrase("");
                setError(null);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </Card>
  );
}
