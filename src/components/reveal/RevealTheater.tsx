"use client";

import type { CSSProperties } from "react";
import type { RevealPhase, RevealTierConfig } from "./revealTiers";

// RM-1 theater layers. Lazy-loaded by SpinClient (like PityBeat), CSS only,
// transform/opacity animation only. Both layers are decorative (aria-hidden):
// the rarity reaches assistive tech through RewardReveal's announcement.
//
// Photosensitivity: the page dims, it never flashes. The only repeating
// effects are a 1.6s glow breath and an 8s ray rotation, far under 3/s.

/**
 * The page dim + rarity edge glow for build-up tiers (epic/legendary by
 * default). The wheel is raised above it by SpinClient so it stays bright.
 * Tapping it skips when `onTap` is given.
 */
export default function RevealTheater({
  tier,
  onTap,
}: {
  tier: RevealTierConfig;
  onTap?: () => void;
}) {
  return (
    <div
      aria-hidden="true"
      data-testid="reveal-theater"
      data-tier={tier.rarity}
      onClick={onTap}
      className="fixed inset-0 z-40"
      style={{
        cursor: onTap ? "pointer" : undefined,
        pointerEvents: onTap ? "auto" : "none",
        backgroundColor: `rgba(0,0,0,${tier.dim})`,
        boxShadow: `inset 0 0 140px 24px color-mix(in oklab, ${tier.color} 55%, transparent)`,
        animation: "ff-theater-in 0.35s ease-out",
      }}
    >
      <style>{`@keyframes ff-theater-in { from { opacity: 0 } to { opacity: 1 } }`}</style>
    </div>
  );
}

/**
 * Effects drawn around the wheel itself: the rarity halo (and gold rays for
 * legendary) during the build-up, and the stop effect when it lands: a small
 * lift pulse (common/uncommon), a ring (rare) or a bigger burst (epic+).
 */
export function WheelAura({
  tier,
  phase,
}: {
  tier: RevealTierConfig;
  phase: RevealPhase;
}) {
  if (!tier.animate) return null;
  const building = tier.buildUp && (phase === "buildup" || phase === "landed");
  const stopped = phase === "landed" || phase === "revealed";
  // Scales stay at or under 1.12: on a 360px phone the wheel has ~24px either
  // side, and a transform that crosses the viewport would scroll the page.
  const ring =
    tier.stopEffect === "burst"
      ? { scale: 1.12, ms: 650, width: 6 }
      : tier.stopEffect === "spotlight"
        ? { scale: 1.08, ms: 450, width: 4 }
        : { scale: 1.04, ms: 250, width: 3 };
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0" data-testid="wheel-aura">
      {building && (
        <div
          className="absolute -inset-[6%] rounded-full"
          style={{
            background: `radial-gradient(circle closest-side, color-mix(in oklab, ${tier.color} 85%, transparent) 80%, transparent)`,
            animation: "ff-aura-breathe 1.6s ease-in-out infinite alternate",
          }}
        />
      )}
      {building && tier.rays && (
        // Clipped to the halo's circle so the rays never widen the page at 360px.
        <div
          className="absolute -inset-[6%] overflow-hidden rounded-full"
          style={{
            // Soft-edged wedges that fade out toward the rim read as light,
            // not as hard blocks.
            maskImage: "radial-gradient(circle closest-side, #000 82%, transparent 100%)",
            WebkitMaskImage: "radial-gradient(circle closest-side, #000 82%, transparent 100%)",
          }}
        >
          <div
            className="absolute inset-0"
            style={{
              background: `repeating-conic-gradient(from 0deg, transparent 0deg, color-mix(in oklab, ${tier.color} 70%, white 10%) 5deg, transparent 10deg, transparent 22.5deg)`,
              filter: "blur(2px)",
              animation: "ff-rays 8s linear infinite",
            }}
          />
        </div>
      )}
      {stopped && (
        <div
          className="absolute inset-0 rounded-full"
          style={
            {
              border: `${ring.width}px solid ${tier.color}`,
              boxShadow: `0 0 24px ${tier.color}`,
              transform: `scale(${ring.scale})`,
              opacity: 0,
              animation: `ff-ring ${ring.ms}ms cubic-bezier(0.16,1,0.3,1)`,
              "--ff-ring-scale": String(ring.scale),
            } as CSSProperties
          }
        />
      )}
      <style>{`
        @keyframes ff-aura-breathe { from { transform: scale(0.96); opacity: 0.7 } to { transform: scale(1); opacity: 1 } }
        @keyframes ff-rays { to { transform: rotate(360deg) } }
        @keyframes ff-ring { from { transform: scale(1); opacity: 0.95 } to { transform: scale(var(--ff-ring-scale)); opacity: 0 } }
      `}</style>
    </div>
  );
}
