"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { AGENCY_INVITE_TTL_DAYS } from "@/lib/agency/config";
import { formatCents } from "@/lib/format";
import SeatWorkspace from "./SeatWorkspace";
import LeaveAgency, { LeftAgency, leaveKind, type LeaveKind } from "./LeaveAgency";

interface CreatorStat {
  id: string;
  displayName: string;
  email: string;
  wheels: number;
  fans: number;
  spins: number;
  pending: number;
  revenue: number;
}
interface Member {
  id: string;
  profileId: string;
  email: string;
  displayName: string;
  role: string;
  /** C10: the creators this seat may act for (owner view). */
  creatorIds?: string[];
}
interface Invite {
  /** null: a creator invitation; otherwise the seat role offered (0068). */
  role?: string | null;
  id: string;
  email: string;
}
interface Overview {
  org: { id: string; name: string } | null;
  /** A36: demo mode, where agencies can't be created. */
  demo?: boolean;
  /** A45: the caller is a creator an agency manages (no console of its own). */
  managed?: boolean;
  /** With `managed`: that agency's id, so the creator can leave it. */
  orgId?: string | null;
  isOwner: boolean;
  totals: { creators: number; fans: number; spins: number; pending: number; revenue: number };
  creators: CreatorStat[];
  members: Member[];
  invites: Invite[];
}

const ROLES = ["manager", "chatter", "fulfiller", "analyst"] as const;

