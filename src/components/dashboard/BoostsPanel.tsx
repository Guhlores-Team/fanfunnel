"use client";

import { MAX_COMBINED_BOOST } from "@/lib/focus/config";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { HappyHour, Webhook, WheelSummary, WishlistDemand } from "@/lib/data/types";
import { RARITY_COLORS } from "@/lib/games/wheel/types";
import { useToast } from "@/components/ui/Toast";
import { copyToClipboard } from "@/lib/hooks/useClipboard";
import { useOrigin } from "@/lib/hooks/useOrigin";
import { demandPct, formatWindow, happyHourGames, happyHourStatus, type HappyHourStatus } from "./boostsHelpers";
import { gameOptionLabel, liveExplanation } from "./gameAssignment";
import { LoadError } from "./analyticsUi";
import { loadJson } from "@/lib/hooks/loadJson";
import LoadFailed from "./LoadFailed";
import { useCreatorDraft } from "./CreatorDrafts";
import { useTimeZone, zoneHint } from "@/lib/localTime";
import { useNow } from "@/lib/hooks/useNow";

/** A list read: loading, loaded, or failed (never shown as an empty list). */
type ListLoad = "loading" | "ok" | "failed";

// The shared read (C2): 401 → sign in, 429 → "Too many requests", else an error.
const getJson = <T,>(url: string): Promise<T> => loadJson<T>(url);

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
  "btn-brand inline-flex min-h-9 items-center justify-center gap-1.5 rounded-[9px] px-[15px] text-[13px] font-bold disabled:opacity-50 aria-disabled:opacity-50";
const secondaryBtn =
  "inline-flex min-h-9 items-center justify-center gap-1.5 rounded-[9px] border border-line px-3.5 text-[12.5px] font-semibold text-ink transition-colors hover:border-[var(--brand)]/60 hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-50";
const fieldLabel = "flex min-w-0 flex-col gap-1.5 text-[10.5px] font-semibold uppercase tracking-[0.05em] text-muted";
const quietBtn =
  "shrink-0 rounded-lg px-2 py-1 text-xs font-semibold text-muted transition-colors hover:bg-white/5 hover:text-ink";

/**
 * Two-step inline remove for a list row (the dashboard's Delete → Confirm /
 * Cancel idiom). "Remove" opens a confirm strip under the row and focuses its
 * destructive button, which is described by the plain-language question so a
 * screen reader hears it on focus. Cancel or Escape closes the strip and puts
 * focus back on "Remove".
 */
