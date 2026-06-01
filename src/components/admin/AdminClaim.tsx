"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

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
      setMsg(
        body.error === "not_allowed"
          ? "Your email isn't on the admin allowlist."
          : body.error === "not_configured"
            ? "Admin allowlist (ADMIN_EMAILS) isn't set on the server yet."
            : body.error === "already_bootstrapped"
              ? "An admin already exists — ask them to grant you access."
              : "Couldn't claim admin. Try again."
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-white/5 p-7 text-center text-white">
      <div className="text-4xl">🔐</div>
      <h1 className="mt-3 text-xl font-bold">Admin access</h1>
      <p className="mt-2 text-sm text-white/60">
        You&rsquo;re signed in but not an admin yet. If your email is on the
        allowlist, claim admin access below.
      </p>
      <button
        onClick={claim}
        disabled={busy}
        className="mt-5 w-full rounded-xl bg-pink-500 py-2.5 font-bold hover:bg-pink-400 disabled:opacity-50"
      >
        {busy ? "Claiming…" : "Claim admin access"}
      </button>
      {msg && <p className="mt-3 text-sm text-amber-300">{msg}</p>}
      <a
        href="/dashboard"
        className="mt-4 inline-block text-sm text-white/50 hover:text-white"
      >
        ← Back to dashboard
      </a>
    </div>
  );
}
