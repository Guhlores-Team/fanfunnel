"use client";

import { useEffect, useId, useRef, useState } from "react";
import QRCode from "qrcode";
import { createClient } from "@/lib/supabase/client";

/**
 * Two-factor (TOTP) building blocks on Supabase Auth MFA, used by the /mfa page
 * and Settings › Security. They run in the browser client so the upgraded
 * (aal2) session lands in the same cookies the server reads. Enrolling and
 * verifying only ever ADD a check; removing a factor goes through the server
 * (POST /api/account/mfa/unenroll, aal2-only, audited).
 *
 * The QR code is drawn with the `qrcode` library the dashboard already uses for
 * fan-link QR codes (QrButton), from the otpauth:// URI; the secret is shown
 * too, for typing into an authenticator by hand. Neither is logged or stored.
 */

const CODE = /^\d{6}$/;

/** Friendly copy for Supabase MFA errors; never the raw provider text. */
export function mfaErrorMessage(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === "mfa_verification_failed" || code === "mfa_challenge_expired") {
    return "That code didn't work. Check the time on your phone and try the newest code.";
  }
  if (code === "over_request_rate_limit" || code === "too_many_requests") {
    return "Too many tries. Wait a minute, then try again.";
  }
  if (code === "mfa_totp_enroll_not_enabled" || code === "mfa_totp_enroll_disabled") {
    return "Two-factor sign-in isn't switched on for this site yet. Ask the FanFunnel team.";
  }
  return "Something went wrong. Try again.";
}

/** A 6-digit one-time-code field with the right mobile keyboard and autofill. */
export function CodeInput({
  value,
  onChange,
  invalid,
  describedBy,
  label = "6-digit code",
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  invalid?: boolean;
  describedBy?: string;
  label?: string;
  autoFocus?: boolean;
}) {
  const id = useId();
  return (
    <label htmlFor={id} className="flex flex-col gap-1.5">
      <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-muted">{label}</span>
      <input
        id={id}
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="\d{6}"
        maxLength={6}
        autoFocus={autoFocus}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        className="ff-input tnum w-full text-center text-lg tracking-[0.4em]"
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, "").slice(0, 6))}
        placeholder="123456"
      />
    </label>
  );
}

/**
 * Enter a code from an already-enrolled authenticator (the aal2 step).
 * Calls onVerified once Supabase has upgraded the session.
 */