async function manage(body: Record<string, unknown>): Promise<string | null> {
  const res = await fetch("/api/agency/manage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.ok) return null;
  const d = await res.json().catch(() => ({}));
  return d.error ?? "error";
}

// Map each known status the agency RPC can return to a specific, actionable
// message (mirrors how SpinClient maps spin error codes) rather than falling
// back to one generic line.
const errLabel = (e: string) =>
  ({
    invalid_email: "Enter a valid email address.",
    rate_limited: "Too many invitations in the last hour. Try again later.",
    already_in_org: "That creator is already in another agency.",
    expired: "That invitation has expired. Send a new invitation.",
    not_owner: "Only the agency owner can do that.",
    not_found: "That item no longer exists — refresh and try again.",
    invalid_role: "Pick a valid staff role.",
    db_error: "Something went wrong on our end — please try again.",
    demo_only: "Demo only: agencies need a connected database, so nothing was saved.",
  })[e] ?? "Couldn't complete that — please try again.";

export default function AgencyClient() {
  const [data, setData] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);
  // Stable keys for in-flight destructive actions so each button can disable
  // itself while its request is pending (prevents double-submits).
  const [busyKeys, setBusyKeys] = useState<Set<string>>(new Set());
  const [left, setLeft] = useState<LeaveKind | null>(null);
  // C10: removing a creator or a seat asks first ("creator:<id>" / "member:<id>").
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/agency", { cache: "no-store" });
      if (res.ok) setData(await res.json());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = async (body: Record<string, unknown>) => {
    setMsg(null);
    const err = await manage(body);
    if (err) {
      setMsg(errLabel(err));
      return false;
    }
    await refresh();
    return true;
  };

  // Guarded variant for destructive actions: no-ops while the same `key` is
  // already in flight, and toggles `busyKeys` so the triggering button disables.
  const runGuarded = async (key: string, body: Record<string, unknown>) => {
    if (busyKeys.has(key)) return false;
    setBusyKeys((s) => new Set(s).add(key));
    try {
      return await run(body);
    } finally {
      setBusyKeys((s) => {
        const next = new Set(s);
        next.delete(key);
        return next;
      });
    }
  };

  if (loading) return <p className="p-8 text-sm text-muted">Loading…</p>;

  if (left) return <LeftAgency kind={left} />;

  // Never the owner, the demo or a non-member (leaveKind).
  const canLeave = leaveKind(data);

  if (data && !data.org && data.managed) {
    return <ManagedByAgency orgId={canLeave === "creator" ? data.orgId ?? null : null} onLeft={() => setLeft("creator")} />;
  }

  // No org yet → let the user create one.
  if (!data || !data.org) {
    return <CreateOrg demo={!!data?.demo} msg={msg} onCreate={(name) => run({ action: "create_org", name })} />;
  }

  const { org, isOwner } = data;
  const t = data.totals;
  const tiles = [
    { label: "Creators", value: String(t.creators) },
    { label: "Fans", value: String(t.fans) },
    { label: "Spins", value: String(t.spins) },
    { label: "Pending", value: String(t.pending) },
    { label: "Revenue", value: formatCents(t.revenue) },
  ];

  return (
    <div className="mx-auto max-w-6xl px-5 py-8 text-ink">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-extrabold">{org.name}</h1>
          <p className="text-sm text-muted">
            Agency console{isOwner ? " · owner" : " · staff"}
          </p>
        </div>
        <Link
          href="/dashboard"
          className="inline-flex min-h-9 items-center rounded-lg border border-line px-3 text-xs font-semibold text-muted hover:bg-surface-2 hover:text-ink"
        >
          ← My dashboard
        </Link>
      </header>

      <SeatWorkspace />

      {msg && (
        <p className="mt-4 rounded-lg border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-sm text-amber-200">
          {msg}
        </p>
      )}

      <div className="mt-6 grid gap-4 sm:grid-cols-3 lg:grid-cols-5">
        {tiles.map((tile) => (
          <div key={tile.label} className="rounded-2xl border border-line bg-surface p-5">
            <p className="text-2xl font-extrabold text-brand">{tile.value}</p>
            <p className="mt-1 text-sm text-muted">{tile.label}</p>
          </div>
        ))}
      </div>

      <div className="mt-8 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-bold">Creators</h2>
        {isOwner && (
          <AddByEmail
            placeholder="Invite creator by email"
            label="Creator's email"
            cta="Invite"
            onAdd={(email) => run({ action: "add_creator", orgId: org.id, email })}
          />
        )}
      </div>

      {isOwner && <p className="mt-2 text-sm text-muted">Invitations expire after {AGENCY_INVITE_TTL_DAYS} days. Send a new invitation if one expires.</p>}
      {isOwner && data.invites.some((inv) => !inv.role) && (
        <div className="mt-3 space-y-2">
          {data.invites.filter((inv) => !inv.role).map((inv) => (
            <div
              key={inv.id}
              className="flex items-center justify-between gap-3 rounded-2xl border border-dashed border-line bg-surface p-4"
            >
              <div className="min-w-0">
                <p className="text-sm text-muted">{inv.email}</p>
                <p className="text-xs text-amber-300/80">Invited · awaiting acceptance</p>
              </div>
              <button
                onClick={() =>
                  runGuarded(`revoke:${inv.id}`, { action: "revoke_invite", inviteId: inv.id })
                }
                disabled={busyKeys.has(`revoke:${inv.id}`)}
                className="rounded-md border border-line px-2 py-1 text-xs text-muted hover:text-ink disabled:opacity-50"
              >
                Revoke
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="mt-3 space-y-2">
        {data.creators.map((c) => (
          <div
            key={c.id}
            className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-line bg-surface p-4"
          >
            <div className="min-w-0">
              <p className="font-bold">{c.displayName}</p>
              <p className="text-xs text-muted">{c.email}</p>
            </div>
            <div className="flex flex-wrap items-center gap-4 text-sm text-muted">
              <span>{c.fans} fans</span>
              <span>{c.spins} spins</span>
              <span>{c.pending} pending</span>
              <span className="font-bold text-brand">{formatCents(c.revenue)}</span>
              {isOwner && (
                <button
                  onClick={() => setConfirmRemove(`creator:${c.id}`)}
                  disabled={busyKeys.has(`creator:${c.id}`)}
                  aria-expanded={confirmRemove === `creator:${c.id}`}
                  className="rounded-md border border-line px-2 py-1 text-xs text-muted hover:text-ink disabled:opacity-50"
                >
                  Remove
                </button>
              )}
            </div>
            {isOwner && confirmRemove === `creator:${c.id}` && (
              <ConfirmRemove
                text={`Remove ${c.displayName} from ${org.name}? Your owner, managers and staff lose access to their games, fans, inbox and fulfilment right away. Their account and data stay theirs; you'd need a new invitation to add them back.`}
                cta="Yes, remove creator"
                busy={busyKeys.has(`creator:${c.id}`)}
                onCancel={() => setConfirmRemove(null)}
                onConfirm={async () => {
                  if (await runGuarded(`creator:${c.id}`, { action: "remove_creator", orgId: org.id, creatorId: c.id })) setConfirmRemove(null);
                }}
              />
            )}
          </div>
        ))}
        {data.creators.length === 0 && (
          <p className="text-sm text-muted">No creators yet. Invite one by email above — they join once they accept.</p>
        )}
      </div>

      <div className="mt-8 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-bold">Staff seats</h2>
        {isOwner && (
          <AddByEmail
            placeholder="Add seat by email"
            label="Staff member's email"
            describedBy="seat-onboarding-help"
            withRole
            onAdd={(email, role) =>
              run({ action: "add_member", orgId: org.id, email, role: role ?? "analyst" })
            }
          />
        )}
      </div>
      {isOwner && (
        <p id="seat-onboarding-help" data-testid="seat-onboarding-help" className="mt-2 max-w-2xl text-sm text-muted text-pretty">
          Staff need an approved creator account first: they sign up, and an admin approves it. Add them by the email
          on that account; they&apos;ll get an invite to accept. A seat does nothing while their account is waiting for approval.
          Managers act for every creator in the agency; chatters, fulfillers and analysts only for the creators you tick below.
        </p>
      )}
      <div className="mt-3 space-y-2">
        {data.members.map((m) => (
          <div key={m.id} className="rounded-2xl border border-line bg-surface p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="font-bold">{m.displayName}</p>
                <p className="text-xs text-muted">{m.email}</p>
              </div>
              <div className="flex items-center gap-2">
                <span className="rounded-full bg-surface-2 px-3 py-1 text-xs font-semibold capitalize">
                  {m.role}
                </span>
                {isOwner && (
                  <button
                    onClick={() => setConfirmRemove(`member:${m.id}`)}
                    disabled={busyKeys.has(`member:${m.id}`)}
                    aria-expanded={confirmRemove === `member:${m.id}`}
                    className="rounded-md border border-line px-2 py-1 text-xs text-muted hover:text-ink disabled:opacity-50"
                  >
                    Remove
                  </button>
                )}
              </div>
            </div>
            {isOwner && confirmRemove === `member:${m.id}` && (
              <ConfirmRemove
                text={`Remove ${m.displayName}'s ${m.role} seat? They lose access to every creator in ${org.name} right away. Their own account stays.`}
                cta="Yes, remove seat"
                busy={busyKeys.has(`member:${m.id}`)}
                onCancel={() => setConfirmRemove(null)}
                onConfirm={async () => {
                  if (await runGuarded(`member:${m.id}`, { action: "remove_member", memberId: m.id })) setConfirmRemove(null);
                }}
              />
            )}
            {/* Manager seats act for every creator; others are scoped per-creator (C10: toggles with state). */}
            {isOwner && m.role !== "manager" && data.creators.length > 0 && (
              <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3" role="group" aria-label={`Creators ${m.displayName} can act for`}>
                <span className="text-xs text-muted">Can act for:</span>
                {data.creators.map((c) => {
                  const on = (m.creatorIds ?? []).includes(c.id);
                  const key = `scope:${m.id}:${c.id}`;
                  return (
                    <button
                      key={c.id}
                      type="button"
                      role="switch"
                      aria-checked={on}
                      aria-label={`${m.displayName} can act for ${c.displayName}`}
                      disabled={busyKeys.has(key)}
                      onClick={() => runGuarded(key, { action: "scope_creator", memberId: m.id, creatorId: c.id, on: !on })}
                      className={`inline-flex min-h-7 items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs disabled:opacity-50 ${
                        on ? "border-brand/50 bg-surface-2 font-semibold text-ink" : "border-line text-muted hover:bg-surface-2 hover:text-ink"
                      }`}
                    >
                      <span aria-hidden="true">{on ? "✓" : "+"}</span>
                      {c.displayName}
                    </button>
                  );
                })}
                {(m.creatorIds ?? []).length === 0 && (
                  <span className="text-xs text-amber-300/80">None yet: this seat can&apos;t do anything until you tick a creator.</span>
                )}
              </div>
            )}
          </div>
        ))}
        {isOwner && data.invites.filter((inv) => !!inv.role).map((inv) => (
          <div
            key={inv.id}
            className="flex items-center justify-between gap-3 rounded-2xl border border-dashed border-line bg-surface p-4"
          >
            <div className="min-w-0">
              <p className="text-sm text-muted">{inv.email}</p>
              <p className="text-xs text-amber-300/80">Invited as {inv.role} · awaiting acceptance</p>
            </div>
            <button
              onClick={() => runGuarded(`revoke:${inv.id}`, { action: "revoke_invite", inviteId: inv.id })}
              disabled={busyKeys.has(`revoke:${inv.id}`)}
              className="rounded-md border border-line px-2 py-1 text-xs text-muted hover:text-ink disabled:opacity-50"
            >
              Revoke
            </button>
          </div>
        ))}
        {data.members.length === 0 && !data.invites.some((inv) => !!inv.role) && (
          <p className="text-sm text-muted">No staff seats yet.</p>
        )}
      </div>

      {canLeave === "staff" && <LeaveAgency kind="staff" orgId={org.id} orgName={org.name} onLeft={() => setLeft("staff")} />}
    </div>
  );
}

function ConfirmRemove({
  text,
  cta,
  busy,
  onConfirm,
  onCancel,
}: {
  text: string;
  cta: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div role="group" aria-label="Confirm removal" className="mt-3 w-full rounded-xl border border-red-400/35 bg-red-400/10 p-3 text-sm text-ink">
      <p className="text-pretty">{text}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onConfirm}
          disabled={busy}
          className="rounded-md border border-red-400/60 bg-red-500/25 px-3 py-1.5 text-xs font-bold text-ink hover:bg-red-500/35 disabled:opacity-50"
        >
          {busy ? "Removing…" : cta}
        </button>
        <button type="button" onClick={onCancel} disabled={busy} className="rounded-md border border-line px-3 py-1.5 text-xs text-muted hover:text-ink">
          Cancel
        </button>
      </div>
    </div>
  );
}

function CreateOrg({ onCreate, demo, msg }: { onCreate: (name: string) => Promise<boolean>; demo: boolean; msg: string | null }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="mx-auto max-w-md px-5 py-24 text-center text-ink">
      <p className="text-5xl" aria-hidden="true">🏢</p>
      <h1 className="mt-4 text-xl font-bold">Start your agency</h1>
      <p className="mt-2 text-sm text-muted">
        Manage multiple creators and give staff scoped access — chatters, fulfillers,
        and managers each see only what they should.
      </p>
      {demo && (
        <p data-testid="agency-demo-only" className="mt-4 rounded-xl border border-line px-4 py-3 text-sm text-muted">
          Demo only: agencies need a connected database. You can look around, but nothing here is saved.
        </p>
      )}
      {msg && (
        <p role="alert" className="mt-4 text-sm text-amber-200">
          {msg}
        </p>
      )}
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Agency name"
        aria-label="Agency name"
        className="ff-input mt-6 w-full text-center"
      />
      <button
        onClick={async () => {
          setBusy(true);
          try {
            await onCreate(name);
          } finally {
            setBusy(false); // always clear, even if the action rejects (else stuck disabled)
          }
        }}
        disabled={busy || !name.trim()}
        className="mt-3 w-full btn-brand rounded-xl py-2.5 font-bold"
      >
        {busy ? "Creating…" : "Create agency"}
      </button>
      <Link href="/dashboard" className="mt-4 inline-block text-sm text-muted hover:text-ink">
        ← Back to dashboard
      </Link>
    </div>
  );
}

function AddByEmail({
  placeholder,
  label,
  describedBy,
  withRole,
  cta = "Add",
  onAdd,
}: {
  placeholder: string;
  label: string;
  describedBy?: string;
  withRole?: boolean;
  cta?: string;
  onAdd: (email: string, role?: string) => Promise<boolean>;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<string>("analyst");
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <input
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder={placeholder}
        type="email"
        aria-label={label}
        aria-describedby={describedBy}
        className="ff-input w-44 min-w-0 text-sm sm:w-52"
      />
      {withRole && (
        <select
          value={role}
          onChange={(e) => setRole(e.target.value)}
          aria-label="Staff role"
          className="ff-input w-auto text-sm capitalize"
        >
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      )}
      <button
        onClick={async () => {
          if (!email.trim()) return;
          setBusy(true);
          try {
            const ok = await onAdd(email.trim(), withRole ? role : undefined);
            if (ok) setEmail("");
          } finally {
            setBusy(false); // always clear, even if the action rejects (else stuck disabled)
          }
        }}
        disabled={busy}
        className="btn-brand min-h-9 rounded-lg px-3 text-sm font-bold"
      >
        {cta}
      </button>
    </div>
  );
}

/** A45: a creator an agency manages has no console; say what that means,
 *  and let them leave it. */
function ManagedByAgency({ orgId, onLeft }: { orgId: string | null; onLeft: () => void }) {
  return (
    <div data-testid="agency-managed" className="mx-auto max-w-md px-5 py-24 text-center text-ink">
      <h1 className="text-xl font-bold">You&apos;re part of an agency</h1>
      <p className="mt-3 text-sm text-muted text-pretty">
        You accepted an agency&apos;s invitation. Its owner and managers can run your games, campaigns, fans and
        fulfilment, and staff it assigns to you can answer your inbox or fulfil your prizes. Everything they do shows up
        in your own dashboard. The agency owner can remove you at any time{orgId ? ", and you can leave it yourself below." : "; ask them if you want to leave."}
      </p>
      <Link href="/dashboard" className="mt-6 inline-flex min-h-10 items-center rounded-lg border border-line px-4 text-sm font-semibold text-muted hover:bg-surface-2 hover:text-ink">
        ← Back to dashboard
      </Link>
      {orgId && <LeaveAgency kind="creator" orgId={orgId} onLeft={onLeft} />}
    </div>
  );
}
