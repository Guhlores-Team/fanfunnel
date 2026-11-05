"use client";

import { useEffect, useId, useRef, useState, type Ref } from "react";

/** What leaving ends: a managed creator's membership, or a staff seat. */
export type LeaveKind = "creator" | "staff";
export type LeaveStep = "idle" | "confirm" | "pending";

interface LeaveView {
  org: { id: string; name: string } | null;
  orgId?: string | null;
  demo?: boolean;
  managed?: boolean;
  isOwner?: boolean;
}

/**
 * Who sees "Leave agency" on /agency: a staff seat in someone else's agency,
 * or a creator an agency manages. Never the owner (an owner closes or keeps
 * its agency, it does not leave it), the demo, or anyone without an agency.
 * Only shapes the UI: org_leave acts on the caller's own rows only.
 */
export function leaveKind(data: LeaveView | null | undefined): LeaveKind | null {
  if (!data || data.demo) return null;
  if (data.org) return data.isOwner === false ? "staff" : null;
  return data.managed && typeof data.orgId === "string" && data.orgId ? "creator" : null;
}

/** Each refusal POST /api/agency/leave can answer, as something to do next. */
export function leaveErrorMessage(code: string): string {
  switch (code) {
    case "not_member":
      return "You're not in this agency any more, or your sign-in needs its two-step check again. Refresh the page and try again.";
    case "demo_only":
      return "Demo only: agencies need a connected database, so nothing changed.";
    case "rate_limited":
      return "Too many tries in a row. Wait a minute and try again.";
    case "unauthorized":
      return "Your session has ended. Sign in again, then leave the agency.";
    case "forbidden":
      return "This page is out of date. Refresh it and try again.";
    default:
      return "Couldn't leave the agency. Please try again.";
  }
}

async function postLeave(orgId: string): Promise<string | null> {
  try {
    const res = await fetch("/api/agency/leave", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orgId }),
    });
    if (res.ok) return null;
    const d = await res.json().catch(() => ({}));
    return typeof d.error === "string" ? d.error : "error";
  } catch {
    return "network";
  }
}

const dangerBtn =
  "inline-flex min-h-11 items-center justify-center rounded-[10px] border border-red-400/50 px-4 text-sm font-semibold text-red-300 transition-colors hover:bg-red-400/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-300 disabled:opacity-50";
const secondaryBtn =
  "inline-flex min-h-11 items-center justify-center rounded-[10px] border border-line px-4 text-sm font-semibold text-ink transition-colors hover:bg-surface-2 disabled:opacity-50";

const COPY: Record<LeaveKind, { what: string; confirm: string }> = {
  creator: {
    what: "The agency, its managers and its staff stop acting for your account. Your games, fans and data stay yours.",
    confirm: "The agency loses access to your account right away. To join again, its owner has to invite you and you accept.",
  },
  staff: {
    what: "Your staff seat ends, and you stop acting for this agency's creators. Your own account stays as it is.",
    confirm: "Your seat ends right away. To come back, the owner has to invite you again and you accept.",
  },
};

