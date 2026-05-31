"use client";

import { useEffect, useRef, useState } from "react";
import type { Prize } from "@/lib/games/wheel/types";
import { RARITY_COLORS } from "@/lib/games/wheel/types";
import { playTick, haptic, prefersReducedMotion } from "@/lib/sound";

export interface WheelResult {
  index: number;
  nonce: number; // changes each spin so the same index can replay
}

interface WheelProps {
  prizes: Prize[];
  brandColor?: string;
  /** Set by the parent after the server returns a result; triggers the spin. */
  result: WheelResult | null;
  onSpinEnd?: () => void;
  size?: number;
  muted?: boolean;
}

const TWO_PI = Math.PI * 2;
const SPIN_MS = 4400;
const EXTRA_TURNS = 6;

// Greedy word-wrap: split into lines that each fit maxWidth at the current font.
function wrapLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number
): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const test = cur ? cur + " " + w : w;
    if (!cur || ctx.measureText(test).width <= maxWidth) {
      cur = test;
    } else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

function easeOutQuart(t: number): number {
  return 1 - Math.pow(1 - t, 4);
}

function segmentColor(p: Prize): string {
  return p.color ?? RARITY_COLORS[p.rarity] ?? "#6b7280";
}

function shade(hex: string, amt: number): string {
  // Lighten (amt>0) or darken (amt<0) a hex color for slice gradients.
  const m = hex.replace("#", "");
  if (m.length !== 6) return hex;
  const num = parseInt(m, 16);
  const clamp = (v: number) => Math.max(0, Math.min(255, v));
  const r = clamp((num >> 16) + amt);
  const g = clamp(((num >> 8) & 0xff) + amt);
  const b = clamp((num & 0xff) + amt);
  return `rgb(${r},${g},${b})`;
}

