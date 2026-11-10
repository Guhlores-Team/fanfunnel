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
  /** WG-05: who runs the agency (public creator name), when known. */
  invitedBy?: string | null;
  expiresAt?: string | null;
}

// WG-05: each refusal the server can give, as a next step.
const RESPOND_ERRORS: Record<string, string> = {
  expired: "That invitation has expired. Ask the agency owner to send a new one.",
  gone: "That invitation was withdrawn or already answered.",
  already_in_org: "Your account is already managed by another agency. Leave it on the Agency page first, then accept.",
  not_invitee: "This invitation was sent to a different e-mail address than the one on your account.",
  inactive: "This invitation can't be accepted right now: either your account or the agency owner's is suspended.",
  rate_limited: "Too many tries in a row. Wait a minute and try again.",
};

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
  // WG-05 / WC-12: accepting and declining are explicit second steps.
  const [confirming, setConfirming] = useState<{ id: string; accept: boolean } | null>(null);
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
        const known = typeof body?.error === "string" ? RESPOND_ERRORS[body.error] : undefined;
        if (known) {
          toast(known, { tone: "error", duration: 8000 });
          if (body.error !== "expired" && body.error !== "gone") setInvites(snapshot);
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
      setConfirming(null);
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
          className="card flex flex-wrap items-center justify-between gap-3 rounded-2xl border-[var(--brand-ui)]/40 p-4"
        >
          <div className="min-w-0 flex-1 basis-72">
            <p className="font-bold text-ink">
              🏢 {inv.orgName} invited you to {inv.role ? `join as a ${inv.role}` : "join their agency"}
            </p>
            <p className="text-sm text-muted">
              {inv.invitedBy ? <>Run by <span className="text-ink">{inv.invitedBy}</span>. </> : null}
              {inv.role
                ? "Accepting gives you a staff seat there; your own account and data stay yours. You can leave at any time, and the owner can remove you."
                : "Accepting lets the agency run your account with you. You can leave at any time from the Agency page, and the owner can remove you."}
            </p>
            {!inv.role && confirming?.id === inv.id && confirming.accept && (
              <div role="group" aria-label={`What ${inv.orgName} will be able to do`} data-testid="invite-consent" className="mt-3 rounded-xl border border-[var(--brand-ui)]/40 p-3 text-sm text-ink">
                <p className="font-semibold">Before you accept, this is what {inv.orgName} and its staff can do:</p>
                <ul className="mt-1.5 list-disc space-y-1 pl-5 text-muted">
                  <li>Read and answer every fan conversation in your Inbox, as you.</li>
                  <li>See your fans&apos; names, their links, tips recorded for them, and your prize queue; mark prizes delivered.</li>
                  <li>Run campaigns for you. Your games, fan links, boosts and settings stay yours to edit.</li>
                  <li>Nothing they do is hidden: replies and fulfilments show in your own dashboard.</li>
                </ul>
                <p className="mt-2 text-muted">You can leave at any time under Agency; the agency loses access the moment you do.</p>
              </div>
            )}
            {confirming?.id === inv.id && !confirming.accept && (
              <p role="status" data-testid="invite-decline-confirm" className="mt-3 text-sm text-muted">Decline this invitation? The owner would have to invite you again.</p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {confirming?.id === inv.id ? (
              <>
                <button
                  onClick={() => respond(inv.id, confirming.accept)}
                  disabled={busy === inv.id}
                  data-testid={confirming.accept ? "invite-accept-confirm" : "invite-decline-confirm-button"}
                  className={confirming.accept ? "btn-brand min-h-10 rounded-lg px-4 text-sm font-bold disabled:opacity-50" : "min-h-10 rounded-lg border border-red-400/50 px-4 text-sm font-semibold text-red-300 disabled:opacity-50"}
                >
                  {busy === inv.id ? "Working…" : confirming.accept ? (inv.role ? "Yes, take the seat" : "I agree, join the agency") : "Yes, decline"}
                </button>
                <button onClick={() => setConfirming(null)} disabled={busy === inv.id} className="min-h-10 rounded-lg border border-line px-3 text-sm font-semibold text-muted hover:text-ink disabled:opacity-50">
                  Back
                </button>
              </>
            ) : (
              <>
                <button
                  onClick={() => setConfirming({ id: inv.id, accept: true })}
                  disabled={busy === inv.id}
                  aria-expanded={false}
                  className="btn-brand min-h-10 rounded-lg px-4 text-sm font-bold disabled:opacity-50"
                >
                  Accept…
                </button>
                <button
                  onClick={() => setConfirming({ id: inv.id, accept: false })}
                  disabled={busy === inv.id}
                  className="min-h-10 rounded-lg border border-line px-3 text-sm font-semibold text-muted hover:text-ink disabled:opacity-50"
                >
                  Decline…
                </button>
              </>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
