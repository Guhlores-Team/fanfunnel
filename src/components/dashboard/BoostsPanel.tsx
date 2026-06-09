"use client";

import { useCallback, useEffect, useState } from "react";
import type { HappyHour, Webhook, WheelSummary, WishlistDemand } from "@/lib/data/types";
import { RARITY_COLORS } from "@/lib/games/wheel/types";
import { useToast } from "@/components/ui/Toast";

interface ReferralStats {
  referredCount: number;
  creditedCount: number;
  bonusAwarded: number;
}

/**
 * Engagement levers in one place: happy-hour scheduling, the public-leaderboard
 * toggle, aggregate wishlist demand, and referral stats. All read-light, demo-safe.
 */
export default function BoostsPanel({
  leaderboardEnabled,
  onLeaderboardChange,
}: {
  leaderboardEnabled: boolean;
  onLeaderboardChange?: () => void;
}) {
  return (
    <div className="space-y-8">
      <PublicProfileCard />
      <LeaderboardToggle enabled={leaderboardEnabled} onChange={onLeaderboardChange} />
      <HappyHourScheduler />
      <div className="grid gap-6 sm:grid-cols-2">
        <WishlistDemandCard />
        <ReferralStatsCard />
      </div>
      <WebhooksCard />
      <DangerZone />
    </div>
  );
}

