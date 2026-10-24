"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useFetch } from "@/lib/hooks/useFetch";

interface Entry {
  rank: number;
  handle: string;
  spins: number;
  rareWins: number;
}
interface View {
  enabled: boolean;
  creatorTitle: string;
  entries: Entry[];
}

const MEDAL = ["🥇", "🥈", "🥉"];

/**
 * A compact, fan-facing leaderboard embedded right in the spin page — fans see
 * the competition without ever leaving (or touching any creator UI). Shows the
 * top few ranked by spins/rare wins. Self-fetches; renders nothing if off.
 *
 * Privacy: the board is public and unauthenticated, so a fan only ever appears
 * here after ticking the opt-in below (spinning does not opt anyone in), and no
 * entry carries a spend figure.
 */
// How many to show before the "Show all" expander kicks in.
const PREVIEW = 10;

export default function FanLeaderboard({
  creatorId,
  token,
  optedIn,
  youHandle,
  refreshKey = 0,
}: {
  creatorId: string;
  /** The fan link's token — the gate on the opt-in route. */
  token: string;
  /** Whether this fan has already consented to appear. Default off. */
  optedIn?: boolean;
  youHandle?: string | null;
  /** Bump to refetch (e.g. after the fan spins) so their new rank shows live. */
  refreshKey?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  // Mirrors the fan's persisted consent, kept here so the board reacts to the
  // toggle immediately (their own row lights up the moment they join).
  const [optIn, setOptIn] = useState(optedIn === true);
  // The board name the fan last saved, so "You're #X" keeps matching after a
  // rename without a page reload.
  const [handle, setHandle] = useState(youHandle ?? "");

  // `refreshKey` is folded into the URL so a spin forces a refetch. A failed
  // read leaves `data` null and the board hides (same as before) — but the
  // error is now owned by the hook instead of swallowed in a bare catch.
  const { data: view, reload } = useFetch<View>(
    `/api/leaderboard/${creatorId}?k=${refreshKey}`,
    { refreshOnVisible: false }
  );

  if (!view || !view.enabled) return null;

  // Find the viewing fan's own row (by their board handle) to highlight + chase.
  // Only meaningful once they've opted in — otherwise they aren't on the board.
  const you =
    optIn && handle
      ? view.entries.find((e) => e.handle.toLowerCase() === handle.toLowerCase()) ?? null
      : null;
  const nextUp = you ? view.entries.find((e) => e.rank === you.rank - 1) ?? null : null;
  const gap = nextUp ? Math.max(1, nextUp.spins - you!.spins) : 0;

  // Always include the fan's own row even if it's past the preview cutoff.
  let shown = expanded ? view.entries : view.entries.slice(0, PREVIEW);
  if (you && !shown.some((e) => e.rank === you.rank)) shown = [...shown, you];
  const hasMore = view.entries.length > PREVIEW;

  return (
    <div className="w-full">
      <p className="mb-2 text-center text-[11px] font-medium uppercase tracking-[0.18em] text-muted">
        🏆 Top spinners
      </p>

      {view.entries.length === 0 ? (
        // Enabled but nobody has opted in yet: invite instead of hiding — the
        // fan shouldn't have to spin first to discover the board exists.
        <p className="rounded-xl border border-line bg-surface/60 px-3 py-5 text-center text-sm text-muted">
          Nobody&rsquo;s on the board yet — join it below to claim the #1 spot! 👑
        </p>
      ) : (
        <>
          {you && (
            <p className="mb-3 text-center text-sm font-semibold text-ink">
              You&rsquo;re <span className="text-[var(--brand)]">#{you.rank}</span>
              {nextUp ? (
                <span className="font-normal text-muted">
                  {" "}
                  · {gap} more {gap === 1 ? "spin" : "spins"} to catch{" "}
                  {nextUp.handle} at #{nextUp.rank}
                </span>
              ) : (
                <span className="font-normal text-muted"> · you&rsquo;re in the lead 👑</span>
              )}
            </p>
          )}
          <ul className="space-y-1.5">
            {shown.map((e) => (
              <li
                key={e.rank}
                className="flex items-center gap-3 rounded-xl border bg-surface/60 px-3 py-2"
                style={
                  you && e.rank === you.rank
                    ? {
                        borderColor: "var(--brand)",
                        background: "color-mix(in oklab, var(--brand) 16%, transparent)",
                      }
                    : e.rank <= 3
                      ? {
                          borderColor: "color-mix(in oklab, var(--brand) 45%, transparent)",
                          background: "color-mix(in oklab, var(--brand) 8%, transparent)",
                        }
                      : { borderColor: "var(--color-line)" }
                }
              >
                <span className="w-6 shrink-0 text-center text-sm font-extrabold">
                  {MEDAL[e.rank - 1] ?? e.rank}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">
                  {e.handle}
                  {you && e.rank === you.rank && (
                    <span className="ml-1.5 rounded-full bg-[var(--brand)] px-1.5 py-0.5 text-[9px] font-bold uppercase text-white">
                      You
                    </span>
                  )}
                </span>
                <span className="shrink-0 text-right text-xs text-muted">
                  {e.spins} spins
                  {e.rareWins > 0 && (
                    <span title={`${e.rareWins} rare-or-better ${e.rareWins === 1 ? "win" : "wins"}`}>
                      {" "}· {e.rareWins}✨
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
          {hasMore && (
            <button
              onClick={() => setExpanded((v) => !v)}
              className="mt-2 w-full rounded-xl border border-line py-2 text-xs font-semibold text-muted transition hover:text-ink"
            >
              {expanded ? "Show less" : `Show all ${view.entries.length} spinners`}
            </button>
          )}
        </>
      )}

      <LeaderboardOptIn
        token={token}
        on={optIn}
        handle={handle}
        onSaved={(nextOptIn, nextHandle) => {
          setOptIn(nextOptIn);
          setHandle(nextHandle);
          void reload();
        }}
      />
    </div>
  );
}

/**
 * The fan's own consent switch. Default OFF: nothing about a fan reaches the
 * public board until they turn this on, and turning it off takes them straight
 * back off. Persisted per fan through the token-gated
 * POST /api/leaderboard/opt-in.
 */
function LeaderboardOptIn({
  token,
  on,
  handle,
  onSaved,
}: {
  token: string;
  on: boolean;
  handle: string;
  /** Called with the values the server accepted, after a successful save. */
  onSaved: (optIn: boolean, handle: string) => void;
}) {
  const [draft, setDraft] = useState(handle);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  // Revealed (and focused) when the fan tries to join without a board name.
  const [needName, setNeedName] = useState(false);
  const nameInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (needName) nameInput.current?.focus();
  }, [needName]);
  const uid = useId();
  const labelId = `${uid}-label`;
  const hintId = `${uid}-hint`;
  const inputId = `${uid}-handle`;

  const save = async (optIn: boolean, name: string) => {
    const trimmed = name.trim();
    // Joining requires a board name (the route rejects it otherwise): the board
    // never shows a fan's real name, so there's nothing else it could display.
    if (optIn && !trimmed) {
      setNeedName(true);
      setStatus("Pick a board name to join.");
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      const res = await fetch("/api/leaderboard/opt-in", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, optIn, handle: optIn ? trimmed : undefined }),
      });
      if (!res.ok) {
        // The server validates the name as typed and never mangles it; relay
        // its verdict so the fan can fix the name instead of guessing.
        const code = ((await res.json().catch(() => null)) as { error?: string } | null)?.error;
        setNeedName(true);
        setStatus(
          code === "handle_invalid"
            ? "Board names are 2–40 characters: letters, numbers, _ . or - only."
            : code === "handle_required"
              ? "Pick a board name to join."
              : "Couldn't save that — try again."
        );
        return;
      }
      setStatus(optIn ? "You're on the board." : "You're off the board.");
      setNeedName(false);
      setDraft(trimmed);
      onSaved(optIn, trimmed);
    } catch {
      setStatus("Couldn't save that — try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-3 rounded-xl border border-line bg-surface/40 px-3 py-3">
      <div className="flex items-center justify-between gap-3">
        <span className="min-w-0 text-sm font-semibold text-ink">
          <span id={labelId}>Show me on the leaderboard</span>
          <span id={hintId} className="mt-0.5 block text-[11px] font-normal text-muted">
            Off by default. Only your board name, spins and rare wins are shown —
            never what you&rsquo;ve spent.
          </span>
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-labelledby={labelId}
          aria-describedby={hintId}
          disabled={busy}
          onClick={() => void save(!on, draft)}
          className="shrink-0 rounded-full border border-line p-0.5 transition disabled:opacity-60"
        >
          <span
            className={`relative block h-6 w-11 rounded-full transition ${on ? "bg-[var(--brand)]" : "bg-line"}`}
          >
            <span
              className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${on ? "left-[1.375rem]" : "left-0.5"}`}
            />
          </span>
        </button>
      </div>

      {(on || needName) && (
        <div className="mt-3">
          <label
            htmlFor={inputId}
            className="block text-[11px] font-medium uppercase tracking-[0.14em] text-muted"
          >
            Board name
          </label>
          <div className="mt-1 flex gap-2">
            <input
              id={inputId}
              ref={nameInput}
              value={draft}
              maxLength={40}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="2–40 letters, numbers, _ . -"
              autoComplete="nickname"
              className="min-w-0 flex-1 rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink"
            />
            <button
              type="button"
              disabled={busy}
              onClick={() => void save(true, draft)}
              className="shrink-0 rounded-lg border border-line px-3 py-2 text-sm font-semibold text-ink transition hover:border-[var(--brand)] disabled:opacity-60"
            >
              {on ? "Save" : "Join"}
            </button>
          </div>
        </div>
      )}

      <p aria-live="polite" className="mt-2 text-[11px] text-muted">
        {status ?? (on ? "" : "Keep spinning to climb the board once you join.")}
      </p>
    </div>
  );
}
