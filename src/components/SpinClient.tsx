"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import Wheel, { type WheelResult } from "./Wheel";
import type { FanPassView, WonPrize } from "@/lib/data/types";
import type { PublicPrize, PublicStock, SpinResult } from "@/lib/games/wheel/types";
import { RARITY_COLORS } from "@/lib/games/wheel/types";
import { applyStockMap } from "@/lib/games/wheel/publicView";
import { useFocusTrap } from "@/lib/hooks/useFocusTrap";
import { playWin, playBuildUp, unlockAudio, haptic, prefersReducedMotion } from "@/lib/sound";
import { detectNearMiss, type NearMiss } from "./fan/nearMiss";
import { spinErrorInfo, ackErrorMessage } from "./spinErrors";
import RewardReveal from "./reveal/RewardReveal";
import {
  REVEAL_IDLE,
  SKIP_ON_BACKDROP_TAP,
  SKIP_ON_ESCAPE,
  SPIN_WATCHDOG_MS,
  bumpSessionSpins,
  canSkip,
  readSessionSpins,
  revealConfetti,
  revealEntrance,
  revealInFlight,
  revealReducer,
  theaterVisible,
} from "./reveal/revealTiers";
// Both beats pull in the motion library and only render briefly after a spin,
// so defer them off the fan page's initial bundle.
const NearMissBeat = dynamic(() => import("./NearMissBeat"), { ssr: false });
const PityBeat = dynamic(() => import("./PityBeat"), { ssr: false });
// RM-1 theater layers only render around a spin, so they load on demand too.
const RevealTheater = dynamic(() => import("./reveal/RevealTheater"), { ssr: false });
const WheelAura = dynamic(
  () => import("./reveal/RevealTheater").then((m) => m.WheelAura),
  { ssr: false }
);
import HappyHourBanner from "./fan/HappyHourBanner";
import WishlistSection from "./fan/WishlistSection";
import ChatPanel from "./fan/ChatPanel";
import TopUpMoment from "./fan/TopUpMoment";
import InstallNudge from "./fan/InstallNudge";
import FanLeaderboard, { LeaderboardWithdrawal } from "./fan/FanLeaderboard";
import CreatorNote from "./fan/CreatorNote";
import PrizeBook from "./fan/PrizeBook";
import LimitedStockRow from "./fan/LimitedStockRow";
import RecentWinsTicker from "./fan/RecentWinsTicker";
import WinsGallery from "./fan/WinsGallery";
import YourPlay from "./fan/YourPlay";
import BreatherCard from "./fan/BreatherCard";
import { useFanBreak, useLinkPause } from "./fan/LinkPauseProvider";
import { useVisitGlow } from "./fan/useVisitGlow";
import { GlowMilestoneToast, GlowTag, glowClass } from "./fan/VisitGlow";
import { spinControl } from "./fan/linkPause";
import { ackReminder, breakStatus, formatBreakEnd, reminderAcked } from "./fan/yourPlay";
import { fanEngagementAllowed, reminderDue } from "@/lib/play/playGuard";
import type { DeliveredReward } from "@/lib/rewards/config";
import InstantReward, { RewardUnavailable } from "./fan/InstantReward";
import { parseDeliveredReward } from "./fan/instantReward";
import FocusChip from "./fan/FocusChip";
import { mergeFanWins } from "./fan/spinPresentation";
import { useSpinRecovery } from "./fan/useSpinRecovery";
import type { FanFocusView, FanOddsView } from "@/lib/data/focusView";

