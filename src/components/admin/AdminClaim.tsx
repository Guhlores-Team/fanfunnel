"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { claimErrorMessage } from "./adminErrors";

/**
 * Shown at /admin when the signed-in user isn't admin yet. Lets them claim admin
 * IF their email is in the ADMIN_EMAILS env allowlist (checked server-side).
 */
export default function AdminClaim() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const claim = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/admin/claim", { method: "POST" });
      if (res.ok) {
        router.refresh();
        return;
      }
      const body = await res.json().catch(() => ({}));
      setMsg(claimErrorMessage(body.error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="w-full max-w-sm rounded-2xl border border-[var(--hair)] [background:var(--s1)] px-6 py-8 text-center text-ink shadow-[var(--lift)]">
      <span className="mx-auto grid h-12 w-12 place-items-center rounded-[13px] bg-[color-mix(in_oklab,var(--brand)_16%,transparent)] text-brand">
        <svg
          width="22"
          height="22"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          focusable="false"
        >
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10ZM9.5 12l2 2 3.5-4" />
        </svg>
      </span>
      <h1 className="mt-4 text-xl font-bold tracking-[-0.02em]">Admin access</h1>
      <p className="mt-2 text-[13.5px] text-muted">
        You&rsquo;re signed in but not an admin yet. If your email is on the
        allowlist, claim admin access below.
      </p>
      <button
        type="button"
        onClick={claim}
        disabled={busy}
        className="btn-brand mt-5 w-full rounded-[10px] py-2.5 text-sm font-bold"
      >
        {busy ? "Claiming…" : "Claim admin access"}
      </button>
      {msg && (
        <p role="alert" className="mt-3 text-[13px] text-[#fcd34d]">
          {msg}
        </p>
      )}
      <a
        href="/dashboard"
        className="mt-4 inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-[13px] font-semibold text-muted transition-colors hover:text-ink"
      >
        <span aria-hidden="true">←</span> Back to dashboard
      </a>
    </div>
  );
}
