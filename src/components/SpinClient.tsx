"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import Wheel, { type WheelResult } from "./Wheel";
import type { FanPassView, WonPrize } from "@/lib/data/types";
import type { Prize } from "@/lib/games/wheel/types";
import { RARITY_COLORS, RARITY_LABEL } from "@/lib/games/wheel/types";
import { brandVars } from "@/lib/theme";
import { useFocusTrap } from "@/lib/hooks/useFocusTrap";
import { copyToClipboard } from "@/lib/hooks/useClipboard";
import { playWin, unlockAudio, haptic, prefersReducedMotion } from "@/lib/sound";
import { detectNearMiss, type NearMiss } from "./fan/nearMiss";
// Both beats pull in the motion library and only render briefly after a spin,
// so defer them off the fan page's initial bundle.
const NearMissBeat = dynamic(() => import("./NearMissBeat"), { ssr: false });
const PityBeat = dynamic(() => import("./PityBeat"), { ssr: false });
import HappyHourBanner from "./fan/HappyHourBanner";
import WishlistSection from "./fan/WishlistSection";
import ChatPanel from "./fan/ChatPanel";
import TopUpMoment from "./fan/TopUpMoment";
import FanLeaderboard from "./fan/FanLeaderboard";
import CreatorNote from "./fan/CreatorNote";
import PrizeBook from "./fan/PrizeBook";
import RecentWinsTicker from "./fan/RecentWinsTicker";
import WinsGallery from "./fan/WinsGallery";

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
  const [won, setWon] = useState<Prize | null>(null);
  const [wonShareId, setWonShareId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reveal, setReveal] = useState(false);
  const [nearMiss, setNearMiss] = useState<NearMiss | null>(null);
  const [pity, setPity] = useState<Prize | null>(null);
  const [pityAwarded, setPityAwarded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
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
  const canSpin = spinsRemaining > 0 && !busy;

  const handleSpin = useCallback(async () => {
    if (!canSpin) return;
    // iOS: wake the audio context inside the tap so the win fanfare can play,
    // and fire a haptic tick (works even on silent mode).
    if (!muted) unlockAudio();
    haptic(12);
    setBusy(true);
    setError(null);
    setReveal(false);
    setWon(null);
    setNearMiss(null);
    setPity(null);
    setPityAwarded(false);
    try {
      const res = await fetch("/api/spin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: pass.token, clientSeed }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(
          body.error === "no_spins"
            ? "You're out of spins! Tip your creator to get more. 💖"
            : body.error === "rate_limited"
              ? "Whoa, slow down a sec — try again in a moment. 😅"
              : body.error === "blocked"
                ? "This link isn't active. Reach out to your creator."
                : "Something went wrong. Try again."
        );
        setBusy(false);
        return;
      }
      const data = await res.json();
      const prize: Prize = data.prize;
      setSpinsRemaining(data.spinsRemaining);
      setResult({ index: data.prizeIndex, nonce: Date.now() });
      setWon(prize);
      setWonShareId(typeof data.shareId === "string" ? data.shareId : null);
      setPityAwarded(data.pityAwarded === true);
      if (typeof data.nextSpinHash === "string") setNextSpinHash(data.nextSpinHash);
      // Arm the stuck-spin watchdog (cleared by handleSpinEnd on normal finish).
      if (spinWatchdog.current) clearTimeout(spinWatchdog.current);
      spinWatchdog.current = setTimeout(() => {
        spinWatchdog.current = null;
        setBusy(false);
      }, 9000);
    } catch {
      setError("Network error. Try again.");
      setBusy(false);
    }
  }, [canSpin, pass.token, muted, clientSeed]);

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
    if (spinWatchdog.current) {
      clearTimeout(spinWatchdog.current);
      spinWatchdog.current = null;
    }
    setBusy(false);
    setReveal(true);
    setBoardRefresh((n) => n + 1);
    if (won) {
      if (!muted) playWin(won.rarity);
      haptic(won.rarity === "legendary" || won.rarity === "epic" ? [18, 40, 18] : 16);
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
      } else if (result) {
        // Near-miss beat: did the wheel stop one slice away from a legendary
        // (or epic) prize? Derived from the landed slice index + wheel order.
        setNearMiss(detectNearMiss(pass.wheel.prizes, result.index));
      }
    }
  }, [won, muted, result, pass.wheel.prizes, pityAwarded]);

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
      />

      {pass.leaderboardEnabled && pass.creatorId && (
        <RecentWinsTicker creatorId={pass.creatorId} refreshKey={boardRefresh} />
      )}

      {pass.happyHour && <HappyHourBanner status={pass.happyHour} />}

      {/* Wheel with a soft brand halo behind it for depth. */}
      <div className="reveal-scale relative flex items-center justify-center" style={{ animationDelay: "0.15s" }}>
        <div
          aria-hidden
          className="ambient-glow pointer-events-none absolute h-[115%] w-[115%] rounded-full blur-2xl"
          style={{
            background:
              "radial-gradient(circle, color-mix(in oklab, var(--brand) 38%, transparent), transparent 65%)",
          }}
        />
        <div className="relative">
          <Wheel
            prizes={pass.wheel.prizes}
            brandColor={brand}
            labelColor={pass.wheel.labelColor}
            labelSize={pass.wheel.labelSize}
            result={result}
            onSpinEnd={handleSpinEnd}
            size={size}
            muted={muted}
          />
        </div>
      </div>

      <div className="reveal flex w-full flex-col items-center gap-4" style={{ animationDelay: "0.25s" }}>
        <div className="flex items-center gap-2">
          <div className="rounded-full border border-line bg-surface/70 px-4 py-1.5 text-sm font-medium text-ink">
            Spins left{" "}
            <span className="tnum ml-1 font-bold text-brand">
              {spinsRemaining}
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
        </div>

        <button
          onClick={handleSpin}
          disabled={!canSpin}
          className="btn-brand w-full rounded-2xl py-4 text-lg font-extrabold tracking-wide focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand)]"
        >
          {busy ? "Spinning…" : spinsRemaining > 0 ? "SPIN" : "Out of spins"}
        </button>

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
        {spinsRemaining === 0 && !reveal && (
          <TopUpMoment
            prizes={pass.wheel.prizes}
            history={history}
            creatorTitle={pass.creatorTitle}
            tipUrl={pass.tipUrl}
          />
        )}
      </div>

      <WinsGallery history={history} />

      <PrizeBook prizes={pass.wheel.prizes} history={history} />

      {pass.leaderboardEnabled && pass.creatorId && (
        <FanLeaderboard
          creatorId={pass.creatorId}
          youHandle={pass.fanHandle ?? (pass.fanName ?? "").trim().split(/\s+/)[0] ?? null}
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

      {reveal && won && (
        <PrizeModal
          prize={won}
          shareId={wonShareId}
          onClose={() => setReveal(false)}
        />
      )}

      {pity && (
        <PityBeat prize={pity} onDone={() => setPity(null)} />
      )}

      {nearMiss && (
        <NearMissBeat
          nearMiss={nearMiss}
          onDone={() => setNearMiss(null)}
        />
      )}

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
    try {
      await fetch("/api/fans/ack", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
    } catch {
      /* best-effort — dismiss anyway so the fan isn't stuck */
    } finally {
      onAck();
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
              I agree to the Terms of Service and acknowledge prizes are subject
              to the creator&rsquo;s fulfilment.
            </span>
          </label>
        </div>

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

function PrizeModal({
  prize,
  shareId,
  onClose,
}: {
  prize: Prize;
  shareId: string | null;
  onClose: () => void;
}) {
  const color = prize.color ?? RARITY_COLORS[prize.rarity];
  const isBig = prize.rarity === "epic" || prize.rarity === "legendary";
  const [shared, setShared] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);

  // A11y: focus the primary action on open, close on Escape, and trap Tab
  // within the dialog so keyboard/screen-reader users aren't stranded behind it.
  const dialogRef = useFocusTrap<HTMLDivElement>({
    active: true,
    onEscape: onClose,
    initialFocus: closeRef,
  });

  const share = async () => {
    if (!shareId) return;
    const url = `${window.location.origin}/share/${shareId}`;
    const text = `I just won ${prize.label}! 🎉`;
    try {
      if (navigator.share) {
        await navigator.share({ title: prize.label, text, url });
      } else if (await copyToClipboard(url)) {
        setShared(true);
        setTimeout(() => setShared(false), 1500);
      }
    } catch {
      /* user cancelled or share unavailable */
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm"
      onClick={onClose}
      style={{ animation: "ff-fade 0.2s ease-out" }}
    >
      {isBig && <Confetti />}
      {/* Screen-reader announcement — the visual modal is decorative for AT. */}
      <p className="sr-only" role="status" aria-live="assertive">
        You won {prize.label}, a {RARITY_LABEL[prize.rarity]} prize.
      </p>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={`You won ${prize.label}`}
        className="card relative w-full max-w-sm rounded-[1.75rem] p-8 text-center"
        style={{
          boxShadow: `0 30px 80px -20px color-mix(in oklab, ${color} 50%, transparent)`,
          borderColor: `color-mix(in oklab, ${color} 55%, transparent)`,
          animation: "ff-pop 0.32s cubic-bezier(0.18,0.9,0.3,1.2)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <span
          className="inline-block rounded-full px-3 py-1 text-[11px] font-bold uppercase tracking-[0.14em] text-white"
          style={{ backgroundColor: color }}
        >
          {RARITY_LABEL[prize.rarity]}
        </span>
        {/* Rarity medallion — a tinted gradient halo behind the emoji so
            photoless wins still feel premium, scaled up for epic/legendary. */}
        <div
          className="mx-auto my-6 grid place-items-center rounded-full"
          style={{
            width: isBig ? 132 : 112,
            height: isBig ? 132 : 112,
            background: `radial-gradient(circle at 50% 35%, color-mix(in oklab, ${color} 45%, transparent), color-mix(in oklab, ${color} 12%, transparent) 70%)`,
            boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${color} 45%, transparent), 0 12px 40px -12px color-mix(in oklab, ${color} 60%, transparent)`,
          }}
        >
          <span style={{ fontSize: isBig ? 64 : 52 }}>{prize.emoji ?? "🎁"}</span>
        </div>
        <h2 className="font-[family-name:var(--font-display)] text-2xl font-extrabold text-ink text-balance">
          {prize.label}
        </h2>
        {prize.description && (
          <p className="mt-2 text-sm text-muted text-pretty">{prize.description}</p>
        )}
        <p className="mt-5 text-sm text-muted">
          Screenshot this and send it to your creator to claim your prize!
        </p>
        {shareId && (
          <button
            onClick={share}
            className="mt-6 w-full rounded-2xl border py-3 font-semibold text-ink transition hover:brightness-110"
            style={{ borderColor: color }}
          >
            {shared ? "Link copied!" : "Share your win ↗"}
          </button>
        )}
        <button
          ref={closeRef}
          onClick={onClose}
          className="btn-brand mt-3 w-full rounded-2xl py-3 font-bold"
          style={brandVars(color)}
        >
          Awesome!
        </button>
      </div>
      <style>{`
        @keyframes ff-fade { from { opacity: 0 } to { opacity: 1 } }
        @keyframes ff-pop { from { opacity: 0; transform: translateY(12px) scale(0.94) } to { opacity: 1; transform: none } }
      `}</style>
    </div>
  );
}

// Lightweight CSS confetti — no dependency. Skipped entirely for users who
// prefer reduced motion (70 full-viewport moving elements is a vestibular risk).
function Confetti() {
  const reduce = prefersReducedMotion();
  const [pieces] = useState(() =>
    Array.from({ length: 70 }, (_, i) => ({
      id: i,
      left: Math.random() * 100,
      delay: Math.random() * 0.6,
      duration: 2 + Math.random() * 1.5,
      color: ["#ec4899", "#f59e0b", "#3b82f6", "#22c55e", "#a855f7"][i % 5],
      rotate: Math.random() * 360,
    }))
  );
  useEffect(() => {
    const style = document.createElement("style");
    style.textContent = `@keyframes ff-fall {0%{transform:translateY(-10vh) rotate(0);opacity:1}100%{transform:translateY(110vh) rotate(720deg);opacity:0.9}}`;
    document.head.appendChild(style);
    return () => style.remove();
  }, []);
  if (reduce) return null;
  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 overflow-hidden">
      {pieces.map((p) => (
        <span
          key={p.id}
          style={{
            position: "absolute",
            left: `${p.left}%`,
            top: 0,
            width: 9,
            height: 14,
            background: p.color,
            transform: `rotate(${p.rotate}deg)`,
            animation: `ff-fall ${p.duration}s ${p.delay}s ease-in forwards`,
          }}
        />
      ))}
    </div>
  );
}
