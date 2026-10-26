"use client";

import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useRouter } from "next/navigation";
import type { HappyHour, Webhook, WheelSummary, WishlistDemand } from "@/lib/data/types";
import { RARITY_COLORS } from "@/lib/games/wheel/types";
import { useToast } from "@/components/ui/Toast";
import { copyToClipboard } from "@/lib/hooks/useClipboard";
import { useOrigin } from "@/lib/hooks/useOrigin";
import { demandPct, formatWindow, happyHourStatus, type HappyHourStatus } from "./boostsHelpers";

interface ReferralStats {
  referredCount: number;
  creditedCount: number;
  bonusAwarded: number;
}

/** The creator's SFW link-in-bio settings (read here, edited under Settings). */
interface PublicProfile {
  slug: string | null;
  tipUrl: string | null;
  tagline: string | null;
}

// 24×24 stroke paths (Command Center prototype line icons).
const P = {
  link: "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71",
  trophy: "M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4ZM7 6H4a2 2 0 0 0 0 4h3M17 6h3a2 2 0 0 1 0 4h-3",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7v5l3 2",
  heart: "M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8Z",
  fans: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM22 21v-2a4 4 0 0 0-3-3.87",
  bolt: "M13 2 4 14h7l-2 8 9-12h-7l2-8Z",
  warn: "M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z",
  copy: "M8 8h12v12H8zM16 8V4H4v12h4",
  external: "M14 4h6v6M20 4l-9 9M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5",
  x: "M18 6 6 18M6 6l12 12",
};

function Glyph({ d, size = 18, className = "" }: { d: string; size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={`shrink-0 ${className}`}
    >
      <path d={d} />
    </svg>
  );
}

const raised = "border border-[var(--hair)] [background:var(--s1)] shadow-[var(--lift)]";
const recessed = "border border-[var(--hair)] [background:var(--s2)]";
const primaryBtn =
  "btn-brand inline-flex min-h-9 items-center justify-center gap-1.5 rounded-[9px] px-[15px] text-[13px] font-bold disabled:opacity-50";
const secondaryBtn =
  "inline-flex min-h-9 items-center justify-center gap-1.5 rounded-[9px] border border-line px-3.5 text-[12.5px] font-semibold text-ink transition-colors hover:border-[var(--brand)]/60 hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-50";
const fieldLabel = "flex min-w-0 flex-col gap-1.5 text-[10.5px] font-semibold uppercase tracking-[0.05em] text-muted";

/**
 * Raised Command Center card. The `<section aria-labelledby>` makes each card a
 * named landmark region so tests can scope to it (`getByRole("region", …)`).
 */
function Card({
  id,
  icon,
  title,
  hint,
  aside,
  tone = "default",
  children,
}: {
  id: string;
  icon: string;
  title: string;
  hint?: ReactNode;
  aside?: ReactNode;
  tone?: "default" | "danger";
  children: ReactNode;
}) {
  const shell =
    tone === "danger"
      ? "border border-[color-mix(in_oklab,#ef4444_28%,var(--hair))] [background:color-mix(in_oklab,#ef4444_5%,#16131c)]"
      : raised;
  return (
    <section aria-labelledby={id} className={`lift-in min-w-0 rounded-2xl px-4 py-4 sm:px-5 sm:py-[18px] ${shell}`}>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h3 id={id} className="flex items-center gap-[9px] text-[15px] font-bold tracking-[-0.01em] text-ink">
            <span aria-hidden="true" className="h-4 w-[3px] shrink-0 rounded-sm bg-[var(--brand)]" />
            <span className={tone === "danger" ? "text-[#fca5a5]" : "text-brand"}>
              <Glyph d={icon} size={16} />
            </span>
            {title}
          </h3>
          {hint && <p className="mt-1 text-[13px] text-muted text-pretty">{hint}</p>}
        </div>
        {aside && <div className="flex shrink-0 items-center gap-2">{aside}</div>}
      </div>
      <div className="mt-3.5">{children}</div>
    </section>
  );
}

