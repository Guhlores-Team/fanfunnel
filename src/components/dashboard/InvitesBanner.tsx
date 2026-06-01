"use client";

import { useEffect, useState } from "react";

interface Invite {
  id: string;
  orgId: string;
  orgName: string;
}

/**
 * Consent gate for agency invites: a creator sees pending invites to join an
 * agency and explicitly accepts or declines. Their account + data only join an
 * org on accept. Renders nothing when there are no pending invites.
 */
export default function InvitesBanner() {
  const [invites, setInvites] = useState<Invite[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const load = async () => {
    try {
      const res = await fetch("/api/invites", { cache: "no-store" });
      if (res.ok) setInvites((await res.json()).invites ?? []);
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount
    load();
  }, []);

  const respond = async (inviteId: string, accept: boolean) => {
    setBusy(inviteId);
    try {
      await fetch("/api/invites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inviteId, accept }),
      });
      setInvites((cur) => cur.filter((i) => i.id !== inviteId));
      if (accept) window.location.reload();
    } finally {
      setBusy(null);
    }
  };

  if (invites.length === 0) return null;

  return (
    <div className="mb-5 space-y-2">
      {invites.map((inv) => (
        <div
          key={inv.id}
          className="card flex flex-wrap items-center justify-between gap-3 rounded-2xl border-[var(--brand)]/40 p-4"
        >
          <div className="min-w-0">
            <p className="font-bold text-ink">
              🏢 {inv.orgName} invited you to join their agency
            </p>
            <p className="text-sm text-muted">
              Accepting lets the agency manage your wheels, fans, and fulfilment.
              You can be removed at any time.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => respond(inv.id, true)}
              disabled={busy === inv.id}
              className="btn-brand rounded-lg px-4 py-1.5 text-sm font-bold disabled:opacity-50"
            >
              Accept
            </button>
            <button
              onClick={() => respond(inv.id, false)}
              disabled={busy === inv.id}
              className="rounded-lg border border-line px-3 py-1.5 text-sm font-semibold text-muted hover:text-ink disabled:opacity-50"
            >
              Decline
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
