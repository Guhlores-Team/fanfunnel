"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { PublicPrize } from "@/lib/games/wheel/types";
import { brandVars, readableInk } from "@/lib/theme";
import { useFocusTrap } from "@/lib/hooks/useFocusTrap";
import { copyToClipboard } from "@/lib/hooks/useClipboard";
import { prefersReducedMotion } from "@/lib/sound";
import { resolveRevealTier, type RevealTierConfig } from "./revealTiers";

/**
 * F3 · the shared win card. Every game opens this once the server has decided
 * the prize: the wheel today, instant-delivery rewards (#26) and the new games
 * later. `extra` is a slot under the medallion (a revealed code or link, a
 * "Line complete!" bonus…).
 *
 * `entrance="static"` (reduced motion, or a tap-to-skip) shows the final card
 * at once: no pop, no confetti. The rarity still reads from the colour frame,
 * the rarity pill and the rank pips, and it is announced to screen readers.
 *
 * `banner` is a slot ABOVE the card, in the same column (the "So close!" and
 * "Guaranteed rare!" beats). Being in flow, it can never overlap the card on a
 * short phone; `bannerSpace` reserves its row for the whole reveal so the card
 * doesn't jump when the beat leaves.
 */
export default function RewardReveal({
  prize,
  tier: tierProp,
  shareId,
  extra,
  instant = false,
  banner,
  bannerSpace = false,
  entrance,
  confetti,
  onClose,
}: {
  prize: PublicPrize;
  tier?: RevealTierConfig;
  shareId: string | null;
  extra?: ReactNode;
  /** The private instant value is shown in `extra`; no manual claim is needed. */
  instant?: boolean;
  /** Beat shown above the card (see the doc comment). */
  banner?: ReactNode;
  /** Reserve the banner row even while `banner` is empty. */
  bannerSpace?: boolean;
  entrance?: "animated" | "static";
  /** Confetti pieces; defaults to the tier's (0 when static). */
  confetti?: number;
  onClose: () => void;
}) {
  const [reduced] = useState(() => prefersReducedMotion());
  const tier = tierProp ?? resolveRevealTier(prize.rarity, { reducedMotion: reduced });
  const mode = entrance ?? (tier.animate ? "animated" : "static");
  const pieces = mode === "static" ? 0 : confetti ?? tier.confetti;
  const prizeColor = prize.color ?? tier.color;
  const big = tier.rank >= 4;
  const [shared, setShared] = useState(false);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const shareFirst = tier.sharePrimary && !!shareId;

  // The live region mounts empty and is filled a tick later: a region that
  // arrives already populated is skipped by several screen readers.
  const [announce, setAnnounce] = useState("");
  useEffect(() => {
    const t = setTimeout(
      () => setAnnounce(`You won ${prize.label}, a ${tier.label} prize.`),
      60
    );
    return () => clearTimeout(t);
  }, [prize.label, tier.label]);

  // Focus the primary action on open, close on Escape, trap Tab inside.
  const dialogRef = useFocusTrap<HTMLDivElement>({
    active: true,
    onEscape: onClose,
    initialFocus: primaryRef,
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

  const shareLabel = shared ? "Link copied!" : "Share your win ↗";
  const shareBtn = shareId ? (
    shareFirst ? (
      <button
        ref={primaryRef}
        onClick={share}
        className="btn-brand mt-6 w-full rounded-2xl py-3 font-bold"
        style={brandVars(tier.color)}
      >
        {shareLabel}
      </button>
    ) : (
      <button
        onClick={share}
        className="mt-6 w-full rounded-2xl border py-3 font-semibold text-ink transition hover:brightness-110"
        style={{ borderColor: prizeColor }}
      >
        {shareLabel}
      </button>
    )
  ) : null;

  return (
    <div
      className="fixed inset-0 z-50 flex overflow-y-auto p-4"
      onClick={onClose}
      data-testid="reward-reveal"
      data-tier={tier.rarity}
      data-entrance={mode}
    >
      {/* The backdrop fades on its own layer so the card never enters from 0
          opacity (DESIGN.md motion rule). */}
      <div
        aria-hidden="true"
        className="fixed inset-0 bg-black/75 backdrop-blur-sm"
        style={mode === "animated" ? { animation: "ff-fade 0.2s ease-out" } : undefined}
      />
      {pieces > 0 && <Confetti count={pieces} gold={tier.rarity === "legendary"} />}
      <p className="sr-only" role="status" aria-live="assertive" data-testid="reveal-announcement">
        {announce}
      </p>
      {/* m-auto centres the column when it fits and lets it scroll from the
          top when it doesn't (a short phone), instead of clipping the card. */}
      <div className="relative m-auto flex w-full max-w-sm flex-col">
        {(bannerSpace || banner) && (
          <div data-testid="reveal-banner" className="mb-3 flex min-h-[3.75rem] items-end justify-center">
            {banner}
          </div>
        )}
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-label={`You won ${prize.label}`}
          aria-describedby="reveal-rarity"
          className="card relative w-full max-w-sm rounded-[1.75rem] p-8 text-center"
          style={{
            boxShadow: `0 30px 80px -20px color-mix(in oklab, ${tier.color} ${big ? 70 : 50}%, transparent)`,
            border: `${big ? 2 : 1}px solid color-mix(in oklab, ${tier.color} ${big ? 80 : 55}%, transparent)`,
            animation:
              mode === "animated"
                ? `ff-pop ${big ? 0.42 : 0.32}s cubic-bezier(0.18,0.9,0.3,1.2)`
                : "none",
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <span
            id="reveal-rarity"
            className="inline-flex items-center gap-2 rounded-full px-3 py-1 text-[11px] font-bold uppercase tracking-[0.14em]"
            style={{ backgroundColor: tier.color, color: readableInk(tier.color) }}
          >
            {tier.label}
            <span className="sr-only"> prize</span>
          </span>
          {/* Rank pips: rarity at a glance without colour or motion. */}
          <div aria-hidden="true" className="mt-2 flex justify-center gap-1" data-testid="reveal-pips">
            {Array.from({ length: 5 }, (_, i) => (
              <span
                key={i}
                className="h-1.5 w-1.5 rounded-full"
                style={{
                  backgroundColor:
                    i < tier.rank ? tier.color : "color-mix(in oklab, var(--color-ink) 18%, transparent)",
                }}
              />
            ))}
          </div>
          <div
            className="mx-auto my-6 grid place-items-center rounded-full"
            style={{
              width: tier.medallionPx,
              height: tier.medallionPx,
              background: `radial-gradient(circle at 50% 35%, color-mix(in oklab, ${prizeColor} 45%, transparent), color-mix(in oklab, ${prizeColor} 12%, transparent) 70%)`,
              boxShadow: `inset 0 0 0 ${big ? 2 : 1}px color-mix(in oklab, ${tier.color} ${big ? 70 : 45}%, transparent), 0 12px 40px -12px color-mix(in oklab, ${prizeColor} 60%, transparent)`,
            }}
          >
            <span aria-hidden="true" style={{ fontSize: Math.round(tier.medallionPx * 0.47) }}>
              {prize.emoji ?? "🎁"}
            </span>
          </div>
          <h2 className="font-[family-name:var(--font-display)] text-2xl font-extrabold text-ink text-balance">
            {prize.label}
          </h2>
          {prize.description && (
            <p className="mt-2 text-sm text-muted text-pretty">{prize.description}</p>
          )}
          {extra}
          <p className="mt-5 text-sm text-muted">
            {instant
              ? "Your reward is delivered. You can reopen it from Your wins."
              : "Screenshot this and send it to your creator to claim your prize!"}
          </p>
          {instant && shareId && <p className="mt-2 text-xs text-muted">Your reward stays private when you share your win.</p>}
          {shareBtn}
          <button
            ref={shareFirst ? undefined : primaryRef}
            onClick={onClose}
            className={
              shareFirst
                ? "mt-3 w-full rounded-2xl border border-line py-3 font-semibold text-ink transition hover:brightness-110"
                : "btn-brand mt-3 w-full rounded-2xl py-3 font-bold"
            }
            style={shareFirst ? undefined : brandVars(prizeColor)}
          >
            Awesome!
          </button>
        </div>
      </div>
      <style>{`
        @keyframes ff-fade { from { opacity: 0 } to { opacity: 1 } }
        @keyframes ff-pop { from { transform: translateY(12px) scale(0.94) } to { transform: none } }
      `}</style>
    </div>
  );
}

// Lightweight CSS confetti, no dependency. Never rendered for a static
// entrance (reduced motion or a skip); the reduced-motion check here is a
// second guard for callers that pass a count directly.
function Confetti({ count, gold }: { count: number; gold: boolean }) {
  const reduce = prefersReducedMotion();
  const [pieces] = useState(() => {
    const palette = gold
      ? ["#f59e0b", "#fbbf24", "#fde68a", "#f59e0b", "#ffffff"]
      : ["#ec4899", "#f59e0b", "#3b82f6", "#22c55e", "#a855f7"];
    return Array.from({ length: count }, (_, i) => ({
      id: i,
      left: Math.random() * 100,
      delay: Math.random() * 0.6,
      duration: 2 + Math.random() * 1.5,
      color: palette[i % palette.length],
      rotate: Math.random() * 360,
    }));
  });
  useEffect(() => {
    const style = document.createElement("style");
    style.textContent = `@keyframes ff-fall {0%{transform:translateY(-10vh) rotate(0);opacity:1}100%{transform:translateY(110vh) rotate(720deg);opacity:0.9}}`;
    document.head.appendChild(style);
    return () => style.remove();
  }, []);
  if (reduce) return null;
  return (
    <div aria-hidden="true" data-testid="reveal-confetti" className="pointer-events-none fixed inset-0 overflow-hidden">
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
