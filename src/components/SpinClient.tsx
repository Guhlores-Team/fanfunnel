"use client";

import { useCallback, useEffect, useState } from "react";
import Wheel, { type WheelResult } from "./Wheel";
import type { FanPassView, WonPrize } from "@/lib/data/types";
import type { Prize } from "@/lib/games/wheel/types";
import { RARITY_COLORS } from "@/lib/games/wheel/types";
import { playWin } from "@/lib/sound";
import NearMissBeat, {
  detectNearMiss,
  type NearMiss,
} from "./NearMissBeat";
import PityBeat from "./PityBeat";
import HappyHourBanner from "./fan/HappyHourBanner";
import ReferralWidget from "./fan/ReferralWidget";
import WishlistSection from "./fan/WishlistSection";
import ChatPanel from "./fan/ChatPanel";

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

const RARITY_LABEL: Record<string, string> = {
  common: "Common",
  uncommon: "Uncommon",
  rare: "Rare",
  epic: "Epic",
  legendary: "Legendary",
};

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
  const size = useWheelSize();

  // Canvas needs a real color string (it can't read the --brand CSS var).
  const brand = pass.wheel.brandColor ?? "#ec4899";
  const canSpin = spinsRemaining > 0 && !busy;

  const handleSpin = useCallback(async () => {
    if (!canSpin) return;
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
        body: JSON.stringify({ token: pass.token }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(
          body.error === "no_spins"
            ? "You're out of spins! Tip your creator to get more. 💖"
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
    } catch {
      setError("Network error. Try again.");
      setBusy(false);
    }
  }, [canSpin, pass.token]);

  const handleSpinEnd = useCallback(() => {
    setBusy(false);
    setReveal(true);
    if (won) {
      if (!muted) playWin(won.rarity);
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
            <span className="tnum ml-1 font-bold text-[var(--brand)]">
              {spinsRemaining}
            </span>
          </div>
          <button
            onClick={() => setMuted((m) => !m)}
            className="rounded-full border border-line bg-surface/70 px-3 py-1.5 text-sm text-muted transition hover:text-ink"
            aria-label={muted ? "Unmute" : "Mute"}
            title={muted ? "Unmute" : "Mute"}
          >
            {muted ? "🔇" : "🔊"}
          </button>
        </div>

        <button
          onClick={handleSpin}
          disabled={!canSpin}
          className="btn-brand w-full rounded-2xl py-4 text-lg font-extrabold tracking-wide focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand)]"
        >
          {busy ? "Spinning…" : spinsRemaining > 0 ? "SPIN" : "Out of spins"}
        </button>

        {error && <p className="text-center text-sm text-amber-300">{error}</p>}
        {spinsRemaining === 0 && !error && !reveal && (
          <p className="text-center text-sm text-muted">
            Tip your creator to unlock more spins. 💖
          </p>
        )}
      </div>

      {history.length > 0 && (
        <div className="w-full">
          <p className="mb-3 text-center text-[11px] font-medium uppercase tracking-[0.18em] text-muted">
            Your wins
          </p>
          <div className="flex flex-wrap justify-center gap-2">
            {history.map((p, i) => {
              const c = p.color ?? RARITY_COLORS[p.rarity];
              return (
                <span
                  key={i}
                  className="rounded-full px-3 py-1 text-xs font-semibold text-ink"
                  style={{
                    backgroundColor: `color-mix(in oklab, ${c} 18%, transparent)`,
                    border: `1px solid color-mix(in oklab, ${c} 55%, transparent)`,
                  }}
                >
                  {p.emoji ?? "🎁"} {p.label}
                </span>
              );
            })}
          </div>
        </div>
      )}

      <WishlistSection
        token={pass.token}
        prizes={pass.wheel.prizes}
        initial={pass.wishlist ?? []}
      />

      {pass.referral && pass.referral.code && (
        <ReferralWidget
          token={pass.token}
          code={pass.referral.code}
          bonusPerReferral={pass.referral.bonusPerReferral}
        />
      )}

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

  const share = async () => {
    if (!shareId) return;
    const url = `${window.location.origin}/share/${shareId}`;
    const text = `I just won ${prize.label}! 🎉`;
    try {
      if (navigator.share) {
        await navigator.share({ title: prize.label, text, url });
      } else {
        await navigator.clipboard.writeText(url);
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
      <div
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
        {prize.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={prize.imageUrl}
            alt={prize.label}
            className="mx-auto my-5 h-44 w-44 rounded-2xl object-cover"
          />
        ) : (
          <div className="my-5 text-6xl">{prize.emoji ?? "🎁"}</div>
        )}
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
          onClick={onClose}
          className="btn-brand mt-3 w-full rounded-2xl py-3 font-bold"
          style={{ ["--brand" as string]: color }}
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

// Lightweight CSS confetti — no dependency.
function Confetti() {
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
  return (
    <div className="pointer-events-none fixed inset-0 overflow-hidden">
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
