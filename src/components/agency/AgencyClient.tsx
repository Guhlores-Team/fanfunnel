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

export default function AgencyClient() {
  const [data, setData] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);

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

  if (loading) {
    return <p className="p-8 text-sm text-white/40">Loading…</p>;
  }

  if (!data || !data.org) {
    return (
      <div className="mx-auto max-w-md px-5 py-24 text-center text-white">
        <p className="text-5xl">🏢</p>
        <h1 className="mt-4 text-xl font-bold">No agency yet</h1>
        <p className="mt-2 text-sm text-white/50">
          You&rsquo;re not part of an agency org. Agency owners manage multiple
          creators and scoped staff seats here.
        </p>
        <Link
          href="/dashboard"
          className="mt-6 inline-block rounded-xl bg-pink-500 px-5 py-2.5 font-bold"
        >
          Back to dashboard
        </Link>
      </div>
    );
  }

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
          <h1 className="text-2xl font-extrabold">{data.org.name}</h1>
          <p className="text-sm text-white/50">Agency console · cross-creator roll-up</p>
        </div>
        <Link
          href="/dashboard"
          className="rounded-lg border border-white/15 px-3 py-1.5 text-xs font-semibold text-white/70 hover:bg-white/5"
        >
          ← My dashboard
        </Link>
      </header>

      <div className="mt-6 grid gap-4 sm:grid-cols-3 lg:grid-cols-5">
        {tiles.map((tile) => (
          <div key={tile.label} className="rounded-2xl border border-white/10 bg-white/5 p-5">
            <p className="text-2xl font-extrabold text-pink-300">{tile.value}</p>
            <p className="mt-1 text-sm text-white/50">{tile.label}</p>
          </div>
        ))}
      </div>

      <h2 className="mt-8 text-lg font-bold">Creators</h2>
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
            </div>
          </div>
        ))}
        {data.creators.length === 0 && (
          <p className="text-sm text-white/40">No creators in this org yet.</p>
        )}
      </div>

      <h2 className="mt-8 text-lg font-bold">Seats</h2>
      <div className="mt-3 space-y-2">
        {data.members.map((m) => (
          <div
            key={m.id}
            className="flex items-center justify-between gap-3 rounded-2xl border border-white/10 bg-white/5 p-4"
          >
            <div className="min-w-0">
              <p className="font-bold">{m.displayName}</p>
              <p className="text-xs text-white/40">{m.email}</p>
            </div>
            <span className="rounded-full bg-white/10 px-3 py-1 text-xs font-semibold capitalize">
              {m.role}
            </span>
          </div>
        ))}
        {data.members.length === 0 && (
          <p className="text-sm text-white/40">No staff seats yet.</p>
        )}
      </div>
    </div>
  );
}
