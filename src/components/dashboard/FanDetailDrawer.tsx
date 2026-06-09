"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { RARITY_COLORS, type Rarity } from "@/lib/games/wheel/types";
import type { FanDetail, Grant } from "@/lib/data/types";
import { formatCents } from "@/lib/format";
import { TagEditor } from "./ui";
import { useToast } from "@/components/ui/Toast";

const RARITY_LABEL: Record<Rarity, string> = {
  common: "Common",
  uncommon: "Uncommon",
  rare: "Rare",
  epic: "Epic",
  legendary: "Legendary",
};

/** Compact relative time, e.g. "just now", "2h ago", "3d ago". */
function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const secs = Math.round((Date.now() - then) / 1000);
  if (secs < 45) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.round(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.round(days / 365)}y ago`;
}

export default function FanDetailDrawer({
  fanId,
  onClose,
  onSaved,
}: {
  fanId: string | null;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const [detail, setDetail] = useState<FanDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [notes, setNotes] = useState("");
  const [savingNotes, setSavingNotes] = useState(false);
  const [savingTags, setSavingTags] = useState(false);
  const [blocking, setBlocking] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const toast = useToast();

  const [campaigns, setCampaigns] = useState<{ id: string; name: string }[]>([]);

  // Refetch the open fan's detail (after an inline grant edit, etc.).
  const reload = useCallback(async () => {
    if (!fanId) return;
    const res = await fetch(`/api/fans/${fanId}`, { cache: "no-store" });
    if (res.ok) setDetail(await res.json());
  }, [fanId]);

  // Fetch the fan detail whenever the open fan changes.
  useEffect(() => {
    if (!fanId) return;
    let active = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset + refetch when the open fan (`fanId`) changes
    setLoading(true);
    setDetail(null);
    setNotFound(false);
    setNotes("");
    (async () => {
      try {
        const [res, cRes] = await Promise.all([
          fetch(`/api/fans/${fanId}`, { cache: "no-store" }),
          fetch(`/api/campaigns`, { cache: "no-store" }),
        ]);
        if (!active) return;
        if (res.ok) {
          const data: FanDetail = await res.json();
          setDetail(data);
          setNotes(data.notes ?? "");
        } else setNotFound(true);
        if (cRes.ok) {
          const cd = await cRes.json();
          setCampaigns((cd.campaigns ?? []).map((c: { id: string; name: string }) => ({ id: c.id, name: c.name })));
        }
      } catch {
        if (active) setNotFound(true);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [fanId]);

  // Persist a metadata patch (notes and/or tags) for the open fan.
  async function patchMeta(
    patch: { notes?: string | null; tags?: string[] }
  ): Promise<boolean> {
    if (!fanId) return false;
    const res = await fetch(`/api/fans/${fanId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    return res.ok;
  }

  // Save notes on blur, but only when they've actually changed.
  async function saveNotes() {
    if (!detail) return;
    const next = notes.trim() ? notes : null;
    if ((detail.notes ?? null) === (next ?? null)) return;
    setSavingNotes(true);
    try {
      if (await patchMeta({ notes: next })) {
        setDetail((d) => (d ? { ...d, notes: next } : d));
        toast("Notes saved", { tone: "success" });
        onSaved?.();
      } else {
        toast("Couldn't save notes.", { tone: "error" });
      }
    } finally {
      setSavingNotes(false);
    }
  }

  async function saveTags(tags: string[]) {
    if (!detail) return;
    setSavingTags(true);
    try {
      if (await patchMeta({ tags })) {
        setDetail((d) => (d ? { ...d, tags } : d));
        onSaved?.();
      } else {
        toast("Couldn't save tags.", { tone: "error" });
      }
    } finally {
      setSavingTags(false);
    }
  }

  async function toggleBlock() {
    if (!fanId) return;
    const next = !blocked;
    setBlocking(true);
    try {
      const res = await fetch(`/api/fans/${fanId}/block`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ blocked: next }),
      });
      if (res.ok) {
        setBlocked(next);
        toast(next ? "Fan blocked — their link is disabled." : "Fan unblocked.", {
          tone: "success",
        });
        onSaved?.();
      } else {
        toast("Couldn't update block status.", { tone: "error" });
      }
    } finally {
      setBlocking(false);
    }
  }

  // Escape-to-close + basic focus management (move in on open, restore on close).
  useEffect(() => {
    if (!fanId) return;
    restoreRef.current = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      restoreRef.current?.focus?.();
    };
  }, [fanId, onClose]);

  if (!fanId) return null;

  const totalWins = detail?.winsByRarity.reduce((sum, w) => sum + w.count, 0) ?? 0;
  const stats: { label: string; value: string }[] = [
    { label: "Spins left", value: String(detail?.spinsRemaining ?? 0) },
    { label: "Granted", value: String(detail?.grantedTotal ?? 0) },
    { label: "Total spins", value: String(detail?.totalSpins ?? 0) },
    { label: "Total spent", value: formatCents(detail?.totalSpent ?? 0) },
    {
      label: "Last active",
      value: detail?.lastActive ? timeAgo(detail.lastActive) : "—",
    },
  ];

  return (
    <div className="fixed inset-0 z-50">
      <div
        className="absolute inset-0 bg-black/60 transition-opacity"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Fan details"
        tabIndex={-1}
        className="absolute inset-x-0 bottom-0 flex max-h-[85dvh] flex-col overflow-y-auto rounded-t-2xl border border-line bg-surface shadow-2xl transition-transform sm:inset-x-auto sm:right-0 sm:top-0 sm:h-full sm:max-h-none sm:w-full sm:max-w-md sm:rounded-none sm:rounded-l-2xl sm:border-l"
      >
        <div className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-line bg-surface px-5 py-4">
          <div className="min-w-0">
            {loading || !detail ? (
              <div className="skeleton h-6 w-40 rounded" />
            ) : (
              <h2 className="truncate text-lg font-bold text-ink">{detail.name}</h2>
            )}
            <p className="mt-0.5 text-xs text-muted">Fan details</p>
          </div>
          <button
            ref={closeRef}
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 rounded-lg border border-line px-2.5 py-1.5 text-sm font-semibold text-muted transition hover:text-ink"
          >
            ✕
          </button>
        </div>

        <div className="px-5 py-5">
          {notFound ? (
            <p className="text-sm text-muted">Fan not found.</p>
          ) : (
            <div className="space-y-6">
              {/* Stat grid */}
              <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-line">
                {stats.map((s) => (
                  <div key={s.label} className="bg-base px-4 py-3">
                    <dd className="tnum text-xl font-bold text-ink">
                      {loading || !detail ? (
                        <span className="skeleton inline-block h-5 w-10 rounded align-middle" />
                      ) : (
                        s.value
                      )}
                    </dd>
                    <dt className="mt-0.5 text-xs font-medium uppercase tracking-wide text-muted">
                      {s.label}
                    </dt>
                  </div>
                ))}
              </dl>

              {/* Tags */}
              <section>
                <h3 className="text-sm font-semibold text-ink">Tags</h3>
                {loading || !detail ? (
                  <div className="skeleton mt-3 h-8 w-full rounded" />
                ) : (
                  <div className="mt-3">
                    <TagEditor
                      tags={detail.tags}
                      onChange={saveTags}
                      disabled={savingTags}
                    />
                  </div>
                )}
              </section>

              {/* Notes */}
              <section>
                <h3 className="text-sm font-semibold text-ink">Notes</h3>
                {loading || !detail ? (
                  <div className="skeleton mt-3 h-20 w-full rounded" />
                ) : (
                  <>
                    <textarea
                      className="ff-input mt-3 w-full"
                      rows={3}
                      placeholder="Private notes about this fan…"
                      value={notes}
                      disabled={savingNotes}
                      onChange={(e) => setNotes(e.target.value)}
                      onBlur={saveNotes}
                      aria-label="Fan notes"
                    />
                    <p className="mt-1 text-[11px] text-muted">
                      {savingNotes ? "Saving…" : "Saved when you click away."}
                    </p>
                  </>
                )}
              </section>

              {/* Wins by rarity */}
              <section>
                <h3 className="text-sm font-semibold text-ink">Wins by rarity</h3>
                {loading || !detail ? (
                  <div className="skeleton mt-3 h-3 w-full rounded" />
                ) : totalWins === 0 ? (
                  <p className="mt-2 text-sm text-muted">No wins yet.</p>
                ) : (
                  <>
                    <div className="mt-3 flex h-3 overflow-hidden rounded-full">
                      {detail.winsByRarity
                        .filter((w) => w.count > 0)
                        .map((w) => (
                          <div
                            key={w.rarity}
                            style={{
                              width: `${(w.count / totalWins) * 100}%`,
                              backgroundColor: RARITY_COLORS[w.rarity],
                            }}
                            title={`${RARITY_LABEL[w.rarity]}: ${w.count}`}
                          />
                        ))}
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-2">
                      {detail.winsByRarity
                        .filter((w) => w.count > 0)
                        .map((w) => (
                          <div key={w.rarity} className="flex items-center gap-2 text-sm">
                            <span
                              className="h-2.5 w-2.5 shrink-0 rounded-full"
                              style={{ backgroundColor: RARITY_COLORS[w.rarity] }}
                            />
                            <span className="text-muted">{RARITY_LABEL[w.rarity]}</span>
                            <span className="tnum ml-auto font-semibold text-ink">
                              {w.count}
                            </span>
                          </div>
                        ))}
                    </div>
                  </>
                )}
              </section>

              {/* By campaign */}
              <section>
                <h3 className="text-sm font-semibold text-ink">By campaign</h3>
                {loading || !detail ? (
                  <div className="skeleton mt-3 h-10 w-full rounded" />
                ) : detail.byCampaign.length === 0 ? (
                  <p className="mt-2 text-sm text-muted">No campaign activity yet.</p>
                ) : (
                  <ul className="mt-3 space-y-2">
                    {detail.byCampaign.map((c) => (
                      <li
                        key={c.campaignId}
                        className="rounded-lg border border-line bg-base/40 px-3 py-2.5"
                      >
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="min-w-0 truncate text-sm font-semibold text-ink">
                            {c.name}
                          </span>
                          <span className="tnum shrink-0 text-xs font-semibold text-ink">
                            {formatCents(c.spentCents)}
                          </span>
                        </div>
                        <p className="tnum mt-0.5 text-xs text-muted">
                          {c.spinsBought} bought · {c.spinsPlayed} played
                        </p>
                        {c.prizes.length > 0 && (
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {c.prizes.map((p, i) => (
                              <span
                                key={`${p.label}-${i}`}
                                className="inline-flex items-center gap-1.5 rounded-full border border-line px-2 py-0.5 text-xs text-ink"
                              >
                                <span
                                  className="h-2 w-2 shrink-0 rounded-full"
                                  style={{ backgroundColor: RARITY_COLORS[p.rarity] }}
                                />
                                <span className="truncate">{p.label}</span>
                                <span className="tnum text-muted">×{p.count}</span>
                              </span>
                            ))}
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {/* Grant history */}
              <section>
                <h3 className="text-sm font-semibold text-ink">Grant history</h3>
                {loading || !detail ? (
                  <div className="skeleton mt-3 h-10 w-full rounded" />
                ) : detail.grants.length === 0 ? (
                  <p className="mt-2 text-sm text-muted">No grants yet.</p>
                ) : (
                  <ul className="mt-3 space-y-2">
                    {detail.grants.map((g) => (
                      <GrantRow key={g.id} g={g} campaigns={campaigns} onSaved={reload} />
                    ))}
                  </ul>
                )}
              </section>

              {/* Pending prizes */}
              <section>
                <h3 className="text-sm font-semibold text-ink">Pending prizes</h3>
                {loading || !detail ? (
                  <div className="skeleton mt-3 h-10 w-full rounded" />
                ) : detail.pendingPrizes.length === 0 ? (
                  <p className="mt-2 text-sm text-muted">None pending</p>
                ) : (
                  <ul className="mt-3 space-y-2">
                    {detail.pendingPrizes.map((p, i) => (
                      <li
                        key={`${p.label}-${p.at}-${i}`}
                        className="flex items-center gap-3 rounded-lg border border-line bg-base/40 px-3 py-2"
                      >
                        <span
                          className="h-2.5 w-2.5 shrink-0 rounded-full"
                          style={{ backgroundColor: RARITY_COLORS[p.rarity] }}
                        />
                        <span className="min-w-0 flex-1 truncate text-sm text-ink">
                          {p.emoji ? `${p.emoji} ` : ""}
                          {p.label}
                        </span>
                        <span className="tnum shrink-0 text-xs text-muted">
                          {timeAgo(p.at)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {/* Links */}
              <section>
                <h3 className="text-sm font-semibold text-ink">Links</h3>
                {loading || !detail ? (
                  <div className="skeleton mt-3 h-10 w-full rounded" />
                ) : detail.links.length === 0 ? (
                  <p className="mt-2 text-sm text-muted">No links yet.</p>
                ) : (
                  <ul className="mt-3 space-y-2">
                    {detail.links.map((l) => (
                      <LinkRow key={l.token} token={l.token} />
                    ))}
                  </ul>
                )}
              </section>

              {/* Safety: block this fan (disables all their links). */}
              <section className="border-t border-line pt-4">
                <h3 className="text-sm font-semibold text-ink">Safety</h3>
                <p className="mt-1 text-xs text-muted">
                  Blocking disables every link this fan has — they can&rsquo;t spin or
                  message until you unblock them.
                </p>
                <button
                  type="button"
                  onClick={toggleBlock}
                  disabled={blocking}
                  className={`mt-3 rounded-lg border px-3 py-1.5 text-xs font-semibold transition disabled:opacity-50 ${
                    blocked
                      ? "border-line text-muted hover:text-ink"
                      : "border-[#ef4444] text-[#ef4444] hover:bg-[#ef4444]/10"
                  }`}
                >
                  {blocking
                    ? "…"
                    : blocked
                      ? "Unblock fan"
                      : "🚫 Block fan"}
                </button>
              </section>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function LinkRow({ token }: { token: string }) {
  const [copied, setCopied] = useState(false);
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const url = `${origin}/spin/${token}`;
  return (
    <li className="flex items-center justify-between gap-2 rounded-lg border border-line bg-base/40 p-2.5">
      <p className="min-w-0 flex-1 truncate text-xs text-muted">{url}</p>
      <button
        onClick={() => {
          navigator.clipboard?.writeText(url);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
        className="shrink-0 rounded-lg border border-line px-3 py-1.5 text-xs font-semibold text-ink transition hover:bg-white/5"
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </li>
  );
}

/** A grant history row that expands into an inline editor (spins / $ / campaign).
 *  Editing spins adjusts the fan's balance server-side; we refetch on save. */
function GrantRow({
  g,
  campaigns,
  onSaved,
}: {
  g: Grant;
  campaigns: { id: string; name: string }[];
  onSaved: () => void | Promise<void>;
}) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [spins, setSpins] = useState(String(g.spins));
  const [perSpin, setPerSpin] = useState(
    g.spins > 0 && g.amountCents > 0 ? (g.amountCents / 100 / g.spins).toFixed(2) : ""
  );
  const [campaignId, setCampaignId] = useState(g.campaignId ?? "");
  const [busy, setBusy] = useState(false);

  // Re-sync the form when the underlying grant changes (e.g. the drawer reloads
  // after another action), unless the user is actively editing this row.
  useEffect(() => {
    if (editing) return;
    /* eslint-disable react-hooks/set-state-in-effect -- mirror persisted grant into the idle form */
    setSpins(String(g.spins));
    setPerSpin(g.spins > 0 && g.amountCents > 0 ? (g.amountCents / 100 / g.spins).toFixed(2) : "");
    setCampaignId(g.campaignId ?? "");
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [g.spins, g.amountCents, g.campaignId, editing]);

  async function save() {
    setBusy(true);
    try {
      const nSpins = Math.max(0, Math.floor(Number(spins) || 0));
      const amountCents = perSpin ? Math.round(Number(perSpin) * nSpins * 100) : 0;
      const res = await fetch(`/api/grants/${g.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ spins: nSpins, amountCents, campaignId: campaignId || null }),
      });
      if (res.ok) {
        toast("Grant updated", { tone: "success" });
        setEditing(false);
        await onSaved();
      } else {
        toast("Couldn't update grant.", { tone: "error" });
      }
    } finally {
      setBusy(false);
    }
  }

  if (!editing) {
    return (
      <li className="flex items-center gap-3 rounded-lg border border-line bg-base/40 px-3 py-2">
        <span className="tnum shrink-0 text-sm font-semibold text-ink">+{g.spins}</span>
        <span className="min-w-0 flex-1 truncate text-sm text-muted">
          <span className="tnum font-semibold text-ink">{formatCents(g.amountCents)}</span> ·{" "}
          {g.campaignName ?? "No campaign"}
        </span>
        <button
          onClick={() => setEditing(true)}
          className="shrink-0 rounded-md border border-line px-2 py-1 text-xs font-semibold text-muted transition hover:text-ink"
        >
          Edit
        </button>
      </li>
    );
  }

  return (
    <li className="space-y-2 rounded-lg border border-[var(--brand)]/40 bg-base/40 px-3 py-3">
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-0.5 text-[11px] text-muted">
          Spins
          <input
            type="number"
            min={0}
            value={spins}
            onChange={(e) => setSpins(e.target.value)}
            className="ff-input tnum w-20"
          />
        </label>
        <label className="flex flex-col gap-0.5 text-[11px] text-muted">
          $ / spin
          <input
            type="number"
            min={0}
            step={0.01}
            value={perSpin}
            onChange={(e) => setPerSpin(e.target.value)}
            placeholder="0.00"
            className="ff-input tnum w-24"
          />
        </label>
        <label className="flex min-w-0 flex-1 flex-col gap-0.5 text-[11px] text-muted">
          Campaign
          <select
            value={campaignId}
            onChange={(e) => setCampaignId(e.target.value)}
            className="ff-input w-full"
          >
            <option value="">No campaign (untracked)</option>
            {campaigns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="flex gap-2">
        <button
          onClick={save}
          disabled={busy}
          className="btn-brand rounded-lg px-3 py-1.5 text-xs font-bold disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save"}
        </button>
        <button
          onClick={() => setEditing(false)}
          className="rounded-lg border border-line px-3 py-1.5 text-xs font-semibold text-muted transition hover:text-ink"
        >
          Cancel
        </button>
      </div>
    </li>
  );
}