function RemoveConfirm({
  id,
  label,
  question,
  confirmText,
  onConfirm,
}: {
  id: string;
  /** Accessible name of the "Remove" trigger, e.g. "Remove webhook https://…". */
  label: string;
  question: string;
  confirmText: string;
  onConfirm: () => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const questionId = `${id}-confirm-q`;

  useEffect(() => {
    if (open) confirmRef.current?.focus();
    else if (restoreFocus.current) {
      restoreFocus.current = false;
      triggerRef.current?.focus();
    }
  }, [open]);

  const cancel = () => {
    restoreFocus.current = true;
    setOpen(false);
  };

  if (!open) {
    return (
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(true)}
        aria-label={label}
        className={quietBtn}
      >
        Remove
      </button>
    );
  }

  return (
    <div
      role="group"
      // A short label: the question itself is the confirm button's description.
      aria-label="Confirm removal"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          cancel();
        }
      }}
      className="flex basis-full flex-wrap items-center gap-x-3 gap-y-2 border-t border-[var(--hair)] pt-2.5"
    >
      <p id={questionId} className="min-w-0 flex-1 basis-48 text-[12.5px] text-ink text-pretty">
        {question}
      </p>
      <div className="flex shrink-0 gap-2">
        <button
          ref={confirmRef}
          type="button"
          onClick={onConfirm}
          aria-describedby={questionId}
          className="inline-flex min-h-8 items-center rounded-lg border border-[#ef4444]/70 px-3 text-xs font-bold text-[#f87171] transition-colors hover:bg-[#ef4444]/10"
        >
          {confirmText}
        </button>
        <button
          type="button"
          onClick={cancel}
          className="inline-flex min-h-8 items-center rounded-lg border border-line px-3 text-xs font-semibold text-muted transition-colors hover:text-ink"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

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
          {/* tabIndex -1: a removed row's focus lands on its card's heading. */}
          <h3
            id={id}
            tabIndex={-1}
            className="flex items-center gap-[9px] text-[15px] font-bold tracking-[-0.01em] text-ink outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]/60 rounded-sm"
          >
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
  const [profileError, setProfileError] = useState<unknown>(null);
  const [profileAttempt, setProfileAttempt] = useState(0);

  // One fetch shared by the link-in-bio card and the leaderboard links. A
  // failed read says so; it is never "no public page yet" (C2).
  useEffect(() => {
    let live = true;
    getJson<{ slug?: string | null; tipUrl?: string | null; tagline?: string | null }>("/api/public-profile")
      .then((d) => {
        if (!live) return;
        setProfileError(null);
        setProfile({ slug: d.slug ?? null, tipUrl: d.tipUrl ?? null, tagline: d.tagline ?? null });
      })
      .catch((e) => live && setProfileError(e));
    return () => {
      live = false;
    };
  }, [profileAttempt]);

  return (
    <div className="flex max-w-[880px] flex-col gap-[18px]">
      <LinkInBioCard profile={profile} error={profileError} onRetry={() => { setProfileError(null); setProfileAttempt((n) => n + 1); }} onNavigate={onNavigate} />
      <LeaderboardToggle enabled={leaderboardEnabled} onChange={onLeaderboardChange} slug={profile?.slug ?? null} />
      <HappyHourScheduler />
      <div className="grid gap-[18px] sm:grid-cols-2">
        <WishlistDemandCard />
        <ReferralStatsCard />
      </div>
      <WebhooksCard />
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* Link-in-bio (read-only; the form lives under Settings › Public page)      */
/* ------------------------------------------------------------------------ */

function LinkInBioCard({
  profile,
  error = null,
  onRetry,
  onNavigate,
}: {
  profile: PublicProfile | null;
  error?: unknown;
  onRetry?: () => void;
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
      hint="A clean, safe-for-work page for your IG/TikTok bio — your game and a way in."
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
      {profile === null && error != null ? (
        <LoadFailed compact error={error} what="your public page" onRetry={onRetry} testId="boosts-profile-load-failed" />
      ) : profile === null ? (
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

          <Field label="Your tip or support link" note="shown to fans">
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
          // A switch named by the card title; its state is aria-checked (QA b5
          // polish: a button whose label flipped On/Off read as two controls).
          role="switch"
          aria-checked={on}
          aria-labelledby="boosts-leaderboard"
          data-testid="leaderboard-switch"
          className="inline-flex items-center gap-2.5 rounded-full py-0.5 pl-2 pr-0.5 text-[12.5px] font-semibold text-muted transition-colors hover:text-ink disabled:opacity-60"
        >
          <span aria-hidden="true">{on ? "On" : "Off"}</span>
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
  // RD-18: kept as typed so the field can be cleared; validated on Schedule.
  const [multiplier, setMultiplier] = useState("2");
  const [startsAt, setStartsAt] = useState("");
  const zone = useTimeZone();
  const [endsAt, setEndsAt] = useState("");
  const [busy, setBusy] = useState(false);
  // RD-18: the status pills re-evaluate each minute, so a window that starts
  // while the panel is open moves from "Scheduled" to "Live".
  const nowTick = useNow(60_000);
  const [state, setState] = useState<ListLoad>("loading");
  // Whether the lists have ever loaded: a failed refresh keeps the last good
  // lists (and Schedule) and only says the refresh failed.
  const [loaded, setLoaded] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const toast = useToast();
  // C14: a half-set happy hour is unsaved work.
  useCreatorDraft("happy-hour", "a happy hour you were scheduling", startsAt !== "" || endsAt !== "", busy);

  // A15: a failed read is an error with a retry, never "no happy hours yet"
  // (which would invite a duplicate). The last good lists stay on screen.
  const load = useCallback(async () => {
    try {
      const [w, h] = await Promise.all([
        getJson<{ wheels?: WheelSummary[] }>("/api/wheels"),
        getJson<{ happyHours?: HappyHour[] }>("/api/happy-hours"),
      ]);
      const list = w.wheels ?? [];
      setWheels(list);
      setWindows(h.happyHours ?? []);
      // Default to the game fans are playing now (QA b5 m9), not the first listed.
      setWheelId((current) => current && happyHourGames(list).some((g) => g.id === current) ? current : liveExplanation(happyHourGames(list), new Date())?.game.id ?? happyHourGames(list)[0]?.id ?? "");
      setLoaded(true);
      setState("ok");
    } catch (e) {
      setFailure(e);
      setState("failed");
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount
    load();
  }, [load]);

  const create = async () => {
    if (busy || !loaded) return;
    if (!wheelId || !startsAt || !endsAt) {
      toast("Pick a game and a start/end time");
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
    const boost = Number(multiplier.trim());
    if (multiplier.trim() === "" || !Number.isFinite(boost) || boost < 1 || boost > MAX_COMBINED_BOOST) {
      toast(`Boost must be between 1 and ${MAX_COMBINED_BOOST}`, { tone: "error" });
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/happy-hours", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          wheelId,
          multiplier: boost,
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
    // The row (and the focused confirm button) is gone: land on the card.
    document.getElementById("boosts-happy-hours")?.focus();
    const res = await fetch(`/api/happy-hours/${id}`, { method: "DELETE" }).catch(() => null);
    // The reload restores the row if the delete didn't land.
    toast(res?.ok ? "Happy hour removed" : "Couldn't remove happy hour");
    load();
  };

  const wheelName = (id: string) => wheels.find((w) => w.id === id)?.title ?? "a game";
  const playable = happyHourGames(wheels);
  const liveId = liveExplanation(playable, new Date())?.game.id ?? null;

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
          Game
          <select value={wheelId} onChange={(e) => setWheelId(e.target.value)} data-testid="happy-hour-game" className="ff-input w-full min-w-0 normal-case tracking-normal">
            {playable.length === 0 && <option value="">No playable game yet</option>}
            {playable.map((w) => (
              <option key={w.id} value={w.id}>
                {gameOptionLabel(w)}{w.id === liveId ? " · live now" : ""}
              </option>
            ))}
          </select>
        </label>
        <label className={`${fieldLabel} col-span-2 sm:col-span-1 lg:col-span-1`}>
          Boost ×
          <input
            type="number"
            min={1}
            max={MAX_COMBINED_BOOST}
            step={0.5}
            value={multiplier}
            onChange={(e) => setMultiplier(e.target.value)}
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
            aria-describedby="happy-hour-zone"
          />
        </label>
        <p id="happy-hour-zone" className="col-span-2 text-xs normal-case tracking-normal text-muted lg:col-span-5">{zoneHint(zone)}</p>
        {/* Off (disabled) until the lists first load; while a save is in
            flight it is only aria-disabled, so a keyboard user keeps focus. */}
        <button type="submit" disabled={!loaded} aria-disabled={busy || undefined} className={`${primaryBtn} col-span-2 sm:col-span-1 lg:col-span-1`}>
          Schedule
        </button>
      </form>

      {state === "failed" && (
        <div data-testid="happy-hours-load-error" className="mt-3">
          <LoadError what={loaded ? "the latest happy hours" : "your happy hours and wheels"} error={failure} onRetry={() => void load()} />
        </div>
      )}
      {!loaded ? (
        state === "loading" ? <p className="mt-3 text-xs text-muted" aria-busy="true">Loading happy hours…</p> : null
      ) : windows.length === 0 ? (
        <p className="mt-3 text-xs text-[#8b8494]">No happy hours yet. Pick a window above to boost rare odds.</p>
      ) : (
        <ul className="mt-3 flex flex-col gap-2">
          {windows.map((w) => {
            const status = happyHourStatus(w.startsAt, w.endsAt, nowTick ?? undefined);
            const [pill, label] = HH_STATUS[status];
            return (
              <li key={w.id} className={`flex flex-wrap items-center gap-3 rounded-[11px] px-3.5 py-3 ${recessed}`}>
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
                <RemoveConfirm
                  id={`hh-${w.id}`}
                  label={`Remove happy hour ${formatWindow(w.startsAt, w.endsAt)}`}
                  question={
                    status === "live"
                      ? `End this live happy hour now? Odds go back to normal for ${wheelName(w.wheelId)}.`
                      : `Remove the happy hour for ${formatWindow(w.startsAt, w.endsAt)}?`
                  }
                  confirmText="Remove happy hour"
                  onConfirm={() => remove(w.id)}
                />
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
  const [state, setState] = useState<ListLoad>("loading");
  const [failure, setFailure] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    getJson<{ demand?: WishlistDemand[] }>("/api/wishlist-demand")
      .then((d) => {
        if (!live) return;
        setDemand(d.demand ?? []);
        setState("ok");
      })
      .catch((e) => { if (live) { setFailure(e); setState("failed"); } });
    return () => {
      live = false;
    };
  }, [attempt]);

  const counts = demand.map((d) => d.count);

  return (
    <Card id="boosts-wishlist" icon={P.heart} title="Wishlist demand" hint="What fans are chasing most.">
      {state === "failed" ? (
        <LoadError
          what="wishlist demand"
          error={failure}
          onRetry={() => {
            setState("loading");
            setAttempt((n) => n + 1);
          }}
        />
      ) : state === "loading" ? (
        <p className="text-xs text-muted" aria-busy="true">Loading wishlist demand…</p>
      ) : demand.length === 0 ? (
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
  const [failure, setFailure] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);

  // A failed read is not "0 referred" (C2).
  useEffect(() => {
    let live = true;
    getJson<ReferralStats>("/api/referrals/stats")
      .then((d) => { if (live) { setStats(d); setFailure(null); } })
      .catch((e) => live && setFailure(e));
    return () => {
      live = false;
    };
  }, [attempt]);

  return (
    <Card id="boosts-referrals" icon={P.fans} title="Referrals" hint="Fans who bring friends earn bonus spins.">
      <dl className="grid grid-cols-3 gap-px overflow-hidden rounded-xl border border-[var(--hair)] bg-[var(--hair)]">
        <Stat label="Referred" value={stats ? stats.referredCount : "—"} />
        <Stat label="Credited" value={stats ? stats.creditedCount : "—"} />
        <Stat label="Bonus spins" value={stats ? stats.bonusAwarded : "—"} />
      </dl>
      {failure != null && (
        <div className="mt-3">
          <LoadError what="referral numbers" error={failure} onRetry={() => setAttempt((n) => n + 1)} />
        </div>
      )}
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
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

// A16: what each hook is sent, and why a create can be refused.
const WEBHOOK_EVENT_LABEL: Record<string, string> = {
  all: "Every win",
  prize_pending: "Wins to fulfil",
  prize_delivered: "Auto-delivered wins",
};
const WEBHOOK_MAX = 5;
const WEBHOOK_ERROR: Record<string, string> = {
  webhook_limit: `You can have up to ${WEBHOOK_MAX} webhooks. Remove one first.`,
  blocked_url: "That address points at a private or local network, so FanFunnel can't send to it.",
  invalid_url: "Enter a full web address starting with http(s)://",
  rate_limited: "Too many tries. Wait a minute and try again.",
};

function WebhooksCard() {
  const [hooks, setHooks] = useState<Webhook[]>([]);
  const [url, setUrl] = useState("");
  const [event, setEvent] = useState("all");
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<ListLoad>("loading");
  const [failure, setFailure] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  const toast = useToast();
  // C14: a typed webhook URL is unsaved work.
  useCreatorDraft("webhooks", "a webhook you were adding", url.trim().length > 0, busy);

  // A15: until the list has loaded, Add stays off: a creator who can't see
  // their hooks must not be invited to add the same one again.
  useEffect(() => {
    let live = true;
    getJson<{ webhooks?: Webhook[] }>("/api/webhooks")
      .then((d) => {
        if (!live) return;
        setHooks(d.webhooks ?? []);
        setState("ok");
      })
      .catch((e) => { if (live) { setFailure(e); setState("failed"); } });
    return () => {
      live = false;
    };
  }, [attempt]);

  const add = async () => {
    if (busy || state !== "ok" || hooks.length >= WEBHOOK_MAX) return;
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
        body: JSON.stringify({ url: value, event }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.webhook) throw new Error(typeof data.error === "string" ? data.error : "");
      setHooks((h) => [data.webhook, ...h]);
      setUrl("");
      toast("Webhook added");
    } catch (e) {
      toast(WEBHOOK_ERROR[e instanceof Error ? e.message : ""] ?? "Couldn't add webhook", { tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  // PR-15: one signed sample delivery; the receiver's answer is the toast.
  const [testing, setTesting] = useState<string | null>(null);
  const sendTest = async (id: string) => {
    if (testing) return;
    setTesting(id);
    try {
      const res = await fetch(`/api/webhooks/${id}/test`, { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as { status?: number; signed?: boolean; error?: string };
      if (!res.ok) {
        toast(
          data.error === "blocked_target" ? "That address can't be reached from FanFunnel (private or unresolvable host)." :
          data.error === "rate_limited" ? "Slow down — at most 10 test deliveries a minute." :
          data.error === "forbidden" ? "Only the account owner can send test deliveries." :
          "Couldn't send the test delivery. Try again.",
          { tone: "error" },
        );
        return;
      }
      const status = data.status ?? 0;
      toast(
        status === 0 ? "No answer from that address (timed out or refused). Check the URL and that it accepts POST." :
        status >= 200 && status < 300 ? `Delivered — the receiver answered HTTP ${status}${data.signed ? " (signed)" : " (unsigned: no secret yet)"}.` :
        `The receiver answered HTTP ${status}. Check its logs for the test payload.`,
        { tone: status >= 200 && status < 300 ? "success" : "error", key: `wh-test-${id}` },
      );
    } catch {
      toast("Couldn't send the test delivery. Check your connection.", { tone: "error" });
    } finally {
      setTesting(null);
    }
  };

  const remove = async (id: string) => {
    // Optimistically drop the row, then roll it back to its original position
    // if the delete fails so the UI never silently diverges from the server.
    const index = hooks.findIndex((x) => x.id === id);
    if (index === -1) return;
    const removed = hooks[index];
    setHooks((h) => h.filter((x) => x.id !== id));
    // The row (and the focused confirm button) is gone: land on the card.
    document.getElementById("boosts-webhooks")?.focus();
    try {
      const res = await fetch(`/api/webhooks/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error();
      toast("Webhook removed");
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
        <label className={fieldLabel}>
          Send
          <select value={event} onChange={(e) => setEvent(e.target.value)} className="ff-input normal-case tracking-normal">
            {Object.entries(WEBHOOK_EVENT_LABEL).map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" disabled={state !== "ok"} aria-disabled={busy || hooks.length >= WEBHOOK_MAX || undefined} className={primaryBtn}>
          Add
        </button>
      </form>
      {state === "failed" && (
        <div data-testid="webhooks-load-error" className="mt-3">
          <LoadError
            what="your webhooks"
            error={failure}
            onRetry={() => {
              setState("loading");
              setAttempt((n) => n + 1);
            }}
          />
        </div>
      )}
      {state === "loading" && <p className="mt-3 text-xs text-muted" aria-busy="true">Loading webhooks…</p>}
      {hooks.length >= WEBHOOK_MAX && (
        <p className="mt-2 text-xs text-muted">You have the maximum of {WEBHOOK_MAX} webhooks.</p>
      )}

      {hooks.length > 0 && (
        <ul className="mt-3 flex flex-col gap-2">
          {hooks.map((h) => (
            <li key={h.id} className={`flex flex-wrap items-center gap-3 rounded-[11px] px-3.5 py-2.5 text-sm ${recessed}`}>
              <span className="shrink-0 rounded-full bg-[color-mix(in_oklab,var(--brand)_16%,transparent)] px-2 py-0.5 text-[11px] font-semibold text-brand">
                {WEBHOOK_EVENT_LABEL[h.event] ?? h.event}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink">{h.url}</span>
              <button
                type="button"
                disabled={testing === h.id}
                onClick={() => void sendTest(h.id)}
                aria-label={`Send a test delivery to ${h.url}`}
                className="min-h-11 rounded-[9px] border border-line px-3 text-xs font-semibold text-ink transition-colors hover:border-[var(--brand)] disabled:opacity-50"
                data-testid="webhook-test"
              >
                {testing === h.id ? "Sending…" : "Send test"}
              </button>
              <RemoveConfirm
                id={`wh-${h.id}`}
                label={`Remove webhook ${h.url}`}
                question="Remove this webhook? FanFunnel stops sending wins to this address right away."
                confirmText="Remove webhook"
                onConfirm={() => remove(h.id)}
              />
            </li>
          ))}
        </ul>
      )}
      <WebhookSecret />
    </Card>
  );
}

/**
 * A16: the creator's signing secret. Hidden until asked for; every delivery
 * carries X-FanFunnel-Signature: t=<unix>,v1=<HMAC-SHA256 of "t.body">.
 */
function WebhookSecret() {
  const toast = useToast();
  const [secret, setSecret] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmRotate, setConfirmRotate] = useState(false);
  async function load(rotate: boolean) {
    setBusy(true);
    try {
      const res = await fetch("/api/webhooks/secret", { method: rotate ? "POST" : "GET", cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || typeof data.secret !== "string") throw new Error();
      setSecret(data.secret);
      setConfirmRotate(false);
      if (rotate) toast("Signing secret rotated. Update your receivers.", { tone: "success" });
    } catch {
      toast("Couldn't load the signing secret.", { tone: "error" });
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className={`mt-3 flex flex-col gap-2 rounded-xl p-3.5 ${recessed}`} data-testid="webhook-secret">
      <p className="text-[12.5px] font-semibold text-ink">Signing secret</p>
      <p className="text-xs text-muted text-pretty">
        Each delivery has an <code className="font-mono">X-FanFunnel-Signature: t=…,v1=…</code> header: an HMAC-SHA256 of
        the timestamp, a dot and the raw body, made with this secret. Check it before trusting a request.
      </p>
      {secret ? (
        <code className="break-all rounded-lg bg-base/60 p-2 font-mono text-xs text-ink" aria-label="Signing secret">
          {secret}
        </code>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {!secret && (
          <button type="button" disabled={busy} onClick={() => void load(false)} className={secondaryBtn}>
            Show secret
          </button>
        )}
        {secret && (
          <button
            type="button"
            onClick={() => void copyToClipboard(secret).then((ok) => toast(ok ? "Secret copied" : "Couldn't copy — select the secret and copy it by hand.", ok ? {} : { tone: "error" }))}
            className={secondaryBtn}
          >
            Copy
          </button>
        )}
        {confirmRotate ? (
          <>
            <button type="button" disabled={busy} onClick={() => void load(true)} className={secondaryBtn}>
              Confirm rotate
            </button>
            <button type="button" onClick={() => setConfirmRotate(false)} className={quietBtn}>
              Cancel
            </button>
          </>
        ) : (
          <button type="button" disabled={busy} onClick={() => setConfirmRotate(true)} className={quietBtn}>
            Rotate secret
          </button>
        )}
      </div>
      {confirmRotate && (
        <p className="text-xs text-muted">The old secret stops working at once; receivers checking it will reject new deliveries until updated.</p>
      )}
    </div>
  );
}