export function TotpChallenge({
  onVerified,
  submitLabel = "Verify",
  autoFocus = true,
}: {
  onVerified: () => void;
  submitLabel?: string;
  autoFocus?: boolean;
}) {
  const [factorId, setFactorId] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errId = useId();

  useEffect(() => {
    let live = true;
    createClient()
      .auth.mfa.listFactors()
      .then(({ data }) => {
        if (!live) return;
        const totp = data?.totp?.[0];
        if (totp) setFactorId(totp.id);
        else setError("No authenticator is set up on this account.");
      })
      .catch(() => live && setError("Couldn't load your two-factor settings."));
    return () => {
      live = false;
    };
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!factorId || !CODE.test(code)) {
      setError("Enter the 6-digit code from your authenticator app.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { error: err } = await createClient().auth.mfa.challengeAndVerify({ factorId, code });
      if (err) {
        setError(mfaErrorMessage(err));
        setCode("");
        return;
      }
      onVerified();
    } catch (err) {
      setError(mfaErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
      <CodeInput
        value={code}
        onChange={setCode}
        invalid={!!error}
        describedBy={error ? errId : undefined}
        autoFocus={autoFocus}
      />
      {error && (
        <p id={errId} role="alert" className="text-[13px] text-[#fcd34d]">
          {error}
        </p>
      )}
      <button
        type="submit"
        disabled={busy || !factorId || code.length !== 6}
        className="btn-brand inline-flex min-h-10 items-center justify-center rounded-[10px] px-[18px] text-sm font-bold disabled:opacity-50"
      >
        {busy ? "Checking…" : submitLabel}
      </button>
    </form>
  );
}

/**
 * Set up a new authenticator: enrol a TOTP factor, show its QR code and
 * secret, then verify the first code (which also upgrades this session to
 * aal2). Half-finished enrolments from earlier tries are cleared first.
 */
export function TotpEnrol({
  onEnrolled,
  onCancel,
}: {
  onEnrolled: () => void;
  onCancel?: () => void;
}) {
  const [factorId, setFactorId] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [showSecret, setShowSecret] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);
  const errId = useId();
  const secretId = useId();

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    (async () => {
      const sb = createClient();
      try {
        const { data: list } = await sb.auth.mfa.listFactors();
        for (const f of list?.all ?? []) {
          if (f.factor_type === "totp" && f.status === "unverified") {
            await sb.auth.mfa.unenroll({ factorId: f.id });
          }
        }
        const { data, error: err } = await sb.auth.mfa.enroll({
          factorType: "totp",
          issuer: "FanFunnel",
          friendlyName: `Authenticator ${new Date().toISOString().slice(0, 10)} ${Math.random().toString(36).slice(2, 6)}`,
        });
        if (err || !data) {
          setError(mfaErrorMessage(err));
          return;
        }
        setFactorId(data.id);
        setSecret(data.totp.secret);
        setQr(await QRCode.toDataURL(data.totp.uri, { width: 220, margin: 1, errorCorrectionLevel: "M" }));
      } catch (err) {
        setError(mfaErrorMessage(err));
      }
    })();
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!factorId || !CODE.test(code)) {
      setError("Enter the 6-digit code your authenticator app shows.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { error: err } = await createClient().auth.mfa.challengeAndVerify({ factorId, code });
      if (err) {
        setError(mfaErrorMessage(err));
        setCode("");
        return;
      }
      onEnrolled();
    } catch (err) {
      setError(mfaErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
      <ol className="list-decimal space-y-1 pl-5 text-[13px] text-muted">
        <li>Open an authenticator app (Google Authenticator, 1Password, Authy…).</li>
        <li>Scan this code, or type the setup key below.</li>
        <li>Enter the 6-digit code it shows.</li>
      </ol>
      <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-start">
        <div className="grid h-[180px] w-[180px] shrink-0 place-items-center rounded-xl bg-white p-2">
          {qr ? (
            // eslint-disable-next-line @next/next/no-img-element -- a generated data: URL, nothing to optimize
            <img src={qr} alt="QR code for your authenticator app" width={164} height={164} />
          ) : (
            <span className="text-xs text-zinc-600" aria-live="polite">
              {error ? "Unavailable" : "Preparing…"}
            </span>
          )}
        </div>
        <div className="min-w-0 flex-1 space-y-2 text-[13px]">
          <button
            type="button"
            className="text-xs font-semibold text-ink underline underline-offset-4"
            aria-expanded={showSecret}
            aria-controls={secretId}
            onClick={() => setShowSecret((v) => !v)}
            disabled={!secret}
          >
            {showSecret ? "Hide setup key" : "Can't scan? Show the setup key"}
          </button>
          <p id={secretId} hidden={!showSecret} className="break-all rounded-lg border border-line px-3 py-2 font-mono text-xs text-ink">
            {secret}
          </p>
          <p className="text-xs text-muted">Keep this key private: anyone with it can make your codes.</p>
        </div>
      </div>
      <CodeInput value={code} onChange={setCode} invalid={!!error} describedBy={error ? errId : undefined} />
      {error && (
        <p id={errId} role="alert" className="text-[13px] text-[#fcd34d]">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          disabled={busy || !factorId || code.length !== 6}
          className="btn-brand inline-flex min-h-10 items-center justify-center rounded-[10px] px-[18px] text-sm font-bold disabled:opacity-50"
        >
          {busy ? "Checking…" : "Turn on two-factor"}
        </button>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="inline-flex min-h-10 items-center justify-center rounded-[10px] border border-line px-4 text-sm font-semibold text-ink"
          >
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