/**
 * Engagement levers in one place: link-in-bio (read-only, edited in Settings),
 * the public-leaderboard toggle, happy-hour scheduling, aggregate wishlist
 * demand, referral stats, webhooks and the account reset. All read-light,
 * demo-safe.
 */
export default function BoostsPanel({
  leaderboardEnabled,
  onLeaderboardChange,
  onNavigate,
}: {
  leaderboardEnabled: boolean;
  onLeaderboardChange?: () => void;
  /** Dashboard section router ("settings" → Settings › Public page). */
  onNavigate?: (tab: string) => void;
}) {
  const [profile, setProfile] = useState<PublicProfile | null>(null);

  // One fetch shared by the link-in-bio card and the leaderboard links.
  useEffect(() => {
    let live = true;
    fetch("/api/public-profile", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!live) return;
        setProfile(
          d
            ? { slug: d.slug ?? null, tipUrl: d.tipUrl ?? null, tagline: d.tagline ?? null }
            : { slug: null, tipUrl: null, tagline: null },
        );
      })
      .catch(() => live && setProfile({ slug: null, tipUrl: null, tagline: null }));
    return () => {
      live = false;
    };
  }, []);

  return (
    <div className="flex max-w-[880px] flex-col gap-[18px]">
      <LinkInBioCard profile={profile} onNavigate={onNavigate} />
      <LeaderboardToggle enabled={leaderboardEnabled} onChange={onLeaderboardChange} slug={profile?.slug ?? null} />
      <HappyHourScheduler />
      <div className="grid gap-[18px] sm:grid-cols-2">
        <WishlistDemandCard />
        <ReferralStatsCard />
      </div>
      <WebhooksCard />
      <DangerZone />
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* Link-in-bio (read-only; the form lives under Settings › Public page)      */
/* ------------------------------------------------------------------------ */

function LinkInBioCard({
  profile,
  onNavigate,
}: {
  profile: PublicProfile | null;
  onNavigate?: (tab: string) => void;
}) {
  const toast = useToast();
  const origin = useOrigin();
  const slug = profile?.slug?.trim() || "";
  const tipUrl = profile?.tipUrl?.trim() || "";
  const tagline = profile?.tagline?.trim() || "";
  const url = slug ? `${origin}/c/${slug}` : "";

  const copy = async (text: string, what: string) => {
    if (await copyToClipboard(text)) toast(`${what} copied`, { tone: "success" });
    else toast("Couldn't copy.", { tone: "error" });
  };

  return (
    <Card
      id="boosts-link-in-bio"
      icon={P.link}
      title="Link-in-bio (SFW)"
      hint="A clean, safe-for-work page for your IG/TikTok bio — your wheel and a way in."
      aside={
        url ? (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs font-semibold text-brand hover:underline"
          >
            Preview page <Glyph d={P.external} size={13} />
          </a>
        ) : undefined
      }
    >
      {profile === null ? (
        <div className="flex flex-col gap-2.5" aria-busy="true" aria-label="Loading your public page">
          <div className="skeleton h-12 rounded-xl" />
          <div className="skeleton h-12 rounded-xl" />
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <Field label="Your public link">
            {url ? (
              <div className={`flex items-center gap-2 rounded-[11px] px-3 py-2 ${recessed}`}>
                <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-ink">{url}</span>
                <button type="button" onClick={() => copy(url, "Public link")} className={`${secondaryBtn} min-h-8 px-3`}>
                  <Glyph d={P.copy} size={13} />
                  Copy
                </button>
              </div>
            ) : (
              <Unset>No public link yet — choose a handle under Settings.</Unset>
            )}
          </Field>

          <Field label="Tip / buy-spins link" note="where fans go to pay">
            {tipUrl ? (
              <div className={`flex items-center gap-2 rounded-[11px] px-3 py-2 ${recessed}`}>
                <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-ink">{tipUrl}</span>
                <button type="button" onClick={() => copy(tipUrl, "Tip link")} className={`${secondaryBtn} min-h-8 px-3`}>
                  <Glyph d={P.copy} size={13} />
                  Copy tip link
                </button>
              </div>
            ) : (
              <Unset>Not set.</Unset>
            )}
          </Field>

          <Field label="Tagline" note="the line shown on your public spin page">
            {tagline ? (
              <p className={`rounded-[11px] px-3 py-2.5 text-[13.5px] text-ink ${recessed}`}>{tagline}</p>
            ) : (
              <Unset>Not set.</Unset>
            )}
          </Field>

          {onNavigate && (
            <div className="flex flex-wrap items-center gap-3 pt-0.5">
              <button type="button" onClick={() => onNavigate("settings")} className={secondaryBtn}>
                Edit in Settings
              </button>
              <span className="text-xs text-[#8b8494]">Handle, tagline, tip link and note live under Settings › Public page.</span>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function Field({ label, note, children }: { label: string; note?: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-[10.5px] font-semibold uppercase tracking-[0.05em] text-muted">
        {label}
        {note && <span className="ml-1.5 font-medium normal-case tracking-normal text-[#8b8494]">— {note}</span>}
      </p>
      <div className="mt-1.5">{children}</div>
    </div>
  );
}

function Unset({ children }: { children: ReactNode }) {
  return (
    <p className={`rounded-[11px] border-dashed px-3 py-2.5 text-[13px] text-[#8b8494] ${recessed}`}>{children}</p>
  );
}

/* ------------------------------------------------------------------------ */
/* Public leaderboard                                                        */
/* ------------------------------------------------------------------------ */

function LeaderboardToggle({
  enabled,
  onChange,
  slug,
}: {
  enabled: boolean;
  onChange?: () => void;
  slug: string | null;
}) {
  const [on, setOn] = useState(enabled);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const origin = useOrigin();

  // eslint-disable-next-line react-hooks/set-state-in-effect -- mirror the persisted flag when the overview refreshes
  useEffect(() => setOn(enabled), [enabled]);

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
    <Card
      id="boosts-leaderboard"
      icon={P.trophy}
      title="Public leaderboard"
      hint="Ranks fans by spins and rare wins — never by spend. Only fans who tick “Show me on the leaderboard” on their spin page appear."
      aside={
        <button
          type="button"
          onClick={toggle}
          disabled={busy}
          aria-pressed={on}
          // The visible "On"/"Off" is part of the accessible name (WCAG 2.5.3).
          aria-label={`Public leaderboard ${on ? "On" : "Off"}`}
          className="inline-flex items-center gap-2.5 rounded-full py-0.5 pl-2 pr-0.5 text-[12.5px] font-semibold text-muted transition-colors hover:text-ink disabled:opacity-60"
        >
          {on ? "On" : "Off"}
          <span
            aria-hidden="true"
            className={`relative h-[26px] w-[46px] shrink-0 rounded-full transition-colors ${on ? "bg-[var(--brand)]" : "bg-line"}`}
          >
            <span
              className={`absolute top-[3px] h-5 w-5 rounded-full transition-all ${
                on ? "left-[23px] bg-[var(--brand-ink)]" : "left-[3px] bg-white"
              }`}
            />
          </span>
        </button>
      }
    >
      {on && slug ? (
        <div className={`flex flex-wrap items-center gap-2 rounded-[11px] px-3 py-2 ${recessed}`}>
          <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-ink">{`${origin}/leaderboard/${slug}`}</span>
          <a href={`/leaderboard/${slug}`} target="_blank" rel="noopener noreferrer" className={`${secondaryBtn} min-h-8 px-3`}>
            View <Glyph d={P.external} size={13} />
          </a>
          <button
            type="button"
            onClick={async () => {
              if (await copyToClipboard(`${origin}/leaderboard/${slug}`)) {
                toast("Leaderboard link copied", { tone: "success" });
              }
            }}
            className={`${secondaryBtn} min-h-8 px-3`}
          >
            <Glyph d={P.copy} size={13} />
            Copy link
          </button>
        </div>
      ) : on ? (
        <p className="text-xs text-[#8b8494]">
          Set your public link under Settings › Public page to get a shareable leaderboard URL.
        </p>
      ) : (
        <p className="text-xs text-[#8b8494]">Off — fans don&rsquo;t see a ranking.</p>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------------ */
/* Happy hours                                                               */
/* ------------------------------------------------------------------------ */

// Status → [pill classes, label]. Live = green, scheduled = brand, ended = muted.
const HH_STATUS: Record<HappyHourStatus, [string, string]> = {
  live: ["bg-[#10b981]/15 text-[#6ee7b7]", "Live"],
  scheduled: ["bg-[color-mix(in_oklab,var(--brand)_16%,transparent)] text-brand", "Scheduled"],
  ended: ["bg-[color-mix(in_oklab,var(--color-ink)_7%,transparent)] text-muted", "Ended"],
};

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
    <Card
      id="boosts-happy-hours"
      icon={P.clock}
      title="Happy hours"
      hint="Boost rare odds for a time-boxed window. Fans see a live banner."
    >
      {/* Create form: the design draws only the list, so the form sits at the
          top of the card as a recessed well (PARITY_MAP §2.10 "needs placement"). */}
      <form
        aria-label="Schedule a happy hour"
        onSubmit={(e) => {
          e.preventDefault();
          create();
        }}
        className={`grid grid-cols-2 gap-3 rounded-xl p-3.5 lg:grid-cols-[minmax(0,1.3fr)_84px_minmax(0,1fr)_minmax(0,1fr)_auto] lg:items-end ${recessed}`}
      >
        <label className={`${fieldLabel} col-span-2 lg:col-span-1`}>
          Wheel
          <select value={wheelId} onChange={(e) => setWheelId(e.target.value)} className="ff-input w-full min-w-0 normal-case tracking-normal">
            {wheels.map((w) => (
              <option key={w.id} value={w.id}>
                {w.title}
              </option>
            ))}
          </select>
        </label>
        <label className={`${fieldLabel} col-span-2 sm:col-span-1 lg:col-span-1`}>
          Boost ×
          <input
            type="number"
            min={1}
            max={10}
            step={0.5}
            value={multiplier}
            onChange={(e) => setMultiplier(Number(e.target.value))}
            className="ff-input tnum w-full min-w-0 normal-case tracking-normal"
          />
        </label>
        <label className={`${fieldLabel} col-span-2 sm:col-span-1 lg:col-span-1`}>
          Starts
          <input
            type="datetime-local"
            value={startsAt}
            onChange={(e) => setStartsAt(e.target.value)}
            className="ff-input w-full min-w-0 normal-case tracking-normal"
          />
        </label>
        <label className={`${fieldLabel} col-span-2 sm:col-span-1 lg:col-span-1`}>
          Ends
          <input
            type="datetime-local"
            value={endsAt}
            onChange={(e) => setEndsAt(e.target.value)}
            className="ff-input w-full min-w-0 normal-case tracking-normal"
          />
        </label>
        <button type="submit" disabled={busy} className={`${primaryBtn} col-span-2 sm:col-span-1 lg:col-span-1`}>
          Schedule
        </button>
      </form>

      {windows.length === 0 ? (
        <p className="mt-3 text-xs text-[#8b8494]">No happy hours yet. Pick a window above to boost rare odds.</p>
      ) : (
        <ul className="mt-3 flex flex-col gap-2">
          {windows.map((w) => {
            const status = happyHourStatus(w.startsAt, w.endsAt);
            const [pill, label] = HH_STATUS[status];
            return (
              <li key={w.id} className={`flex items-center gap-3 rounded-[11px] px-3.5 py-3 ${recessed}`}>
                <span className="text-brand">
                  <Glyph d={P.clock} />
                </span>
                <div className="min-w-0 flex-1">
                  {/* Wraps rather than truncates: at 390px the window is the row's
                      primary label and an ellipsis there hides the date. */}
                  <p className="text-sm font-semibold text-ink text-pretty">{formatWindow(w.startsAt, w.endsAt)}</p>
                  <p className="mt-0.5 text-[12.5px] text-muted text-pretty">
                    <span className="tnum font-bold text-brand">×{w.multiplier}</span> odds · {wheelName(w.wheelId)}
                  </p>
                </div>
                <span className={`shrink-0 rounded-full px-2.5 py-[3px] text-[11px] font-bold ${pill}`}>{label}</span>
                <button
                  type="button"
                  onClick={() => remove(w.id)}
                  aria-label={`Remove happy hour ${formatWindow(w.startsAt, w.endsAt)}`}
                  className="shrink-0 rounded-lg px-2 py-1 text-xs font-semibold text-muted transition-colors hover:bg-white/5 hover:text-ink"
                >
                  Remove
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------------ */
/* Wishlist demand + Referrals                                               */
/* ------------------------------------------------------------------------ */

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

  const counts = demand.map((d) => d.count);

  return (
    <Card id="boosts-wishlist" icon={P.heart} title="Wishlist demand" hint="What fans are chasing most.">
      {demand.length === 0 ? (
        <p className="text-xs text-[#8b8494]">No wishlist activity yet.</p>
      ) : (
        <ul className="flex flex-col gap-2.5">
          {demand.map((d) => {
            const c = RARITY_COLORS[d.rarity];
            const pct = demandPct(d.count, counts);
            return (
              <li key={d.prizeLabel} className="flex items-center gap-2.5 text-[13px]">
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: c }} aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate text-ink">{d.prizeLabel}</span>
                <span
                  className="h-1.5 w-[72px] shrink-0 overflow-hidden rounded-full bg-[var(--color-surface-2)] sm:w-[90px]"
                  role="img"
                  aria-label={`${pct}% of top demand`}
                >
                  <span className="block h-full rounded-full bg-[var(--brand)]" style={{ width: `${pct}%` }} />
                </span>
                <span className="tnum w-6 shrink-0 text-right font-bold text-ink">{d.count}</span>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
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
    <Card id="boosts-referrals" icon={P.fans} title="Referrals" hint="Fans who bring friends earn bonus spins.">
      <dl className="grid grid-cols-3 gap-px overflow-hidden rounded-xl border border-[var(--hair)] bg-[var(--hair)]">
        <Stat label="Referred" value={stats?.referredCount ?? 0} />
        <Stat label="Credited" value={stats?.creditedCount ?? 0} />
        <Stat label="Bonus spins" value={stats?.bonusAwarded ?? 0} />
      </dl>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex min-w-0 flex-col-reverse px-3 py-3 [background:var(--s2)]">
      <dt className="mt-0.5 truncate text-[10px] uppercase tracking-[0.04em] text-muted">{label}</dt>
      <dd className="tnum text-lg font-bold leading-none text-ink">{value}</dd>
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* Webhooks (advanced; not in the design but the e2e and integrations rely)  */
/* ------------------------------------------------------------------------ */

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
    // Optimistically drop the row, then roll it back to its original position
    // if the delete fails so the UI never silently diverges from the server.
    const index = hooks.findIndex((x) => x.id === id);
    if (index === -1) return;
    const removed = hooks[index];
    setHooks((h) => h.filter((x) => x.id !== id));
    try {
      const res = await fetch(`/api/webhooks/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error();
    } catch {
      setHooks((h) => {
        const next = [...h];
        next.splice(Math.min(index, next.length), 0, removed);
        return next;
      });
      toast("Couldn't remove webhook");
    }
  };

  return (
    <Card
      id="boosts-webhooks"
      icon={P.bolt}
      title="Webhooks"
      hint="Automatically ping another app the moment a fan wins. FanFunnel sends the win's details to a web address you choose, so you can connect it to tools like Zapier, Make, Discord, or Slack (e.g. auto-log wins to a spreadsheet or get a chat notification). Most creators can skip this."
      aside={
        <span className="rounded-full bg-[color-mix(in_oklab,var(--color-ink)_7%,transparent)] px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.03em] text-muted">
          Advanced · optional
        </span>
      }
    >
      <form
        aria-label="Add a webhook"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
        className={`flex flex-col gap-3 rounded-xl p-3.5 sm:flex-row sm:items-end ${recessed}`}
      >
        <label className={`${fieldLabel} flex-1`}>
          Endpoint URL
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com/hooks/fanfunnel"
            className="ff-input w-full min-w-0 font-mono normal-case tracking-normal"
          />
        </label>
        <button type="submit" disabled={busy} className={primaryBtn}>
          Add
        </button>
      </form>

      {hooks.length > 0 && (
        <ul className="mt-3 flex flex-col gap-2">
          {hooks.map((h) => (
            <li key={h.id} className={`flex items-center gap-3 rounded-[11px] px-3.5 py-2.5 text-sm ${recessed}`}>
              <span className="shrink-0 rounded-full bg-[color-mix(in_oklab,var(--brand)_16%,transparent)] px-2 py-0.5 text-[11px] font-semibold text-brand">
                {h.event}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink">{h.url}</span>
              <button
                type="button"
                onClick={() => remove(h.id)}
                aria-label={`Remove webhook ${h.url}`}
                className="shrink-0 rounded-lg px-2 py-1 text-xs font-semibold text-muted transition-colors hover:bg-white/5 hover:text-ink"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------------ */
/* Danger zone                                                               */
/* ------------------------------------------------------------------------ */

/** Destructive account reset — wipes all wheels/fans/spins/campaigns. */
function DangerZone() {
  const toast = useToast();
  const router = useRouter();
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
        // #9: re-run the server components to reflect the wipe instead of a
        // hard page reload. A short delay lets the toast register first.
        setTimeout(() => router.refresh(), 700);
      } else {
        toast("Couldn't reset. Are you signed in?", { tone: "error" });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      id="boosts-danger"
      icon={P.warn}
      title="Danger zone"
      tone="danger"
      hint={
        <>
          Clear all data — wheels, prizes, fans, links, spins, grants, campaigns, and metrics — and start fresh.
          This <strong className="text-ink">cannot be undone</strong>.
        </>
      }
    >
      {!confirming ? (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="inline-flex min-h-9 items-center rounded-[9px] border border-[#ef4444]/55 px-3.5 text-[13px] font-semibold text-[#f87171] transition-colors hover:bg-[#ef4444]/10"
        >
          Clear all data
        </button>
      ) : (
        <div className="flex flex-col gap-2.5">
          <label className="flex flex-col gap-1.5 text-sm text-ink">
            <span>
              Type <strong>RESET</strong> to confirm:
            </span>
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              className="ff-input w-full sm:max-w-xs"
              placeholder="RESET"
              autoComplete="off"
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={reset}
              disabled={busy || typed !== "RESET"}
              className="inline-flex min-h-9 items-center rounded-[9px] bg-[#ef4444] px-3.5 text-[13px] font-bold text-white transition hover:brightness-110 disabled:opacity-40"
            >
              {busy ? "Clearing…" : "Permanently clear everything"}
            </button>
            <button
              type="button"
              onClick={() => {
                setConfirming(false);
                setTyped("");
              }}
              className={secondaryBtn}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </Card>
  );
}