/** Destructive account reset — wipes all wheels/fans/spins/campaigns. */
function DangerZone() {
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);

  async function reset() {
    setBusy(true);
    try {
      const res = await fetch("/api/account/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: typed }),
      });
      if (res.ok) {
        toast("Account reset — starting fresh.", { tone: "success" });
        setTimeout(() => window.location.reload(), 700);
      } else {
        toast("Couldn't reset. Are you signed in?", { tone: "error" });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border border-[#ef4444]/30 bg-[#ef4444]/5 p-4">
      <h3 className="font-bold text-ink">Danger zone</h3>
      <p className="mt-1 text-sm text-muted">
        Clear all data — wheels, prizes, fans, links, spins, grants, campaigns, and
        metrics — and start fresh. This <strong>cannot be undone</strong>.
      </p>
      {!confirming ? (
        <button
          onClick={() => setConfirming(true)}
          className="mt-3 rounded-lg border border-[#ef4444]/60 px-3 py-1.5 text-sm font-semibold text-[#ef4444] transition hover:bg-[#ef4444]/10"
        >
          Clear all data
        </button>
      ) : (
        <div className="mt-3 space-y-2">
          <p className="text-sm text-ink">
            Type <strong>RESET</strong> to confirm:
          </p>
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            className="ff-input w-full"
            placeholder="RESET"
          />
          <div className="flex gap-2">
            <button
              onClick={reset}
              disabled={busy || typed !== "RESET"}
              className="rounded-lg bg-[#ef4444] px-3 py-1.5 text-sm font-bold text-white transition hover:brightness-110 disabled:opacity-40"
            >
              {busy ? "Clearing…" : "Permanently clear everything"}
            </button>
            <button
              onClick={() => {
                setConfirming(false);
                setTyped("");
              }}
              className="rounded-lg border border-line px-3 py-1.5 text-sm font-semibold text-muted transition hover:text-ink"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function PublicProfileCard() {
  const [slug, setSlug] = useState("");
  const [tipUrl, setTipUrl] = useState("");
  const [tagline, setTagline] = useState("");
  const [note, setNote] = useState("");
  const [avatarUrl, setAvatarUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const toast = useToast();
  const origin = typeof window !== "undefined" ? window.location.origin : "";

  useEffect(() => {
    let live = true;
    fetch("/api/public-profile", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!live || !d) return;
        setSlug(d.slug ?? "");
        setTipUrl(d.tipUrl ?? "");
        setTagline(d.tagline ?? "");
        setNote(d.note ?? "");
        setAvatarUrl(d.avatarUrl ?? "");
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  const save = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/public-profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, tipUrl, tagline, note, avatarUrl }),
      });
      if (!res.ok) throw new Error();
      toast("Link-in-bio saved", { tone: "success" });
      // Reflect any server-side slug normalization.
      const fresh = await fetch("/api/public-profile", { cache: "no-store" }).then((r) => r.json());
      setSlug(fresh.slug ?? "");
    } catch {
      toast("Couldn't save — that slug may be taken.", { tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  const url = slug ? `${origin}/c/${slug}` : "";
  const copy = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked */
    }
  };

  return (
    <Section
      title="Link-in-bio (SFW)"
      hint="A clean, safe-for-work page you can post in your Instagram/TikTok bio. No explicit content — just your wheel + a way in."
    >
      <div className="space-y-3 rounded-xl border border-line p-4">
        <label className="block text-xs text-muted">
          Your public link
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="shrink-0 break-all text-sm text-muted">{origin}/c/</span>
            <input
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              className="ff-input min-w-0 flex-1"
              placeholder="your-name"
            />
          </div>
        </label>
        <label className="block text-xs text-muted">
          Tagline
          <input
            value={tagline}
            onChange={(e) => setTagline(e.target.value)}
            className="ff-input mt-1 w-full"
            placeholder="Spin my wheel — every spin wins 🎡"
          />
        </label>
        <label className="block text-xs text-muted">
          Tip / buy-spins link (where fans go to pay)
          <input
            value={tipUrl}
            onChange={(e) => setTipUrl(e.target.value)}
            className="ff-input mt-1 w-full"
            placeholder="https://onlyfans.com/you  or your tip link"
          />
        </label>
        <label className="block text-xs text-muted">
          Personal note to fans (shown atop their spin page)
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className="ff-input mt-1 w-full"
            placeholder="Hey you 😘 spin away — every spin wins!"
          />
        </label>
        <label className="block text-xs text-muted">
          Avatar (optional)
          <div className="mt-1 flex items-center gap-3">
            {avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={avatarUrl} alt="" className="h-12 w-12 shrink-0 rounded-full object-cover ring-1 ring-line" />
            ) : (
              <span className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-white/5 text-lg">📷</span>
            )}
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <input
                value={avatarUrl}
                onChange={(e) => setAvatarUrl(e.target.value)}
                className="ff-input w-full"
                placeholder="Paste an image URL, or upload →"
              />
              <AvatarUpload onUploaded={setAvatarUrl} />
            </div>
          </div>
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={save}
            disabled={busy}
            className="btn-brand rounded-lg px-4 py-2 text-sm font-bold disabled:opacity-50"
          >
            Save
          </button>
          {url && (
            <>
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-lg border border-line px-3 py-2 text-sm font-semibold text-ink transition hover:border-[var(--brand)]"
              >
                Preview ↗
              </a>
              <button
                onClick={copy}
                className="rounded-lg border border-line px-3 py-2 text-sm font-semibold text-ink transition hover:border-[var(--brand)]"
              >
                {copied ? "Copied!" : "Copy link"}
              </button>
            </>
          )}
        </div>
      </div>
    </Section>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="text-sm font-bold text-ink">{title}</h3>
      {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

/** A file picker that uploads an avatar to Storage and returns its public URL. */
function AvatarUpload({ onUploaded }: { onUploaded: (url: string) => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  async function pick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      toast("Please choose an image file.", { tone: "error" });
      return;
    }
    setBusy(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/account/avatar", { method: "POST", body: form });
      const d = await res.json().catch(() => ({}));
      if (res.ok && d.url) {
        onUploaded(d.url);
        toast("Photo uploaded — Save to apply.", { tone: "success" });
      } else {
        toast(
          d.error === "too_large"
            ? "Image too large (max 5 MB)."
            : d.error === "demo_mode"
              ? "Upload needs Supabase configured (demo mode)."
              : "Upload failed.",
          { tone: "error" }
        );
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <label className="inline-flex w-fit cursor-pointer items-center rounded-lg border border-line px-3 py-1.5 text-xs font-semibold text-ink transition hover:bg-white/5">
      {busy ? "Uploading…" : "⬆ Upload photo"}
      <input type="file" accept="image/*" onChange={pick} disabled={busy} className="hidden" />
    </label>
  );
}

function LeaderboardToggle({ enabled, onChange }: { enabled: boolean; onChange?: () => void }) {
  const [on, setOn] = useState(enabled);
  const [busy, setBusy] = useState(false);
  const [slug, setSlug] = useState<string | null>(null);
  const toast = useToast();
  const origin = typeof window !== "undefined" ? window.location.origin : "";

  // eslint-disable-next-line react-hooks/set-state-in-effect -- mirror the persisted flag when the overview refreshes
  useEffect(() => setOn(enabled), [enabled]);

  useEffect(() => {
    let live = true;
    fetch("/api/public-profile", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => live && d && setSlug(d.slug ?? null))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  const toggle = async () => {
    const next = !on;
    setOn(next);
    setBusy(true);
    try {
      const res = await fetch("/api/leaderboard/enable", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      if (!res.ok) throw new Error();
      toast(next ? "Leaderboard is now public" : "Leaderboard hidden");
      onChange?.();
    } catch {
      setOn(!next);
      toast("Couldn't update leaderboard");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      title="Public leaderboard"
      hint="Rank opted-in fans by spins, spend, and rare wins. Drives competitive tipping."
    >
      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={toggle}
          disabled={busy}
          className="flex items-center gap-3 rounded-xl border border-line px-4 py-3 transition hover:border-[var(--brand)]/50"
          aria-pressed={on}
        >
          <span
            className={`relative h-6 w-11 rounded-full transition ${on ? "bg-[var(--brand)]" : "bg-line"}`}
          >
            <span
              className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${on ? "left-[1.375rem]" : "left-0.5"}`}
            />
          </span>
          <span className="text-sm font-semibold text-ink">{on ? "On" : "Off"}</span>
        </button>
        {on && slug && (
          <div className="flex items-center gap-2">
            <a
              href={`/leaderboard/${slug}`}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-lg border border-line px-3 py-2 text-sm font-semibold text-ink transition hover:border-[var(--brand)]"
            >
              View ↗
            </a>
            <button
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(`${origin}/leaderboard/${slug}`);
                  toast("Leaderboard link copied", { tone: "success" });
                } catch {
                  /* clipboard blocked */
                }
              }}
              className="rounded-lg border border-line px-3 py-2 text-sm font-semibold text-ink transition hover:border-[var(--brand)]"
            >
              Copy link
            </button>
          </div>
        )}
      </div>
      {on && !slug && (
        <p className="mt-2 text-xs text-muted">
          Set your public link in “Link-in-bio (SFW)” above to get a shareable
          leaderboard URL.
        </p>
      )}
    </Section>
  );
}

function HappyHourScheduler() {
  const [wheels, setWheels] = useState<WheelSummary[]>([]);
  const [windows, setWindows] = useState<HappyHour[]>([]);
  const [wheelId, setWheelId] = useState("");
  const [multiplier, setMultiplier] = useState(2);
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const load = useCallback(async () => {
    const [w, h] = await Promise.all([
      fetch("/api/wheels", { cache: "no-store" }).then((r) => (r.ok ? r.json() : { wheels: [] })),
      fetch("/api/happy-hours", { cache: "no-store" }).then((r) => (r.ok ? r.json() : { happyHours: [] })),
    ]);
    setWheels(w.wheels ?? []);
    setWindows(h.happyHours ?? []);
    if (!wheelId && w.wheels?.[0]) setWheelId(w.wheels[0].id);
  }, [wheelId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount
    load();
  }, [load]);

  const create = async () => {
    if (!wheelId || !startsAt || !endsAt) {
      toast("Pick a wheel and a start/end time");
      return;
    }
    // Guard partial datetime-local values: .toISOString() on an Invalid Date
    // throws RangeError, which would surface as a misleading generic error.
    const startDate = new Date(startsAt);
    const endDate = new Date(endsAt);
    if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
      toast("Enter a complete start and end time");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/happy-hours", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          wheelId,
          multiplier,
          startsAt: startDate.toISOString(),
          endsAt: endDate.toISOString(),
        }),
      });
      if (!res.ok) throw new Error();
      setStartsAt("");
      setEndsAt("");
      toast("Happy hour scheduled");
      await load();
    } catch {
      toast("Couldn't schedule — check the window");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setWindows((w) => w.filter((x) => x.id !== id));
    await fetch(`/api/happy-hours/${id}`, { method: "DELETE" });
    load();
  };

  const wheelName = (id: string) => wheels.find((w) => w.id === id)?.title ?? "Wheel";

  return (
    <Section title="Happy hour" hint="Boost rare odds for a time-boxed window. Fans see a live banner.">
      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-line p-4">
        <label className="flex flex-col gap-1 text-xs text-muted">
          Wheel
          <select
            value={wheelId}
            onChange={(e) => setWheelId(e.target.value)}
            className="rounded-lg border border-line bg-base px-3 py-2 text-sm text-ink"
          >
            {wheels.map((w) => (
              <option key={w.id} value={w.id}>
                {w.title}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted">
          Boost ×
          <input
            type="number"
            min={1}
            max={10}
            step={0.5}
            value={multiplier}
            onChange={(e) => setMultiplier(Number(e.target.value))}
            className="w-20 rounded-lg border border-line bg-base px-3 py-2 text-sm text-ink"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted">
          Starts
          <input
            type="datetime-local"
            value={startsAt}
            onChange={(e) => setStartsAt(e.target.value)}
            className="rounded-lg border border-line bg-base px-3 py-2 text-sm text-ink"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted">
          Ends
          <input
            type="datetime-local"
            value={endsAt}
            onChange={(e) => setEndsAt(e.target.value)}
            className="rounded-lg border border-line bg-base px-3 py-2 text-sm text-ink"
          />
        </label>
        <button
          onClick={create}
          disabled={busy}
          className="btn-brand rounded-lg px-4 py-2 text-sm font-bold disabled:opacity-50"
        >
          Schedule
        </button>
      </div>

      {windows.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {windows.map((w) => (
            <li
              key={w.id}
              className="flex items-center gap-3 rounded-lg border border-line px-3 py-2 text-sm"
            >
              <span className="font-semibold text-[var(--brand)]">×{w.multiplier}</span>
              <span className="text-ink">{wheelName(w.wheelId)}</span>
              <span className="text-xs text-muted">
                {new Date(w.startsAt).toLocaleString()} → {new Date(w.endsAt).toLocaleString()}
              </span>
              <button
                onClick={() => remove(w.id)}
                className="ml-auto text-xs text-muted transition hover:text-ink"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function WishlistDemandCard() {
  const [demand, setDemand] = useState<WishlistDemand[]>([]);

  useEffect(() => {
    let live = true;
    fetch("/api/wishlist-demand", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { demand: [] }))
      .then((d) => live && setDemand(d.demand ?? []))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  return (
    <Section title="Wishlist demand" hint="What fans are chasing most.">
      {demand.length === 0 ? (
        <p className="text-sm text-muted">No wishlist activity yet.</p>
      ) : (
        <ul className="space-y-1.5">
          {demand.map((d) => {
            const c = RARITY_COLORS[d.rarity];
            return (
              <li key={d.prizeLabel} className="flex items-center gap-3 text-sm">
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ background: c }}
                />
                <span className="flex-1 truncate text-ink">{d.prizeLabel}</span>
                <span className="tnum font-bold text-ink">{d.count}</span>
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

function ReferralStatsCard() {
  const [stats, setStats] = useState<ReferralStats | null>(null);

  useEffect(() => {
    let live = true;
    fetch("/api/referrals/stats", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => live && d && setStats(d))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  return (
    <Section title="Referrals" hint="Fans bringing in new fans.">
      <div className="grid grid-cols-3 gap-2">
        <Stat label="Referred" value={stats?.referredCount ?? 0} />
        <Stat label="Credited" value={stats?.creditedCount ?? 0} />
        <Stat label="Bonus spins" value={stats?.bonusAwarded ?? 0} />
      </div>
    </Section>
  );
}

function WebhooksCard() {
  const [hooks, setHooks] = useState<Webhook[]>([]);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  useEffect(() => {
    let live = true;
    fetch("/api/webhooks", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { webhooks: [] }))
      .then((d) => live && setHooks(d.webhooks ?? []))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  const add = async () => {
    const value = url.trim();
    if (!/^https?:\/\//i.test(value)) {
      toast("Enter a URL starting with http(s)://");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/webhooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: value }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.webhook) throw new Error();
      setHooks((h) => [data.webhook, ...h]);
      setUrl("");
      toast("Webhook added");
    } catch {
      toast("Couldn't add webhook");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setHooks((h) => h.filter((x) => x.id !== id));
    await fetch(`/api/webhooks/${id}`, { method: "DELETE" }).catch(() => {});
  };

  return (
    <Section
      title="Webhooks (advanced — optional)"
      hint="Automatically ping another app the moment a fan wins. FanFunnel sends the win's details to a web address you choose, so you can connect it to tools like Zapier, Make, Discord, or Slack (e.g. auto-log wins to a spreadsheet or get a chat notification). Most creators can skip this."
    >
      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-line p-4">
        <label className="flex flex-1 flex-col gap-1 text-xs text-muted">
          Endpoint URL
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com/hooks/fanfunnel"
            className="rounded-lg border border-line bg-base px-3 py-2 text-sm text-ink"
          />
        </label>
        <button
          onClick={add}
          disabled={busy}
          className="btn-brand rounded-lg px-4 py-2 text-sm font-bold disabled:opacity-50"
        >
          Add
        </button>
      </div>

      {hooks.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {hooks.map((h) => (
            <li
              key={h.id}
              className="flex items-center gap-3 rounded-lg border border-line px-3 py-2 text-sm"
            >
              <span className="rounded-full bg-surface px-2 py-0.5 text-[11px] font-semibold text-muted">
                {h.event}
              </span>
              <span className="flex-1 truncate font-mono text-xs text-ink">
                {h.url}
              </span>
              <button
                onClick={() => remove(h.id)}
                className="ml-auto text-xs text-muted transition hover:text-ink"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-line px-3 py-2.5 text-center">
      <p className="tnum text-xl font-extrabold text-ink">{value}</p>
      <p className="text-[11px] text-muted">{label}</p>
    </div>
  );
}
