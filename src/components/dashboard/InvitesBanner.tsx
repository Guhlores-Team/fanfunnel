"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/ui/Toast";

interface Invite {
  id: string;
  orgId: string;
  orgName: string;
  /** null: join as a creator; otherwise the staff seat offered (0068). */
  role?: string | null;
}

/**
 * Consent gate for agency invites: a creator sees pending invites to join an
 * agency and explicitly accepts or declines. Their account + data only join an
 * org on accept. Renders nothing when there are no pending invites.
 */
export default function InvitesBanner() {
  const router = useRouter();
  const [invites, setInvites] = useState<Invite[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  // A45: the agency just joined, so the creator can find /agency from here.
  const [joined, setJoined] = useState<string | null>(null);
  const toast = useToast();

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
    // Optimistically drop the responded invite, restoring it on failure so a
    // dead network never leaves the banner showing a stale (or missing) invite.
    const snapshot = invites;
    setBusy(inviteId);
    setInvites((cur) => cur.filter((i) => i.id !== inviteId));
    try {
      const res = await fetch("/api/invites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inviteId, accept }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        if (body?.error === "expired" || body?.error === "gone") {
          toast("That invitation has expired. Ask the agency owner to send a new one.", { tone: "error" });
          return;
        }
        throw new Error();
      }
      // #9: re-run the server components (active creator context changes on
      // accept) without a full-page reload.
      if (accept) {
        setJoined(invites.find((i) => i.id === inviteId)?.orgName ?? "the agency");
        router.refresh();
      }
    } catch {
      setInvites(snapshot);
      toast(accept ? "Couldn't accept invite." : "Couldn't decline invite.", {
        tone: "error",
      });
    } finally {
      setBusy(null);
    }
  };

  if (invites.length === 0 && !joined) return null;

  return (
    <div className="mb-5 space-y-2">
      {joined && (
        <div role="status" data-testid="invite-joined" className="card flex flex-wrap items-center justify-between gap-3 rounded-2xl p-4">
          <p className="min-w-0 text-sm text-ink">
            You joined <strong>{joined}</strong>. See what the agency can do for you on the Agency page.
          </p>
          <a href="/agency" className="inline-flex min-h-9 items-center rounded-lg border border-line px-3 text-sm font-semibold text-ink hover:bg-surface-2">
            Open Agency
          </a>
        </div>
      )}
      {invites.map((inv) => (
        <div
          key={inv.id}
          className="card flex flex-wrap items-center justify-between gap-3 rounded-2xl border-[var(--brand)]/40 p-4"
        >
          <div className="min-w-0">
            <p className="font-bold text-ink">
              🏢 {inv.orgName} invited you to {inv.role ? `join as a ${inv.role}` : "join their agency"}
            </p>
            <p className="text-sm text-muted">
              {inv.role
                ? "Accepting gives you a staff seat there; your own account and data stay yours. You can be removed at any time."
                : "Accepting lets the agency manage your wheels, fans, and fulfilment. You can be removed at any time."}
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