/** The stateless markup, so tests can render every step. */
export function LeaveAgencyView({
  kind,
  orgName,
  step,
  error,
  onAsk,
  onCancel,
  onConfirm,
  askRef,
  confirmRef,
  cancelRef,
}: {
  kind: LeaveKind;
  orgName?: string | null;
  step: LeaveStep;
  error: string | null;
  onAsk: () => void;
  onCancel: () => void;
  onConfirm: () => void;
  askRef?: Ref<HTMLButtonElement>;
  confirmRef?: Ref<HTMLButtonElement>;
  cancelRef?: Ref<HTMLButtonElement>;
}) {
  const id = useId();
  const pending = step === "pending";
  const name = orgName?.trim() || "this agency";
  return (
    <section
      aria-labelledby={`${id}-title`}
      data-testid="agency-leave"
      className="mt-8 rounded-2xl border border-line bg-surface p-5 text-left"
    >
      <h2 id={`${id}-title`} className="text-base font-bold">
        Leave {name}
      </h2>
      <p id={`${id}-what`} className="mt-1 max-w-2xl text-sm text-muted text-pretty">
        {COPY[kind].what}
      </p>
      {step === "idle" ? (
        <button
          ref={askRef}
          type="button"
          onClick={onAsk}
          aria-describedby={`${id}-what`}
          data-testid="agency-leave-start"
          className={`mt-4 ${dangerBtn}`}
        >
          Leave agency
        </button>
      ) : (
        <div
          role="group"
          aria-labelledby={`${id}-confirm`}
          aria-busy={pending || undefined}
          data-testid="agency-leave-confirm"
          className="mt-4 rounded-xl border border-red-400/40 bg-red-400/5 p-4"
        >
          <p id={`${id}-confirm`} className="text-sm font-semibold text-ink">
            Leave {name}? {COPY[kind].confirm}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              ref={confirmRef}
              type="button"
              onClick={onConfirm}
              disabled={pending}
              data-testid="agency-leave-confirm-button"
              className={dangerBtn}
            >
              {pending ? "Leaving…" : "Yes, leave"}
            </button>
            <button ref={cancelRef} type="button" onClick={onCancel} disabled={pending} className={secondaryBtn}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {error && (
        <p role="alert" data-testid="agency-leave-error" className="mt-3 text-sm text-red-300">
          {error}
        </p>
      )}
    </section>
  );
}

/**
 * "Leave agency" with a confirmation step. POSTs the org to
 * /api/agency/leave (same-origin, cookie session; org_leave acts on the
 * caller's own seat and membership only) and calls `onLeft` on success.
 */
export default function LeaveAgency({
  kind,
  orgId,
  orgName,
  onLeft,
}: {
  kind: LeaveKind;
  orgId: string;
  orgName?: string | null;
  onLeft: () => void;
}) {
  const [step, setStep] = useState<LeaveStep>("idle");
  const [error, setError] = useState<string | null>(null);
  const askRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const prevStep = useRef<LeaveStep>("idle");

  // The keyboard follows the step: into the confirmation on its least
  // destructive choice, back onto "Yes, leave" after a failed try (the
  // buttons were disabled while it ran), and back to "Leave agency" on Cancel.
  useEffect(() => {
    const prev = prevStep.current;
    prevStep.current = step;
    if (step === "confirm" && prev === "idle") cancelRef.current?.focus();
    else if (step === "confirm" && prev === "pending") confirmRef.current?.focus();
    else if (step === "idle" && prev !== "idle") askRef.current?.focus();
  }, [step]);

  const confirm = async () => {
    if (step === "pending") return;
    setStep("pending");
    setError(null);
    const err = await postLeave(orgId);
    if (err) {
      setError(leaveErrorMessage(err));
      setStep("confirm");
      return;
    }
    onLeft();
  };

  return (
    <LeaveAgencyView
      kind={kind}
      orgName={orgName}
      step={step}
      error={error}
      askRef={askRef}
      confirmRef={confirmRef}
      cancelRef={cancelRef}
      onAsk={() => {
        setError(null);
        setStep("confirm");
      }}
      onCancel={() => {
        setError(null);
        setStep("idle");
      }}
      onConfirm={() => void confirm()}
    />
  );
}

/** After leaving: say what changed and go back with a full page load, so the
 *  server-derived Agency link and seat scopes are read afresh. */
export function LeftAgency({ kind }: { kind: LeaveKind }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  return (
    <div data-testid="agency-left" className="mx-auto max-w-md px-5 py-24 text-center text-ink">
      <h1 ref={heading} tabIndex={-1} className="text-xl font-bold outline-none">
        You left the agency
      </h1>
      <p role="status" className="mt-3 text-sm text-muted text-pretty">
        {kind === "creator"
          ? "The agency can no longer act for your account. Everything in your dashboard is still yours."
          : "Your staff seat has ended. Your own account is unchanged."}
      </p>
      <a
        href="/dashboard"
        className="mt-6 inline-flex min-h-10 items-center rounded-lg border border-line px-4 text-sm font-semibold text-muted hover:bg-surface-2 hover:text-ink"
      >
        ← Back to dashboard
      </a>
    </div>
  );
}
