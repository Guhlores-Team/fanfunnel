"use client";

import { useCallback, useEffect, useState } from "react";
import Wheel, { type WheelResult } from "./Wheel";
import type { FanPassView, WonPrize } from "@/lib/data/types";
import type { Prize } from "@/lib/games/wheel/types";
import { RARITY_COLORS } from "@/lib/games/wheel/types";
import { playWin } from "@/lib/sound";

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
  const [busy, setBusy] = useState(false);
  const [reveal, setReveal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [history, setHistory] = useState<WonPrize[]>(pass.recentWins);
  const size = useWheelSize();

  const canSpin = spinsRemaining > 0 && !busy;

  const handleSpin = useCallback(async () => {
    if (!canSpin) return;
    setBusy(true);
    setError(null);
    setReveal(false);
    setWon(null);
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
      // Trigger the wheel animation; reveal happens on spin end.
      setResult({ index: data.prizeIndex, nonce: Date.now() });
      setWon(prize);
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
    }
  }, [won, muted]);

  const brand = pass.wheel.brandColor ?? "#ec4899";

  return (
    <div className="flex flex-col items-center gap-6 w-full max-w-md">
      <header className="text-center">
        <h1 className="text-3xl font-extrabold tracking-tight text-white">
          {pass.wheel.title}
        </h1>
        {pass.wheel.subtitle && (
          <p className="mt-1 text-white/70">{pass.wheel.subtitle}</p>
        )}
        {pass.fanName && (
          <p className="mt-2 text-sm text-white/50">
            Welcome, <span className="font-semibold">{pass.fanName}</span> ·{" "}
            {pass.creatorTitle}
          </p>
        )}
      </header>

      <Wheel
        prizes={pass.wheel.prizes}
        brandColor={brand}
        result={result}
        onSpinEnd={handleSpinEnd}
        size={size}
        muted={muted}
      />

      <div className="flex flex-col items-center gap-3 w-full">
        <div className="flex items-center gap-2">
          <div
            className="rounded-full px-4 py-1.5 text-sm font-semibold text-white"
            style={{ backgroundColor: "rgba(255,255,255,0.12)" }}
          >
            Spins left: <span style={{ color: brand }}>{spinsRemaining}</span>
          </div>
          <button
            onClick={() => setMuted((m) => !m)}
            className="rounded-full bg-white/10 px-3 py-1.5 text-sm text-white/80 hover:bg-white/20"
            aria-label={muted ? "Unmute" : "Mute"}
            title={muted ? "Unmute" : "Mute"}
          >
            {muted ? "🔇" : "🔊"}
          </button>
        </div>

        <button
          onClick={handleSpin}
          disabled={!canSpin}
          className="w-full rounded-2xl py-4 text-lg font-extrabold text-white shadow-lg transition active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
          style={{ backgroundColor: brand }}
        >
          {busy ? "Spinning…" : spinsRemaining > 0 ? "SPIN 🎉" : "Out of spins"}
        </button>

        {error && (
          <p className="text-center text-sm text-amber-300">{error}</p>
        )}
        {spinsRemaining === 0 && !error && !reveal && (
          <p className="text-center text-sm text-white/50">
            Tip your creator to unlock more spins. 💖
          </p>
        )}
      </div>

      {history.length > 0 && (
        <div className="w-full">
          <p className="mb-2 text-center text-xs uppercase tracking-wider text-white/40">
            Your wins
          </p>
          <div className="flex flex-wrap justify-center gap-2">
            {history.map((p, i) => (
              <span
                key={i}
                className="rounded-full px-3 py-1 text-xs font-semibold text-white"
                style={{
                  backgroundColor:
                    (p.color ?? RARITY_COLORS[p.rarity]) + "33",
                  border: `1px solid ${p.color ?? RARITY_COLORS[p.rarity]}`,
                }}
              >
                {p.emoji ?? "🎁"} {p.label}
              </span>
            ))}
          </div>
        </div>
      )}

      {reveal && won && <PrizeModal prize={won} onClose={() => setReveal(false)} />}
    </div>
  );
}

function PrizeModal({ prize, onClose }: { prize: Prize; onClose: () => void }) {
  const color = prize.color ?? RARITY_COLORS[prize.rarity];
  const isBig = prize.rarity === "epic" || prize.rarity === "legendary";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      {isBig && <Confetti />}
      <div
        className="relative w-full max-w-sm rounded-3xl bg-zinc-900 p-8 text-center shadow-2xl ring-1"
        style={{ ["--tw-ring-color" as string]: color }}
        onClick={(e) => e.stopPropagation()}
      >
        <span
          className="inline-block rounded-full px-3 py-1 text-xs font-bold uppercase tracking-wider text-white"
          style={{ backgroundColor: color }}
        >
          {RARITY_LABEL[prize.rarity]}
        </span>
        <div className="my-4 text-6xl">{prize.emoji ?? "🎁"}</div>
        <h2 className="text-2xl font-extrabold text-white">{prize.label}</h2>
        {prize.description && (
          <p className="mt-2 text-white/60">{prize.description}</p>
        )}
        <p className="mt-4 text-sm text-white/50">
          Screenshot this and send it to your creator to claim your prize!
        </p>
        <button
          onClick={onClose}
          className="mt-6 w-full rounded-2xl py-3 font-bold text-white"
          style={{ backgroundColor: color }}
        >
          Awesome!
        </button>
      </div>
    </div>
  );
}

// Lightweight CSS confetti — no dependency.
function Confetti() {
  const [pieces] = useState(() =>
    Array.from({ length: 60 }, (_, i) => ({
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
