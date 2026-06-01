"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { formatCents } from "@/lib/format";

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
}
interface Overview {
  org: { id: string; name: string } | null;
  isOwner: boolean;
  totals: { creators: number; fans: number; spins: number; pending: number; revenue: number };
  creators: CreatorStat[];
  members: Member[];
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

const errLabel = (e: string) =>
  ({
    no_such_user: "No account with that email.",
    already_in_org: "That creator is already in another agency.",
    not_owner: "Only the agency owner can do that.",
    db_error: "Something went wrong.",
  })[e] ?? "Couldn't complete that.";

export default function AgencyClient() {
  const [data, setData] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);

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

  if (loading) return <p className="p-8 text-sm text-white/40">Loading…</p>;

  // No org yet → let the user create one.
  if (!data || !data.org) {
    return <CreateOrg onCreate={(name) => run({ action: "create_org", name })} />;
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
    <div className="mx-auto max-w-6xl px-5 py-8 text-white">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-extrabold">{org.name}</h1>
          <p className="text-sm text-white/50">
            Agency console{isOwner ? " · owner" : " · staff"}
          </p>
        </div>
        <Link
          href="/dashboard"
          className="rounded-lg border border-white/15 px-3 py-1.5 text-xs font-semibold text-white/70 hover:bg-white/5"
        >
          ← My dashboard
        </Link>
      </header>

      {msg && (
        <p className="mt-4 rounded-lg border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-sm text-amber-200">
          {msg}
        </p>
      )}

      <div className="mt-6 grid gap-4 sm:grid-cols-3 lg:grid-cols-5">
        {tiles.map((tile) => (
          <div key={tile.label} className="rounded-2xl border border-white/10 bg-white/5 p-5">
            <p className="text-2xl font-extrabold text-pink-300">{tile.value}</p>
            <p className="mt-1 text-sm text-white/50">{tile.label}</p>
          </div>
        ))}
      </div>

      <div className="mt-8 flex items-center justify-between">
        <h2 className="text-lg font-bold">Creators</h2>
        {isOwner && (
          <AddByEmail
            placeholder="Add creator by email"
            onAdd={(email) => run({ action: "add_creator", orgId: org.id, email })}
          />
        )}
      </div>
      <div className="mt-3 space-y-2">
        {data.creators.map((c) => (
          <div
            key={c.id}
            className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/10 bg-white/5 p-4"
          >
            <div className="min-w-0">
              <p className="font-bold">{c.displayName}</p>
              <p className="text-xs text-white/40">{c.email}</p>
            </div>
            <div className="flex flex-wrap items-center gap-4 text-sm text-white/70">
              <span>{c.fans} fans</span>
              <span>{c.spins} spins</span>
              <span>{c.pending} pending</span>
              <span className="font-bold text-pink-300">{formatCents(c.revenue)}</span>
              {isOwner && (
                <button
                  onClick={() => run({ action: "remove_creator", orgId: org.id, creatorId: c.id })}
                  className="rounded-md border border-white/15 px-2 py-1 text-xs text-white/50 hover:text-white"
                >
                  Remove
                </button>
              )}
            </div>
          </div>
        ))}
        {data.creators.length === 0 && (
          <p className="text-sm text-white/40">No creators yet. Add one by email above.</p>
        )}
      </div>

      <div className="mt-8 flex items-center justify-between">
        <h2 className="text-lg font-bold">Staff seats</h2>
        {isOwner && (
          <AddByEmail
            placeholder="Add seat by email"
            withRole
            onAdd={(email, role) =>
              run({ action: "add_member", orgId: org.id, email, role: role ?? "analyst" })
            }
          />
        )}
      </div>
      <div className="mt-3 space-y-2">
        {data.members.map((m) => (
          <div key={m.id} className="rounded-2xl border border-white/10 bg-white/5 p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="font-bold">{m.displayName}</p>
                <p className="text-xs text-white/40">{m.email}</p>
              </div>
              <div className="flex items-center gap-2">
                <span className="rounded-full bg-white/10 px-3 py-1 text-xs font-semibold capitalize">
                  {m.role}
                </span>
                {isOwner && (
                  <button
                    onClick={() => run({ action: "remove_member", memberId: m.id })}
                    className="rounded-md border border-white/15 px-2 py-1 text-xs text-white/50 hover:text-white"
                  >
                    Remove
                  </button>
                )}
              </div>
            </div>
            {/* Manager seats act for every creator; others are scoped per-creator. */}
            {isOwner && m.role !== "manager" && data.creators.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-2 border-t border-white/10 pt-3">
                <span className="text-xs text-white/40">Can act for:</span>
                {data.creators.map((c) => (
                  <button
                    key={c.id}
                    onClick={() =>
                      run({ action: "scope_creator", memberId: m.id, creatorId: c.id, on: true })
                    }
                    className="rounded-full border border-white/15 px-2.5 py-0.5 text-xs text-white/60 hover:bg-white/10 hover:text-white"
                  >
                    + {c.displayName}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
        {data.members.length === 0 && (
          <p className="text-sm text-white/40">No staff seats yet.</p>
        )}
      </div>
    </div>
  );
}

function CreateOrg({ onCreate }: { onCreate: (name: string) => Promise<boolean> }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="mx-auto max-w-md px-5 py-24 text-center text-white">
      <p className="text-5xl">🏢</p>
      <h1 className="mt-4 text-xl font-bold">Start your agency</h1>
      <p className="mt-2 text-sm text-white/50">
        Manage multiple creators and give staff scoped access — chatters, fulfillers,
        and managers each see only what they should.
      </p>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Agency name"
        className="mt-6 w-full rounded-xl border border-white/15 bg-white/5 px-4 py-2.5 text-center"
      />
      <button
        onClick={async () => {
          setBusy(true);
          await onCreate(name);
          setBusy(false);
        }}
        disabled={busy || !name.trim()}
        className="mt-3 w-full rounded-xl bg-pink-500 py-2.5 font-bold hover:bg-pink-400 disabled:opacity-50"
      >
        {busy ? "Creating…" : "Create agency"}
      </button>
      <Link href="/dashboard" className="mt-4 inline-block text-sm text-white/50 hover:text-white">
        ← Back to dashboard
      </Link>
    </div>
  );
}

function AddByEmail({
  placeholder,
  withRole,
  onAdd,
}: {
  placeholder: string;
  withRole?: boolean;
  onAdd: (email: string, role?: string) => Promise<boolean>;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<string>("analyst");
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex items-center gap-2">
      <input
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder={placeholder}
        className="w-44 rounded-lg border border-white/15 bg-white/5 px-3 py-1.5 text-sm sm:w-52"
      />
      {withRole && (
        <select
          value={role}
          onChange={(e) => setRole(e.target.value)}
          className="rounded-lg border border-white/15 bg-white/5 px-2 py-1.5 text-sm capitalize"
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
          const ok = await onAdd(email.trim(), withRole ? role : undefined);
          setBusy(false);
          if (ok) setEmail("");
        }}
        disabled={busy}
        className="rounded-lg bg-pink-500 px-3 py-1.5 text-sm font-bold hover:bg-pink-400 disabled:opacity-50"
      >
        Add
      </button>
    </div>
  );
}
