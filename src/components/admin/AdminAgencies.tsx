"use client";

import { useCallback, useEffect, useState } from "react";
import { useToast } from "@/components/ui/Toast";
import LoadFailed from "@/components/dashboard/LoadFailed";
import { loadJson } from "@/lib/hooks/loadJson";
import { P, Glyph, SectionTitle, raised, recessed, btnGhost, btnDanger, pill } from "./adminUi";
import { accountErrorMessage } from "./adminErrors";

interface Agency {
  id: string;
  name: string;
  createdAt: string;
  owner: { id: string; displayName: string; email: string; isActive: boolean } | null;
  seats: { memberId: string; profileId: string; displayName: string; role: string; isActive: boolean }[];
  creators: { id: string; displayName: string; email: string }[];
  pendingInvites: number;
}

/**
 * WG-09: the admin's read of agencies — who owns which, who sits where and
 * who is managed — with two audited levers (remove a seat, dissolve) and a
 * pointer to the ordinary Suspend for the owner, which pauses every seat.
 */
export default function AdminAgencies({ onSuspendOwner }: { onSuspendOwner?: (profileId: string) => void }) {
  const toast = useToast();
  const [agencies, setAgencies] = useState<Agency[] | null>(null);
  const [demo, setDemo] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ kind: "seat"; memberId: string; agencyId: string } | { kind: "dissolve"; agencyId: string } | null>(null);
  const [typed, setTyped] = useState("");

  const load = useCallback(async () => {
    try {
      const d = await loadJson<{ agencies: Agency[]; demo?: boolean }>("/api/admin/agencies");
      setAgencies(d.agencies ?? []);
      setDemo(d.demo === true);
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async fetch; state changes only after the response arrives
    void load();
  }, [load]);

  async function act(key: string, body: Record<string, unknown>) {
    if (busy) return;
    setBusy(key);
    try {
      const res = await fetch("/api/admin/agencies", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast(d.error === "name_mismatch" ? "The agency name didn't match — nothing was changed." : d.error === "demo_only" ? "Demo only: agencies need a connected database." : accountErrorMessage(typeof d.error === "string" ? d.error : null), { tone: "error" });
        return;
      }
      toast(body.action === "dissolve" ? "Agency dissolved. Its seats and creators were told." : "Seat removed.", { tone: "success" });
      setConfirm(null);
      setTyped("");
      await load();
    } catch {
      toast("Couldn't reach the server. Try again.", { tone: "error" });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section aria-labelledby="admin-agencies" className={`lift-in overflow-hidden rounded-2xl ${raised}`}>
      <SectionTitle id="admin-agencies" extra={agencies ? <span className="tnum text-xs text-muted">{agencies.length} total</span> : null}>
        Agencies
      </SectionTitle>
      <div className="px-4 pb-4 sm:px-[18px]">
        {error != null && !agencies ? (
          <LoadFailed error={error} what="the agencies" onRetry={load} testId="admin-agencies-load-failed" />
        ) : agencies === null ? (
          <p className="py-4 text-[13px] text-muted" aria-busy="true">Loading agencies…</p>
        ) : agencies.length === 0 ? (
          <p data-testid="admin-agencies-empty" className="py-4 text-[13.5px] text-muted">
            {demo ? "Demo only: agencies need a connected database, so there are none to show." : "No agencies yet. A creator starts one on their Agency page."}
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {agencies.map((a) => (
              <li key={a.id} data-testid="admin-agency" className={`rounded-[13px] p-4 ${recessed}`}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-[14px] font-semibold text-ink">{a.name}</p>
                    <p className="mt-0.5 text-[12.5px] text-muted">
                      Owner: {a.owner ? <><span className="text-ink">{a.owner.displayName}</span> <span className="break-all">({a.owner.email})</span></> : "unknown"}
                      {a.owner && !a.owner.isActive && <span className={`${pill} ml-2 bg-[#ef4444]/15 text-[#fca5a5]`}>owner suspended · agency paused</span>}
                    </p>
                    <p className="tnum mt-1 text-xs text-muted">
                      {a.creators.length} managed {a.creators.length === 1 ? "creator" : "creators"} · {a.seats.length} {a.seats.length === 1 ? "seat" : "seats"} · {a.pendingInvites} open {a.pendingInvites === 1 ? "invitation" : "invitations"}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {a.owner && a.owner.isActive && onSuspendOwner && (
                      <button type="button" onClick={() => onSuspendOwner(a.owner!.id)} className={btnGhost}>Suspend owner…</button>
                    )}
                    <button type="button" onClick={() => { setConfirm({ kind: "dissolve", agencyId: a.id }); setTyped(""); }} aria-expanded={confirm?.kind === "dissolve" && confirm.agencyId === a.id} className={btnDanger}>
                      Dissolve…
                    </button>
                  </div>
                </div>
                {a.creators.length > 0 && (
                  <p className="mt-2 text-xs text-muted"><span className="font-semibold text-ink">Manages:</span> {a.creators.map((c) => c.displayName).join(", ")}</p>
                )}
                {a.seats.length > 0 && (
                  <ul className="mt-2 flex flex-wrap gap-1.5" aria-label={`Seats in ${a.name}`}>
                    {a.seats.map((s) => (
                      <li key={s.memberId} className="inline-flex items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-xs text-ink">
                        {s.displayName} <span className="text-muted">· {s.role}</span>
                        {!s.isActive && <span className="text-[#fca5a5]">· suspended</span>}
                        <button type="button" onClick={() => setConfirm({ kind: "seat", memberId: s.memberId, agencyId: a.id })} aria-label={`Remove ${s.displayName}'s ${s.role} seat from ${a.name}`} className="ml-1 grid h-6 w-6 place-items-center rounded-full text-muted hover:text-ink">
                          <Glyph d={P.x} size={12} />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {confirm && confirm.agencyId === a.id && (
                  <div role="group" aria-label={confirm.kind === "seat" ? "Confirm removing the seat" : `Confirm dissolving ${a.name}`} className="mt-3 rounded-[11px] border border-[#ef4444]/35 bg-[#ef4444]/10 p-3.5 text-xs leading-relaxed text-[#fecaca]">
                    {confirm.kind === "seat" ? (
                      <p>Remove this seat? They lose access to every creator in {a.name} right away. This is logged.</p>
                    ) : (
                      <>
                        <p>
                          Dissolve <strong className="text-ink">{a.name}</strong>? Its {a.seats.length} {a.seats.length === 1 ? "seat" : "seats"} end, its {a.creators.length} managed{" "}
                          {a.creators.length === 1 ? "creator keeps" : "creators keep"} their own account, and everyone gets a notice. The owner&rsquo;s own account stays. Type the agency name to confirm:
                        </p>
                        <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={a.name} autoComplete="off" aria-label={`Type ${a.name} to confirm`} className="ff-input mt-2 w-full text-xs" />
                      </>
                    )}
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        type="button"
                        disabled={busy !== null || (confirm.kind === "dissolve" && typed.trim().toLowerCase() !== a.name.trim().toLowerCase())}
                        onClick={() => void act(a.id, confirm.kind === "seat" ? { action: "remove_seat", memberId: confirm.memberId } : { action: "dissolve", orgId: a.id, confirmName: typed })}
                        className={btnDanger}
                      >
                        {busy === a.id ? "Working…" : confirm.kind === "seat" ? "Yes, remove seat" : "Yes, dissolve agency"}
                      </button>
                      <button type="button" onClick={() => setConfirm(null)} className={btnGhost}>Cancel</button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
