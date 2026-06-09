"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { Rarity } from "@/lib/games/wheel/types";
import { RARITY_COLORS } from "@/lib/games/wheel/types";
import { prefersReducedMotion } from "@/lib/sound";
import type { NearMiss } from "@/components/fan/nearMiss";

// detectNearMiss + the NearMiss type live in the motion-free ./fan/nearMiss
// module so callers can detect a near-miss without pulling in this component's
// motion dependency. Re-exported here for backward compatibility.
export { detectNearMiss, type NearMiss } from "@/components/fan/nearMiss";

const RARITY_LABEL: Record<Rarity, string> = {
  common: "Common",
  uncommon: "Uncommon",
  rare: "Rare",
  epic: "Epic",
  legendary: "Legendary",
};

/**
 * Brief, tasteful "So close!" beat. Plays after the win reveal and settles on
 * its own. Non-blocking (pointer-events: none) so the fan keeps seeing their
 * actual win. Transform/opacity only — no layout shift. Respects
 * prefers-reduced-motion (skips the motion, keeps the text).
 */
export default function NearMissBeat({
  nearMiss,
  onDone,
}: {
  nearMiss: NearMiss;
  onDone?: () => void;
}) {
  const [show, setShow] = useState(true);
  const reduce = prefersReducedMotion();
  const color =
    nearMiss.prize.color ?? RARITY_COLORS[nearMiss.prize.rarity];

  useEffect(() => {
    const hold = reduce ? 2200 : 1700;
    const t = setTimeout(() => setShow(false), hold);
    return () => clearTimeout(t);
  }, [reduce]);

  const fromX = nearMiss.side === "left" ? -18 : 18;

  return (
    <AnimatePresence onExitComplete={onDone}>
      {show && (
        <div
          className="pointer-events-none fixed inset-x-0 top-[14%] z-[60] flex justify-center px-5"
          aria-live="polite"
        >
          <motion.div
            initial={
              reduce
                ? { opacity: 0 }
                : { opacity: 0, y: -10, x: fromX, scale: 0.94 }
            }
            animate={
              reduce
                ? { opacity: 1 }
                : { opacity: 1, y: 0, x: 0, scale: 1 }
            }
            exit={reduce ? { opacity: 0 } : { opacity: 0, y: -8, scale: 0.97 }}
            transition={
              reduce
                ? { duration: 0.2 }
                : { type: "spring", stiffness: 420, damping: 26 }
            }
            className="flex max-w-xs items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold text-ink backdrop-blur-sm"
            style={{
              backgroundColor: `color-mix(in oklab, ${color} 22%, rgba(0,0,0,0.55))`,
              border: `1px solid color-mix(in oklab, ${color} 60%, transparent)`,
              boxShadow: `0 12px 40px -12px color-mix(in oklab, ${color} 70%, transparent)`,
            }}
          >
            <motion.span
              aria-hidden
              className="text-base leading-none"
              animate={
                reduce
                  ? undefined
                  : { scale: [1, 1.35, 1], opacity: [0.7, 1, 0.7] }
              }
              transition={
                reduce
                  ? undefined
                  : { duration: 0.9, repeat: Infinity, ease: "easeInOut" }
              }
              style={{
                // A small glowing dot in the missed prize's rarity color.
                display: "inline-block",
                width: "0.6em",
                height: "0.6em",
                borderRadius: "9999px",
                backgroundColor: color,
                boxShadow: `0 0 10px ${color}`,
              }}
            />
            <span className="text-pretty">
              So close! ✨ {RARITY_LABEL[nearMiss.prize.rarity]}{" "}
              <span className="font-extrabold">
                {nearMiss.prize.emoji ? `${nearMiss.prize.emoji} ` : ""}
                {nearMiss.prize.label}
              </span>{" "}
              was right there
            </span>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
