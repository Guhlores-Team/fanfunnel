"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { Prize } from "@/lib/games/wheel/types";
import { RARITY_COLORS } from "@/lib/games/wheel/types";
import { prefersReducedMotion } from "@/lib/sound";

/**
 * Celebratory "Guaranteed rare! 🎯" beat. Plays on the win reveal when the
 * pity timer forced a guaranteed rare-or-better that spin. This is a *win*
 * celebration — distinct from the "So close!" near-miss toast: a shimmering
 * badge that sweeps in near the prize.
 *
 * Non-blocking (pointer-events: none), transform/opacity only (no layout
 * shift), aria-live="polite", auto-dismisses. Respects prefers-reduced-motion
 * (skips the shimmer/motion, still shows the badge + text).
 */
export default function PityBeat({
  prize,
  onDone,
}: {
  prize: Prize;
  onDone?: () => void;
}) {
  const [show, setShow] = useState(true);
  const reduce = prefersReducedMotion();
  const color = prize.color ?? RARITY_COLORS[prize.rarity];

  useEffect(() => {
    const hold = reduce ? 2600 : 2100;
    const t = setTimeout(() => setShow(false), hold);
    return () => clearTimeout(t);
  }, [reduce]);

  return (
    <AnimatePresence onExitComplete={onDone}>
      {show && (
        <div
          className="pointer-events-none fixed inset-x-0 top-[8%] z-[70] flex justify-center px-5"
          aria-live="polite"
        >
          <motion.div
            initial={
              reduce
                ? { opacity: 0 }
                : { opacity: 0, y: -12, scale: 0.9 }
            }
            animate={
              reduce
                ? { opacity: 1 }
                : { opacity: 1, y: 0, scale: 1 }
            }
            exit={reduce ? { opacity: 0 } : { opacity: 0, y: -10, scale: 0.96 }}
            transition={
              reduce
                ? { duration: 0.2 }
                : { type: "spring", stiffness: 460, damping: 22 }
            }
            className="relative flex max-w-xs items-center gap-2 overflow-hidden rounded-full px-4 py-2 text-sm font-bold text-ink backdrop-blur-sm"
            style={{
              backgroundColor: `color-mix(in oklab, ${color} 32%, rgba(0,0,0,0.5))`,
              border: `1px solid color-mix(in oklab, ${color} 75%, transparent)`,
              boxShadow: `0 14px 46px -12px color-mix(in oklab, ${color} 85%, transparent)`,
            }}
          >
            {/* Shimmer sweep — purely cosmetic, skipped when reduced motion. */}
            {!reduce && (
              <motion.span
                aria-hidden
                className="pointer-events-none absolute inset-0"
                initial={{ x: "-120%" }}
                animate={{ x: "120%" }}
                transition={{
                  duration: 1.1,
                  repeat: Infinity,
                  repeatDelay: 0.4,
                  ease: "easeInOut",
                }}
                style={{
                  background:
                    "linear-gradient(105deg, transparent 30%, color-mix(in oklab, #ffffff 55%, transparent) 50%, transparent 70%)",
                }}
              />
            )}
            <span aria-hidden className="relative text-base leading-none">
              🎯
            </span>
            <span className="relative text-pretty">
              Guaranteed rare!{" "}
              <span className="font-extrabold">
                {prize.emoji ? `${prize.emoji} ` : ""}
                {prize.label}
              </span>
            </span>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