// Fit the wheel to small screens (with a sensible desktop cap).
function useWheelSize() {
  const [size, setSize] = useState(340);
  useEffect(() => {
    const update = () =>
      setSize(Math.max(260, Math.min(380, window.innerWidth - 48)));
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return size;
}

export default function SpinClient({
  pass,
  gallery = null,
}: {
  pass: FanPassView;
  /** Per-creator theming: the creator's photo strip, rendered by the page under the note. */
  gallery?: ReactNode;
}) {
  const [spinsRemaining, setSpinsRemaining] = useState(pass.spinsRemaining);
  const [result, setResult] = useState<WheelResult | null>(null);
  const [won, setWon] = useState<PublicPrize | null>(null);
  const [wonShareId, setWonShareId] = useState<string | null>(null);
  // Private values live only in this reveal's memory, never in win history.
  const [wonReward, setWonReward] = useState<DeliveredReward | null>(null);
  const [wonInstant, setWonInstant] = useState(false);
  const [focus, setFocus] = useState<FanFocusView | null>(pass.focus ?? null);
  const [odds, setOdds] = useState<FanOddsView | undefined>(pass.odds);
  const [chaseComplete, setChaseComplete] = useState(false);
  const recoveredWin = useRef(false);
  const [recoveredReveal, setRecoveredReveal] = useState(false);
  const awardedAt = useRef<string | null>(null);
  const [rewardHistoryNonce, setRewardHistoryNonce] = useState(0);
  const [busy, setBusy] = useState(false);
  // RM-1: the reveal runs as a small state machine (revealTiers.ts). It only
  // starts once /api/spin has returned, and reads nothing but that result.
  const [rv, dispatchReveal] = useReducer(revealReducer, REVEAL_IDLE);
  const reveal = rv.phase === "revealed";
  // Completed spins this browser session: tap-to-skip appears after the first.
  const [sessionSpins, setSessionSpins] = useState(() =>
    typeof window === "undefined" ? 0 : readSessionSpins()
  );
  const [nearMiss, setNearMiss] = useState<NearMiss | null>(null);
  const [pity, setPity] = useState<PublicPrize | null>(null);
  const [pityAwarded, setPityAwarded] = useState(false);
  // A beat (pity / near-miss) belongs to this reveal: keep its row above the
  // card reserved until the card closes, so the card never jumps.
  const [beatRow, setBeatRow] = useState(false);
  // RM-2: live stock. The spin response carries the wheel's stock after the
  // win; it is held until the wheel stops (showing it earlier would give the
  // result away) and then laid over the server-rendered prizes. A refreshed
  // payload (new prizes array) replaces it with the server's own counts.
  const pendingStock = useRef<Record<string, PublicStock> | null>(null);
  const [stockPatch, setStockPatch] = useState<{
    base: PublicPrize[];
    map: Record<string, PublicStock>;
  } | null>(null);
  const prizes = useMemo(
    () =>
      stockPatch && stockPatch.base === pass.wheel.prizes
        ? applyStockMap(pass.wheel.prizes, stockPatch.map)
        : pass.wheel.prizes,
    [stockPatch, pass.wheel.prizes]
  );
  const [error, setError] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const mutedRef = useRef(muted);
  useEffect(() => {
    mutedRef.current = muted;
  }, [muted]);
  const [localHistory, setHistory] = useState<WonPrize[]>(pass.recentWins);
  const history = useMemo(() => mergeFanWins(pass.recentWins, localHistory), [pass.recentWins, localHistory]);
  // Phase 5b: age-gate / ToS. Blocks everything until acknowledged.
  const [needsAck, setNeedsAck] = useState(pass.needsAck ?? false);
  // Commit-reveal: the server pre-committed the next spin's seed; we show its
  // hash so the fan can later verify the outcome wasn't picked after the fact.
  // The browser also contributes its own seed, mixed into the RNG server-side.
  const [nextSpinHash, setNextSpinHash] = useState<string | null>(
    pass.nextSpinHash ?? null
  );
  const router = useRouter();
  // Creator edits (prizes, colors, copy) are server-rendered into this page.
  // When the fan returns to an already-open tab, quietly re-fetch the server
  // payload so the wheel they see matches what the creator just published —
  // throttled, and never while a spin is in flight.
  const lastRefresh = useRef(0);
  useEffect(() => {
    lastRefresh.current = Date.now();
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastRefresh.current < 30000) return;
      lastRefresh.current = Date.now();
      router.refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [router]);

  const [clientSeed] = useState(() =>
    Array.from(crypto.getRandomValues(new Uint8Array(8)))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
  );
  const size = useWheelSize();

  // Track the previous spin count so we can fire the out-of-spins auto-message
  // exactly once on the 1→0 edge (a top-up later can re-arm it).
  const prevSpins = useRef(pass.spinsRemaining);
  const outroFired = useRef(false);
  // Failsafe: if the wheel animation's completion callback ever fails to fire
  // (tab backgrounded mid-spin, animation interrupted), `busy` would stay true
  // forever and the SPIN button would be dead until reload. The watchdog clears
  // it well after any normal spin should have finished.
  const spinWatchdog = useRef<ReturnType<typeof setTimeout> | null>(null);
  const spinEnded = useRef(true);
  // The latest handleSpinEnd, so the watchdog never runs a stale closure.
  const spinEndRef = useRef<() => void>(() => {});
  // Clear a pending watchdog on unmount so it can't setBusy() after the
  // component is gone (avoids a state-update-on-unmounted-component warning).
  useEffect(
    () => () => {
      if (spinWatchdog.current) clearTimeout(spinWatchdog.current);
    },
    []
  );

  // Canvas needs a real color string (it can't read the --brand CSS var).
  const brand = pass.wheel.brandColor ?? "#ec4899";
  // A fan who just paused their own link can no longer spin; no reload needed.
  const { paused } = useLinkPause();
  // RM-6: the fan's own play (counts + reminder) and their break. A break is
  // enforced by the server; here it turns SPIN off and says until when.
  const { breakUntil, onBreak, now, markOnBreak } = useFanBreak();
  const [play, setPlay] = useState(() => ({
    today: pass.play?.today ?? 0,
    week: pass.play?.week ?? 0,
    reminder: pass.play?.reminder ?? null,
  }));
  const [breather, setBreather] = useState(false);
  const breakEndLabel = breakUntil && now ? formatBreakEnd(breakUntil, now) : null;
  // RM-3: visual only. The check-in never touches spins, odds or the wheel,
  // and a fan on a break (RM-6) gets no glow nudges.
  const engaged = fanEngagementAllowed({ blocked: pass.blocked, selfExcluded: paused, breakUntil }, now);
  const { glow, milestone, dismissMilestone } = useVisitGlow(pass.token, pass.glow, engaged);
  const focusRevision = useRef(0);
  const refreshFocus = useCallback(async () => {
    // Read-only focus progress remains available during a break. A known
    // blocked/paused link must not send unsolicited requests that will fail.
    if (pass.blocked || paused) { setOdds(undefined); return; }
    const revision = focusRevision.current;
    try {
      const response = await fetch("/api/fan/focus", { method: "POST", headers: { "Content-Type": "application/json" },
        cache: "no-store", body: JSON.stringify({ token: pass.token }) });
      if (!response.ok) { setOdds(undefined); return; }
      const body = await response.json();
      if (revision !== focusRevision.current) return;
      setFocus(body.focus ?? null);
      setOdds(body.odds);
    } catch { setOdds(undefined); }
  }, [pass.token, pass.blocked, paused]);
  useEffect(() => {
    if (pass.blocked || paused) return;
    const boot = setTimeout(() => void refreshFocus(), 0);
    const visible = () => { if (document.visibilityState === "visible") void refreshFocus(); };
    const timer = setInterval(visible, 30000);
    document.addEventListener("visibilitychange", visible);
    return () => { clearTimeout(boot); clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, [refreshFocus, pass.focus, pass.odds, pass.blocked, paused]);

  const onCommitted = useCallback((data: SpinResult, options: { present: boolean; recovered: boolean }) => {
    focusRevision.current++;
    setSpinsRemaining(data.spinsRemaining);
    setFocus(data.focus ?? null);
    setOdds(data.odds);
    if (data.play) setPlay(p => ({ ...p, today: data.play!.today, week: data.play!.week }));
    if (typeof data.nextSpinHash === "string") setNextSpinHash(data.nextSpinHash);
    if (!options.present) return;
    setError(null);
    setRewardHistoryNonce(n => n + 1);
    recoveredWin.current = options.recovered;
    setRecoveredReveal(options.recovered);
    awardedAt.current = typeof data.awardedAt === "string" && Number.isFinite(Date.parse(data.awardedAt)) ? data.awardedAt : null;
    if (options.recovered) router.refresh();
    setChaseComplete(!options.recovered && data.chaseCompleted === true);
    setNearMiss(null); setPity(null); setBeatRow(false);
    setPityAwarded(!options.recovered && data.pityAwarded === true);
    spinEnded.current = false;
    dispatchReveal({ type: "start", rarity: data.prize.rarity,
      reducedMotion: options.recovered || prefersReducedMotion(), spinsBefore: sessionSpins });
    setBusy(false);
    setResult({ index: data.prizeIndex, nonce: Date.now() });
    setWon(data.prize);
    setWonShareId(typeof data.shareId === "string" ? data.shareId : null);
    setWonReward(parseDeliveredReward(data.reward));
    setWonInstant(data.reward !== undefined && data.reward !== null);
    pendingStock.current = data.stock ?? null;
    if (spinWatchdog.current) clearTimeout(spinWatchdog.current);
    spinWatchdog.current = setTimeout(() => {
      spinWatchdog.current = null;
      dispatchReveal({ type: "skip" });
      spinEndRef.current();
    }, SPIN_WATCHDOG_MS);
  }, [sessionSpins, router]);
  const onRefusal = useCallback((code: unknown) => {
    const info = spinErrorInfo(code);
    if (info.reopenAgeGate) setNeedsAck(true);
    if (info.refreshPlay) router.refresh();
    setBusy(false);
  }, [router]);
  const recovery = useSpinRecovery({ token: pass.token, canRetry: !paused && !onBreak && !needsAck,
    onCommitted, onRefusal });
  const spinPending = recovery.locked;
  const { canSpin, label: spinLabel, balanceLabel } = spinControl({
    spinsRemaining, busy: busy || recovery.sending || revealInFlight(rv.phase), paused, onBreak,
    spinPending: recovery.locked && recovery.phase !== "revealing" && recovery.phase !== "sending",
  });
  const runSpin = useCallback(async () => {
    if (!canSpin || recovery.locked) return;
    if (!muted) { unlockAudio(); haptic(12); }
    setError(null);
    setWonReward(null);
    await recovery.begin(clientSeed, nextSpinHash);
  }, [canSpin, recovery, muted, clientSeed, nextSpinHash]);

  // RM-6: once today's spins reach the fan's reminder, the next SPIN tap asks
  // first ("Want a breather?"), once per threshold per day. Soft: Keep playing
  // spins straight away.
  const handleSpin = useCallback(() => {
    if (!canSpin) return;
    if (play.reminder !== null && reminderDue(play.today, play.reminder) && !reminderAcked(play.reminder)) {
      setBreather(true);
      return;
    }
    void runSpin();
  }, [canSpin, play, runSpin]);

  // On the 1→0 spins transition (a spin that just emptied the balance), nudge
  // the fan via chat once. A later top-up (>0) re-arms the one-shot guard.
  useEffect(() => {
    const prev = prevSpins.current;
    if (spinsRemaining > 0) outroFired.current = false;
    if (prev > 0 && spinsRemaining === 0 && !outroFired.current && !paused && !onBreak && (!spinPending || recovery.phase === "revealing")) {
      outroFired.current = true;
      void fetch("/api/messages/auto-outro", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: pass.token }),
      }).catch(() => {});
    }
    prevSpins.current = spinsRemaining;
  }, [spinsRemaining, pass.token, paused, onBreak, spinPending, recovery.phase]);

  // Bumped after every completed spin so the leaderboard + recent-wins ticker
  // refetch immediately — the fan sees their rank move without a reload.
  const [boardRefresh, setBoardRefresh] = useState(0);

  const handleSpinEnd = useCallback(() => {
    // Once per spin: the watchdog and the wheel can both report the end.
    if (spinEnded.current) return;
    spinEnded.current = true;
    if (spinWatchdog.current) {
      clearTimeout(spinWatchdog.current);
      spinWatchdog.current = null;
    }
    setBusy(false);
    setBoardRefresh((n) => n + 1);
    if (!recoveredWin.current) setSessionSpins(bumpSessionSpins(sessionSpins));
    if (won) {
      if (!muted && !recoveredWin.current) {
        playWin(won.rarity);
        if (rv.tier) haptic(rv.tier.haptic);
      }
      setHistory((h) =>
        wonShareId && h.some(item => item.shareId === wonShareId) ? h : [
          {
            label: won.label,
            rarity: won.rarity,
            emoji: won.emoji,
            color: won.color ?? RARITY_COLORS[won.rarity],
            at: awardedAt.current ?? new Date().toISOString(),
            ...(wonShareId ? { shareId: wonShareId } : {}),
            ...(wonInstant ? { instant: true } : {}),
            imageUrl: won.imageUrl,
          },
          ...h.filter(item => !wonShareId || item.shareId !== wonShareId),
        ].slice(0, 50)
      );
      // Pity beat takes precedence: a pity-forced spin is a *real win*, so we
      // celebrate it and never show the "So close!" near-miss alongside it.
      if (pityAwarded) {
        setPity(won);
        setBeatRow(true);
      } else if (result && !recoveredWin.current && !chaseComplete) {
        // Near-miss beat: did the wheel stop one slice away from a legendary
        // (or epic) prize? Derived from the landed slice index + wheel order,
        // using the stock the fan saw while spinning (a sold-out neighbour
        // had 0% odds, so it is never a near miss).
        const miss = detectNearMiss(prizes, result.index);
        setNearMiss(miss);
        if (miss) setBeatRow(true);
      }
    }
    // The wheel has stopped: now the counts may move (RM-2).
    if (pendingStock.current) {
      setStockPatch({ base: pass.wheel.prizes, map: pendingStock.current });
      pendingStock.current = null;
    }
    // Opens the card now, or after the tier's short hold on the landed slice.
    dispatchReveal({ type: "stop" });
  }, [won, wonShareId, wonInstant, muted, result, prizes, pass.wheel.prizes, pityAwarded, sessionSpins, rv.tier, chaseComplete]);
  useEffect(() => {
    spinEndRef.current = handleSpinEnd;
  }, [handleSpinEnd]);

  // The build-up (epic/legendary by default) starts ~1s before the stop.
  const handleNearStop = useCallback(() => {
    dispatchReveal({ type: "nearStop" });
    if (!mutedRef.current && !recoveredWin.current && rv.tier?.buildUp) playBuildUp(rv.tier.buildUpSound);
  }, [rv.tier]);

  // Hold on the landed slice (spotlight/burst) before the card opens.
  useEffect(() => {
    if (rv.phase !== "landed" || !rv.tier) return;
    const t = setTimeout(() => dispatchReveal({ type: "beatDone" }), rv.tier.stopBeatMs);
    return () => clearTimeout(t);
  }, [rv.phase, rv.tier]);

  const skipAvailable = canSkip({
    phase: rv.phase,
    skipped: rv.skipped,
    spinsBefore: rv.spinsBefore,
    reducedMotion: rv.tier?.animate === false,
  });
  const skipReveal = useCallback(() => dispatchReveal({ type: "skip" }), []);
  useEffect(() => {
    if (!skipAvailable || !SKIP_ON_ESCAPE) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") skipReveal();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [skipAvailable, skipReveal]);
  const theaterOn = theaterVisible(rv);
  const spotlight =
    rv.tier && result && (rv.phase === "landed" || rv.phase === "revealed")
      ? { index: result.index, dim: rv.tier.spotlightDim }
      : null;

  return (
    <div className="flex w-full max-w-md flex-col items-center gap-7">
      <header className="reveal text-center" style={{ animationDelay: "0.05s" }}>
        {pass.fanName && (
          <p className="mb-2 text-xs font-medium uppercase tracking-[0.18em] text-muted">
            {pass.creatorTitle} · for {pass.fanName}
          </p>
        )}
        <h1 className="font-[family-name:var(--font-display)] text-[2.1rem] font-extrabold leading-[1.05] tracking-tight text-ink text-balance">
          {pass.wheel.title}
        </h1>
        {pass.wheel.subtitle && (
          <p className="mx-auto mt-2 max-w-xs text-sm text-muted text-pretty">
            {pass.wheel.subtitle}
          </p>
        )}
      </header>

      <CreatorNote
        creatorTitle={pass.creatorTitle}
        note={pass.creatorNote}
        avatarUrl={pass.creatorAvatarUrl}
        fanName={pass.fanName}
        glowLevel={glow?.level}
      />

      {gallery}

      {engaged && pass.leaderboardEnabled && pass.creatorId && (
        <RecentWinsTicker creatorId={pass.creatorId} refreshKey={boardRefresh} />
      )}

      {pass.happyHour && <HappyHourBanner status={pass.happyHour} />}

      {/* Wheel with a soft brand halo behind it for depth. */}
      <div
        className={`reveal-scale relative flex items-center justify-center${theaterOn ? " z-[41]" : ""}`}
        style={{ animationDelay: "0.15s" }}
      >
        <div
          aria-hidden
          className="ambient-glow pointer-events-none absolute h-[106%] w-[106%] rounded-full blur-2xl"
          style={{
            // Sized to the visible halo (closest-side: it fades out at the box
            // edge) so the layout box, even at the pulse's 1.05 scale peak,
            // stays inside the viewport on narrow phones.
            background:
              "radial-gradient(circle closest-side, color-mix(in oklab, var(--brand) 38%, transparent), transparent)",
          }}
        />
        <div className="relative">
          {rv.tier && rv.phase !== "idle" && (
            <WheelAura key={result?.nonce} tier={rv.tier} phase={rv.phase} />
          )}
          <Wheel
            prizes={pass.wheel.prizes}
            brandColor={brand}
            labelColor={pass.wheel.labelColor}
            labelSize={pass.wheel.labelSize}
            result={result}
            onSpinEnd={handleSpinEnd}
            size={size}
            muted={muted || recoveredReveal}
            tier={rv.tier}
            onNearStop={handleNearStop}
            skip={rv.skipped}
            spotlight={spotlight}
          />
        </div>
      </div>

      <div className="lift-in flex w-full flex-col items-center gap-4" style={{ animationDelay: "0.25s", animationFillMode: "both" }}>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <div
            data-testid="spins-chip"
            data-glow-level={glow?.level ?? 0}
            className={`rounded-full border border-line bg-surface/70 px-4 py-1.5 text-sm font-medium text-ink${glowClass(glow?.level)}`}
          >
            Spins left{" "}
            <span className="tnum ml-1 font-bold text-brand">
              {balanceLabel}
            </span>
          </div>
          <button
            onClick={() => setMuted((m) => !m)}
            className="rounded-full border border-line bg-surface/70 px-3 py-1.5 text-sm text-muted transition hover:text-ink"
            aria-label={muted ? "Unmute" : "Mute"}
            title={muted ? "Unmute" : "Mute"}
          >
            {muted ? "🔇 Muted" : "🔊 Sound on"}
          </button>
          <GlowTag glow={glow} />
        </div>

        <YourPlay
          token={pass.token}
          play={play}
          onReminderChange={(reminder) => setPlay((p) => ({ ...p, reminder }))}
          onBreak={onBreak}
          breakEndLabel={breakEndLabel}
          onBreakTaken={markOnBreak}
        />

        <FocusChip focus={focus} onBreak={onBreak} />

        <button
          data-testid="fan-spin"
          onClick={handleSpin}
          disabled={!canSpin || recovery.locked}
          className="btn-brand w-full rounded-2xl py-4 text-lg font-extrabold tracking-wide focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand)]"
        >
          {spinLabel}
        </button>

        {paused && (
          <p role="status" className="text-center text-sm text-muted">
            Your link is paused. Ask your creator for a new link to play again.
          </p>
        )}
        {onBreak && !paused && (
          <p role="status" data-testid="break-status" className="text-center text-sm text-muted text-pretty">
            {breakStatus(breakEndLabel)}
          </p>
        )}

        {error && (
          <p role="alert" className="text-center text-sm text-amber-300">
            {error}
          </p>
        )}
        {recovery.message && <p role="status" data-testid="spin-recovery-status" className="text-center text-sm text-muted">{recovery.message}</p>}
        {recovery.phase === "pending" && <div className="flex w-full flex-wrap justify-center gap-3" data-testid="spin-recovery-controls">
          <button type="button" onClick={() => void recovery.check()} data-testid="spin-recovery-check"
            className="min-h-11 rounded-xl border border-line px-4 py-2 font-semibold text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand-text)]">Check this spin</button>
          <button type="button" onClick={() => void recovery.retry()} disabled={paused || onBreak || needsAck}
            data-testid="spin-recovery-retry" className="min-h-11 rounded-xl border border-line px-4 py-2 font-semibold text-ink disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand-text)]">Retry this same spin</button>
        </div>}
        {recovery.phase === "storage" && <button type="button" onClick={() => void recovery.initialize()}
          data-testid="spin-storage-check" className="min-h-11 rounded-xl border border-line px-4 py-2 text-sm font-semibold text-ink">Check browser storage</button>}
        {nextSpinHash && (
          <p
            className="flex w-full min-w-0 flex-wrap items-center justify-center gap-x-1 text-center text-[10px] tracking-wide text-muted"
            title="The server committed to your next spin's random seed before you spin — after spinning, the verify page proves the outcome matches this commitment."
          >
            <span className="whitespace-nowrap">🔒 Provably fair · next-spin commitment</span>
            <span
              className="min-w-0 max-w-full break-all font-mono"
              title={nextSpinHash}
            >
              {nextSpinHash.slice(0, 12)}…
            </span>
          </p>
        )}
        {spinsRemaining === 0 && !reveal && !paused && !onBreak && !spinPending && (
          <TopUpMoment
            prizes={prizes}
            history={history}
            creatorTitle={pass.creatorTitle}
            tipUrl={pass.tipUrl}
          />
        )}
        <InstallNudge armed={reveal && won !== null && engaged} />
      </div>

      <LimitedStockRow prizes={prizes} />

      <WinsGallery key={pass.token} history={history} token={pass.token} historyNonce={rewardHistoryNonce} />

      <PrizeBook prizes={prizes} history={history} focus={focus} odds={pass.blocked || paused ? undefined : odds} />

      {engaged && pass.leaderboardEnabled && pass.creatorId && (
        <FanLeaderboard
          key={`board:${pass.token}:${pass.leaderboardOptIn === true}`}
          onWithdrawn={() => router.refresh()}
          creatorId={pass.creatorId}
          token={pass.token}
          optedIn={pass.leaderboardOptIn === true}
          // Only the fan's chosen board handle — never pre-fill their real name,
          // since whatever is here is what gets published if they join.
          youHandle={pass.fanHandle ?? null}
          refreshKey={boardRefresh}
        />
      )}

      {!(engaged && pass.leaderboardEnabled && pass.creatorId) && pass.leaderboardOptIn === true && (
        <LeaderboardWithdrawal key={`leaderboard-withdraw:${pass.token}`} token={pass.token} onWithdrawn={() => router.refresh()} />
      )}

      <WishlistSection
        token={pass.token}
        prizes={pass.wheel.prizes}
        initial={pass.wishlist ?? []}
      />


      <ChatPanel
        token={pass.token}
        unlocked={pass.chatUnlocked ?? false}
        creatorTitle={pass.creatorTitle}
      />

      {theaterOn && rv.tier && (
        <RevealTheater
          tier={rv.tier}
          onTap={SKIP_ON_BACKDROP_TAP && skipAvailable ? skipReveal : undefined}
        />
      )}

      {skipAvailable && (
        <div className="pointer-events-none fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+5.5rem)] z-[42] flex justify-center px-5">
          <button
            type="button"
            onClick={skipReveal}
            data-testid="reveal-skip"
            className="pointer-events-auto rounded-full border border-line bg-surface/90 px-5 py-2.5 text-sm font-semibold text-ink shadow-lg backdrop-blur-sm transition hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand)]"
          >
            Skip <span aria-hidden="true">›</span>
          </button>
        </div>
      )}

      {reveal && won && rv.tier && (
        <RewardReveal
          prize={won}
          tier={rv.tier}
          shareId={wonShareId}
          instant={wonInstant}
          extra={wonReward ? <InstantReward reward={wonReward} /> : wonInstant ? <RewardUnavailable /> : undefined}
          entrance={revealEntrance(rv)}
          confetti={revealConfetti(rv)}
          // The beats accompany the card: they open with it, in the row above
          // it (never over it), and go when it closes. Pity still wins over a
          // near miss (handleSpinEnd sets only one of them).
          bannerSpace={beatRow || chaseComplete}
          banner={
            chaseComplete ? (
              <p role="status" data-testid="chase-complete" className="rounded-xl border border-line bg-surface px-4 py-3 text-center font-semibold text-ink">Chase complete! You won your selected prize.</p>
            ) : pity ? (
              <PityBeat prize={pity} onDone={() => setPity(null)} />
            ) : nearMiss ? (
              <NearMissBeat nearMiss={nearMiss} onDone={() => setNearMiss(null)} />
            ) : null
          }
          onClose={() => {
            dispatchReveal({ type: "close" });
            setPity(null);
            setNearMiss(null);
            setBeatRow(false);
            setWonReward(null);
            setChaseComplete(false);
            void recovery.acknowledge();
          }}
        />
      )}

      {breather && play.reminder !== null && (
        <BreatherCard
          token={pass.token}
          today={play.today}
          onClose={() => setBreather(false)}
          onKeepPlaying={() => {
            if (play.reminder !== null) ackReminder(play.reminder);
            setBreather(false);
            void runSpin();
          }}
          onBreakTaken={(until) => {
            markOnBreak(until);
            setBreather(false);
          }}
        />
      )}
      <GlowMilestoneToast milestone={milestone} creatorTitle={pass.creatorTitle} onDone={dismissMilestone} />

      {needsAck && (
        <AgeGate
          token={pass.token}
          creatorTitle={pass.creatorTitle}
          onAck={() => setNeedsAck(false)}
        />
      )}
    </div>
  );
}

/**
 * A blocking age + terms gate shown over the whole page until the fan confirms
 * they're 18+ and accepts the terms. On confirm we persist the acknowledgement
 * (POST /api/fans/ack) and dismiss locally so the fan can spin.
 */
function AgeGate({
  token,
  creatorTitle,
  onAck,
}: {
  token: string;
  creatorTitle: string;
  onAck: () => void;
}) {
  const [adult, setAdult] = useState(false);
  const [terms, setTerms] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = adult && terms && !busy;
  const firstRef = useRef<HTMLInputElement>(null);

  // A11y: this gate is blocking, so move focus into it on open and trap Tab so
  // keyboard users can't step *past* it onto the page behind (which would let
  // them bypass age verification). Intentionally non-dismissable: no
  // Escape-to-close, so the gate can't be bypassed.
  const dialogRef = useFocusTrap<HTMLDivElement>({ active: true, initialFocus: firstRef });

  const confirm = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/fans/ack", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(ackErrorMessage(body?.error));
        setBusy(false);
        return;
      }
      onAck();
    } catch {
      // Keep the gate open so the fan can retry; dismissing here would just
      // bounce them back with needs_ack on the next spin.
      setError(ackErrorMessage(undefined));
      setBusy(false);
    }
  };

  return (
    <div
      ref={dialogRef}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/85 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="agegate-title"
      style={{ animation: "ff-fade 0.2s ease-out" }}
    >
      <div className="card relative w-full max-w-sm rounded-[1.75rem] p-8">
        <div className="text-center">
          <div className="text-4xl">🔞</div>
          <h2
            id="agegate-title"
            className="mt-3 font-[family-name:var(--font-display)] text-xl font-extrabold text-ink"
          >
            Before you spin
          </h2>
          <p className="mt-2 text-sm text-muted text-pretty">
            {creatorTitle} requires you to confirm your age and agree to the
            terms before playing.
          </p>
        </div>

        <div className="mt-6 space-y-3 text-left text-sm">
          <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-line p-3">
            <input
              ref={firstRef}
              type="checkbox"
              checked={adult}
              onChange={(e) => setAdult(e.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--brand)]"
            />
            <span className="text-ink">I am 18 years of age or older.</span>
          </label>
          <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-line p-3">
            <input
              type="checkbox"
              checked={terms}
              onChange={(e) => setTerms(e.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--brand)]"
            />
            <span className="text-ink">
              I agree to the{" "}
              <a href="/terms" target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
                Terms of Service
              </a>{" "}
              (see the{" "}
              <a href="/privacy" target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
                Privacy Policy
              </a>
              ) and acknowledge prizes are subject to the creator&rsquo;s fulfilment.
            </span>
          </label>
        </div>

        {error && (
          <p role="alert" className="mt-4 text-center text-sm text-amber-300">
            {error}
          </p>
        )}

        <button
          onClick={confirm}
          disabled={!ready}
          className="btn-brand mt-6 w-full rounded-2xl py-3.5 font-extrabold tracking-wide disabled:opacity-40"
        >
          {busy ? "Confirming…" : "Enter & spin"}
        </button>
      </div>
      <style>{`
        @keyframes ff-fade { from { opacity: 0 } to { opacity: 1 } }
      `}</style>
    </div>
  );
}
