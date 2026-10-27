"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import Wheel, { type WheelResult } from "./Wheel";
import type { FanPassView, WonPrize } from "@/lib/data/types";
import type { PublicPrize, PublicStock } from "@/lib/games/wheel/types";
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
import FanLeaderboard from "./fan/FanLeaderboard";
import CreatorNote from "./fan/CreatorNote";
import PrizeBook from "./fan/PrizeBook";
import LimitedStockRow from "./fan/LimitedStockRow";
import RecentWinsTicker from "./fan/RecentWinsTicker";
import WinsGallery from "./fan/WinsGallery";
import { useLinkPause } from "./fan/LinkPauseProvider";
import { useVisitGlow } from "./fan/useVisitGlow";
import { GlowMilestoneToast, GlowTag, glowClass } from "./fan/VisitGlow";
import { spinControl } from "./fan/linkPause";

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

export default function SpinClient({ pass }: { pass: FanPassView }) {
  const [spinsRemaining, setSpinsRemaining] = useState(pass.spinsRemaining);
  const [result, setResult] = useState<WheelResult | null>(null);
  const [won, setWon] = useState<PublicPrize | null>(null);
  const [wonShareId, setWonShareId] = useState<string | null>(null);
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
  const [history, setHistory] = useState<WonPrize[]>(pass.recentWins);
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
  // RM-3: visual only. The check-in never touches spins, odds or the wheel.
  const { glow, milestone, dismissMilestone } = useVisitGlow(pass.token, pass.glow, !paused);
  const { canSpin, label: spinLabel, balanceLabel } = spinControl({
    spinsRemaining,
    busy: busy || revealInFlight(rv.phase),
    paused,
  });

  const handleSpin = useCallback(async () => {
    if (!canSpin) return;
    // iOS: wake the audio context inside the tap so the win fanfare can play,
    // and fire a haptic tick. Haptics follow the same mute switch as sound.
    if (!muted) {
      unlockAudio();
      haptic(12);
    }
    setBusy(true);
    setError(null);
    setWon(null);
    setNearMiss(null);
    setPity(null);
    setPityAwarded(false);
    setBeatRow(false);
    pendingStock.current = null;
    try {
      const res = await fetch("/api/spin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: pass.token, clientSeed }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const info = spinErrorInfo(body.error);
        setError(info.message);
        if (info.reopenAgeGate) setNeedsAck(true);
        setBusy(false);
        return;
      }
      const data = await res.json();
      const prize: PublicPrize = data.prize;
      setSpinsRemaining(data.spinsRemaining);
      // The outcome is final here; the theater only presents its rarity.
      spinEnded.current = false;
      dispatchReveal({
        type: "start",
        rarity: prize.rarity,
        reducedMotion: prefersReducedMotion(),
        spinsBefore: sessionSpins,
      });
      setBusy(false);
      setResult({ index: data.prizeIndex, nonce: Date.now() });
      setWon(prize);
      setWonShareId(typeof data.shareId === "string" ? data.shareId : null);
      setPityAwarded(data.pityAwarded === true);
      pendingStock.current =
        data.stock && typeof data.stock === "object" ? (data.stock as Record<string, PublicStock>) : null;
      if (typeof data.nextSpinHash === "string") setNextSpinHash(data.nextSpinHash);
      // Arm the stuck-spin watchdog (cleared by handleSpinEnd on normal
      // finish). If the wheel's completion never fires, land on the result as
      // a skip would, so the button can't stay dead and the win isn't lost.
      if (spinWatchdog.current) clearTimeout(spinWatchdog.current);
      spinWatchdog.current = setTimeout(() => {
        spinWatchdog.current = null;
        dispatchReveal({ type: "skip" });
        spinEndRef.current();
      }, SPIN_WATCHDOG_MS);
    } catch {
      setError("Network error. Try again.");
      setBusy(false);
    }
  }, [canSpin, pass.token, muted, clientSeed, sessionSpins]);

  // On the 1→0 spins transition (a spin that just emptied the balance), nudge
  // the fan via chat once. A later top-up (>0) re-arms the one-shot guard.
  useEffect(() => {
    const prev = prevSpins.current;
    if (spinsRemaining > 0) outroFired.current = false;
    if (prev > 0 && spinsRemaining === 0 && !outroFired.current) {
      outroFired.current = true;
      void fetch("/api/messages/auto-outro", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: pass.token }),
      }).catch(() => {});
    }
    prevSpins.current = spinsRemaining;
  }, [spinsRemaining, pass.token]);

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
    setSessionSpins(bumpSessionSpins(sessionSpins));
    if (won) {
      if (!muted) {
        playWin(won.rarity);
        if (rv.tier) haptic(rv.tier.haptic);
      }
      setHistory((h) =>
        [
          {
            label: won.label,
            rarity: won.rarity,
            emoji: won.emoji,
            color: won.color ?? RARITY_COLORS[won.rarity],
            at: new Date().toISOString(),
          },
          ...h,
        ].slice(0, 50)
      );
      // Pity beat takes precedence: a pity-forced spin is a *real win*, so we
      // celebrate it and never show the "So close!" near-miss alongside it.
      if (pityAwarded) {
        setPity(won);
        setBeatRow(true);
      } else if (result) {
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
  }, [won, muted, result, prizes, pass.wheel.prizes, pityAwarded, sessionSpins, rv.tier]);
  useEffect(() => {
    spinEndRef.current = handleSpinEnd;
  }, [handleSpinEnd]);

  // The build-up (epic/legendary by default) starts ~1s before the stop.
  const handleNearStop = useCallback(() => {
    dispatchReveal({ type: "nearStop" });
    if (!mutedRef.current && rv.tier?.buildUp) playBuildUp(rv.tier.buildUpSound);
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

      {pass.leaderboardEnabled && pass.creatorId && (
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
            muted={muted}
            tier={rv.tier}
            onNearStop={handleNearStop}
            skip={rv.skipped}
            spotlight={spotlight}
          />
        </div>
      </div>

      <div className="reveal flex w-full flex-col items-center gap-4" style={{ animationDelay: "0.25s" }}>
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

        <button
          onClick={handleSpin}
          disabled={!canSpin}
          className="btn-brand w-full rounded-2xl py-4 text-lg font-extrabold tracking-wide focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand)]"
        >
          {spinLabel}
        </button>

        {paused && (
          <p role="status" className="text-center text-sm text-muted">
            Your link is paused. Ask your creator for a new link to play again.
          </p>
        )}

        {error && (
          <p role="alert" className="text-center text-sm text-amber-300">
            {error}
          </p>
        )}
        {nextSpinHash && (
          <p
            className="flex w-full min-w-0 flex-wrap items-center justify-center gap-x-1 text-center text-[10px] tracking-wide text-muted/60"
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
        {spinsRemaining === 0 && !reveal && !paused && (
          <TopUpMoment
            prizes={prizes}
            history={history}
            creatorTitle={pass.creatorTitle}
            tipUrl={pass.tipUrl}
          />
        )}
        <InstallNudge armed={reveal && won !== null} />
      </div>

      <LimitedStockRow prizes={prizes} />

      <WinsGallery history={history} />

      <PrizeBook prizes={prizes} history={history} />

      {pass.leaderboardEnabled && pass.creatorId && (
        <FanLeaderboard
          creatorId={pass.creatorId}
          token={pass.token}
          optedIn={pass.leaderboardOptIn === true}
          // Only the fan's chosen board handle — never pre-fill their real name,
          // since whatever is here is what gets published if they join.
          youHandle={pass.fanHandle ?? null}
          refreshKey={boardRefresh}
        />
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
          entrance={revealEntrance(rv)}
          confetti={revealConfetti(rv)}
          // The beats accompany the card: they open with it, in the row above
          // it (never over it), and go when it closes. Pity still wins over a
          // near miss (handleSpinEnd sets only one of them).
          bannerSpace={beatRow}
          banner={
            pity ? (
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