export default function Wheel({
  prizes,
  brandColor = "#ec4899",
  result,
  onSpinEnd,
  size = 380,
  muted = false,
}: WheelProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rotationRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const lastNonce = useRef<number | null>(null);
  const lastSegRef = useRef<number>(-1);
  const pegRef = useRef<HTMLDivElement>(null);
  const mutedRef = useRef(muted);
  useEffect(() => {
    mutedRef.current = muted;
  }, [muted]);

  const [spinning, setSpinning] = useState(false);
  const seg = prizes.length > 0 ? TWO_PI / prizes.length : TWO_PI;

  function draw(rotation: number) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const px = Math.round(size * dpr);
    if (canvas.width !== px) {
      canvas.width = px;
      canvas.height = px;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);

    const cx = size / 2;
    const cy = size / 2;
    const radius = size / 2 - 8;

    // Outer rim
    ctx.beginPath();
    ctx.arc(cx, cy, radius + 4, 0, TWO_PI);
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.fill();

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(rotation);

    prizes.forEach((prize, i) => {
      const start = i * seg;
      const end = start + seg;
      const base = segmentColor(prize);

      const grad = ctx.createRadialGradient(0, 0, radius * 0.15, 0, 0, radius);
      grad.addColorStop(0, shade(base, 28));
      grad.addColorStop(1, shade(base, -22));

      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, radius, start, end);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = "rgba(255,255,255,0.5)";
      ctx.stroke();

      // Label: wrap long names onto up to two lines and size them to the slice
      // (radial length AND angular thickness), so prizes read in full instead
      // of truncating. Ellipsis is only a last resort at the minimum size.
      ctx.save();
      ctx.rotate(start + seg / 2);
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "#fff";
      ctx.shadowColor = "rgba(0,0,0,0.5)";
      ctx.shadowBlur = 3;

      const hubR = radius * 0.15;
      const maxLen = radius - hubR - 18; // radial room for each line
      const textR = hubR + (radius - hubR) * 0.55; // mid radius the text sits at
      const angularRoom = seg * textR * 0.92; // tangential room for the line stack
      const setFont = (f: number) => {
        ctx.font = `600 ${f}px ui-sans-serif, system-ui, sans-serif`;
      };
      const label = `${prize.emoji ? prize.emoji + " " : ""}${prize.label}`;

      let font = Math.min(size * 0.046, 20);
      let lines: string[] = [label];
      for (; font >= 9; font -= 0.5) {
        setFont(font);
        lines = wrapLines(ctx, label, maxLen);
        const lineH = font * 1.08;
        const fits =
          lines.length <= 2 &&
          lines.every((l) => ctx.measureText(l).width <= maxLen) &&
          lines.length * lineH <= angularRoom;
        if (fits) break;
      }
      setFont(font);

      // Final layout at the resolved size: cap to two lines, ellipsize only if
      // a line still overflows (e.g. one very long word) or content was dropped.
      const all = wrapLines(ctx, label, maxLen);
      const dropped = all.length > 2;
      lines = all.slice(0, 2).map((l, i) => {
        const overflow = ctx.measureText(l).width > maxLen;
        if (!overflow && !(i === 1 && dropped)) return l;
        let s = l;
        while (s.length > 1 && ctx.measureText(s + "…").width > maxLen) {
          s = s.slice(0, -1);
        }
        return s.replace(/\s+$/, "") + "…";
      });

      const lineH = font * 1.08;
      const offset = ((lines.length - 1) * lineH) / 2;
      lines.forEach((l, i) => ctx.fillText(l, radius - 14, -offset + i * lineH));
      ctx.restore();
    });

    ctx.restore();

    // Center hub
    ctx.beginPath();
    ctx.arc(cx, cy, radius * 0.15, 0, TWO_PI);
    ctx.fillStyle = "#fff";
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = brandColor;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, radius * 0.05, 0, TWO_PI);
    ctx.fillStyle = brandColor;
    ctx.fill();
  }

  function segmentAtPointer(rotation: number): number {
    if (prizes.length === 0) return -1;
    let a = (-Math.PI / 2 - rotation) % TWO_PI;
    if (a < 0) a += TWO_PI;
    return Math.floor(a / seg) % prizes.length;
  }

  useEffect(() => {
    draw(rotationRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prizes, brandColor, size]);

  useEffect(() => {
    if (!result || result.nonce === lastNonce.current) return;
    if (prizes.length === 0) return;
    lastNonce.current = result.nonce;

    const target = result.index;
    const center = target * seg + seg / 2;
    const base = rotationRef.current;
    let delta = (-Math.PI / 2 - center - base) % TWO_PI;
    if (delta < 0) delta += TWO_PI;
    const finalRotation = base + EXTRA_TURNS * TWO_PI + delta;

    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: start spin in response to a new result prop
    setSpinning(true);

    // Respect reduced-motion: jump to result with a short fade instead.
    if (prefersReducedMotion()) {
      rotationRef.current = finalRotation % TWO_PI;
      draw(rotationRef.current);
      const t = setTimeout(() => {
        setSpinning(false);
        onSpinEnd?.();
      }, 400);
      return () => clearTimeout(t);
    }

    const startTime = performance.now();
    lastSegRef.current = segmentAtPointer(base);

    const tick = (now: number) => {
      const t = Math.min(1, (now - startTime) / SPIN_MS);
      const eased = easeOutQuart(t);
      rotationRef.current = base + (finalRotation - base) * eased;
      draw(rotationRef.current);

      const segNow = segmentAtPointer(rotationRef.current);
      if (segNow !== lastSegRef.current) {
        lastSegRef.current = segNow;
        if (!mutedRef.current) playTick();
        // Bounce the ticker peg.
        const peg = pegRef.current;
        if (peg) {
          peg.style.transform = "translateX(-50%) rotate(-18deg)";
          requestAnimationFrame(() => {
            if (peg) peg.style.transform = "translateX(-50%) rotate(0deg)";
          });
        }
      }

      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        rotationRef.current = finalRotation % TWO_PI;
        setSpinning(false);
        haptic([0, 30, 40, 60]);
        onSpinEnd?.();
      }
    };
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result]);

  return (
    <div
      className="relative select-none"
      style={{ width: size, height: size }}
      aria-live="polite"
      aria-busy={spinning}
      role="img"
      aria-label={`Prize wheel with ${prizes.length} prizes`}
    >
      {/* Ticker peg */}
      <div
        ref={pegRef}
        className="absolute left-1/2 z-10 origin-top"
        style={{ top: -4, transform: "translateX(-50%)", transition: "transform 90ms ease-out" }}
      >
        <div
          style={{
            width: 0,
            height: 0,
            borderLeft: "15px solid transparent",
            borderRight: "15px solid transparent",
            borderTop: `28px solid ${brandColor}`,
            filter: "drop-shadow(0 2px 3px rgba(0,0,0,0.4))",
          }}
        />
      </div>
      <canvas
        ref={canvasRef}
        style={{ width: size, height: size }}
        className="rounded-full shadow-2xl"
      />
    </div>
  );
}
