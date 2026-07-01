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
  /**
   * Phase 9 (#11): per-wheel color for the prize-label text rendered on the
   * wheel. When provided (and a valid color), every slice label uses it;
   * otherwise labels fall back to the default white-on-slice rendering.
   */
  labelColor?: string | null;
  /** Per-wheel label text size ('s' | 'l' | 'xl'); undefined = Auto (smart fit). */
  labelSize?: string | null;
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
// Tokens break on spaces AND on hyphens; hyphen sub-tokens keep their trailing
// hyphen and join with no extra space, so "Behind-the-Scenes" can wrap.
interface Token {
  text: string;
  /** Whether a space precedes this token when joined onto the current line. */
  space: boolean;
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  for (const word of text.split(" ")) {
    if (word === "") continue;
    if (word.includes("-")) {
      // Split keeping the hyphen attached to the preceding part:
      // "Behind-the-Scenes" → ["Behind-", "the-", "Scenes"].
      const parts = word.split("-");
      parts.forEach((part, i) => {
        const isLast = i === parts.length - 1;
        const piece = isLast ? part : part + "-";
        if (piece === "") return;
        // First sub-token of the word follows a space; the rest do not.
        tokens.push({ text: piece, space: i === 0 });
      });
    } else {
      tokens.push({ text: word, space: true });
    }
  }
  return tokens;
}

function wrapLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number
): string[] {
  const tokens = tokenize(text);
  const lines: string[] = [];
  let cur = "";
  for (const tok of tokens) {
    const sep = cur && tok.space ? " " : "";
    const test = cur ? cur + sep + tok.text : tok.text;
    if (!cur || ctx.measureText(test).width <= maxWidth) {
      cur = test;
    } else {
      lines.push(cur);
      cur = tok.text;
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

// Fallback when a prize has no usable color (e.g. a half-typed hex in the editor).
const FALLBACK_COLOR = "#6b7280";

// Parse #rgb or #rrggbb into [r,g,b]. Returns null for anything incomplete or
// malformed — partial values like "#ec" stream in while the user types a hex in
// the editor, and feeding those to canvas APIs throws (see shade).
function parseHex(hex: string): [number, number, number] | null {
  let m = hex.trim().replace(/^#/, "");
  if (m.length === 3) m = m[0] + m[0] + m[1] + m[1] + m[2] + m[2];
  if (!/^[0-9a-fA-F]{6}$/.test(m)) return null;
  const num = parseInt(m, 16);
  return [(num >> 16) & 0xff, (num >> 8) & 0xff, num & 0xff];
}

function shade(hex: string, amt: number): string {
  // Lighten (amt>0) or darken (amt<0) a hex color for slice gradients. Always
  // returns a valid rgb() string: CanvasGradient.addColorStop throws a
  // SyntaxError on an unparseable color, which would crash the draw, so an
  // invalid input falls back instead of being passed through.
  const rgb = parseHex(hex) ?? parseHex(FALLBACK_COLOR)!;
  const clamp = (v: number) => Math.max(0, Math.min(255, v));
  const [r, g, b] = rgb;
  return `rgb(${clamp(r + amt)},${clamp(g + amt)},${clamp(b + amt)})`;
}

// Normalize any color string to one that's always safe to assign to canvas
// fillStyle/strokeStyle or a CSS border. A half-typed brand-color hex (e.g.
// "#e") streams in from the editor; an invalid fillStyle is silently ignored by
// Chromium but can throw on stricter engines (iOS WebKit) and collapses the CSS
// ticker peg, so fall back to a valid color instead of passing it through.
function safeColor(hex: string): string {
  return parseHex(hex) ? hex : FALLBACK_COLOR;
}

export default function Wheel({
  prizes,
  brandColor = "#ec4899",
  labelColor,
  labelSize,
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

    // Per-wheel label color (#11). Validate so a half-typed hex streaming in from
    // the editor can't break the canvas draw; fall back to the default white.
    const labelFill =
      labelColor && parseHex(labelColor) ? labelColor : "#fff";

    // Outer rim
    ctx.beginPath();
    ctx.arc(cx, cy, radius + 4, 0, TWO_PI);
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.fill();

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(rotation);

    // Label geometry + ONE uniform font size that fits every label (two-line
    // wrap). A single size across all slices reads clean and intentional.
    const hubR = radius * 0.15;
    const maxLen = radius - hubR - 18; // radial room per line
    const textR = hubR + (radius - hubR) * 0.55; // mid radius text sits at
    const angularRoom = seg * textR * 0.9; // tangential room for the line stack
    const labelFor = (p: Prize) => `${p.emoji ? p.emoji + " " : ""}${p.label}`;
    const setLabelFont = (f: number) => {
      ctx.font = `600 ${f}px ui-sans-serif, system-ui, sans-serif`;
    };
    (ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing =
      "0.01em";

    // Tangential room shrinks as the slice count grows; cap the stack at the
    // number of lines that actually fit between neighbors (1 or 2) so a label
    // never bleeds into the adjacent slice. Then pick the largest font where
    // every label fits that cap on width.
    const linesThatFit = (lh: number) =>
      Math.max(1, Math.min(2, Math.floor(angularRoom / lh)));
    // The size control sets the font CEILING; the loop then shrinks from there
    // until every label fits on at most two lines within its slice. So a bigger
    // size shows bigger text where the geometry allows, but a long name still
    // WRAPS to show in full rather than being cut to "…". (Ellipsis below is a
    // last resort only for a single word too wide even at the minimum size.)
    const SIZE_CEIL: Record<string, number> = { s: 16, l: 26, xl: 32 };
    const ceiling = labelSize
      ? SIZE_CEIL[labelSize] ?? Math.min(size * 0.05, 22)
      : Math.min(size * 0.05, 22);
    let labelFont = ceiling;
    for (; labelFont >= 8; labelFont -= 0.5) {
      setLabelFont(labelFont);
      const cap = linesThatFit(labelFont * 1.08);
      const allFit = prizes.every((p) => {
        const ls = wrapLines(ctx, labelFor(p), maxLen);
        return (
          ls.length <= cap && ls.every((l) => ctx.measureText(l).width <= maxLen)
        );
      });
      if (allFit) break;
    }
    const lineH = labelFont * 1.08;
    const maxLines = linesThatFit(lineH);

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

      // Label — uniform size across every slice, wrapped to at most two lines.
      ctx.save();
      ctx.rotate(start + seg / 2);
      // Flip labels whose slice points to the LEFT half of the wheel 180° so they
      // read upright instead of upside-down. Uses the absolute angle (includes the
      // live spin `rotation`), so labels rotate with the wheel and settle upright
      // at rest.
      const absAngle =
        (((rotation + start + seg / 2) % TWO_PI) + TWO_PI) % TWO_PI;
      const flip = absAngle > Math.PI / 2 && absAngle < (3 * Math.PI) / 2;
      if (flip) ctx.rotate(Math.PI);
      ctx.textBaseline = "middle";
      ctx.fillStyle = labelFill;
      ctx.shadowColor = "rgba(0,0,0,0.45)";
      ctx.shadowBlur = 3;
      setLabelFont(labelFont);

      const all = wrapLines(ctx, labelFor(prize), maxLen);
      const dropped = all.length > maxLines;
      const lines = all.slice(0, maxLines).map((l, idx) => {
        const overflow = ctx.measureText(l).width > maxLen;
        if (!overflow && !(idx === maxLines - 1 && dropped)) return l;
        let s = l;
        while (s.length > 1 && ctx.measureText(s + "…").width > maxLen) {
          s = s.slice(0, -1);
        }
        return s.replace(/\s+$/, "") + "…";
      });

      const offset = ((lines.length - 1) * lineH) / 2;
      const rim = radius - 14;
      if (lines.length > 1) {
        // Center the two lines relative to each other, anchored at the rim. On a
        // flipped label the rim sits on the -x side, so mirror the anchor.
        ctx.textAlign = "center";
        const longest = Math.max(...lines.map((l) => ctx.measureText(l).width));
        const cxText = rim - longest / 2;
        lines.forEach((l, idx) =>
          ctx.fillText(l, flip ? -cxText : cxText, -offset + idx * lineH)
        );
      } else {
        ctx.textAlign = flip ? "left" : "right";
        ctx.fillText(lines[0], flip ? -rim : rim, 0);
      }
      ctx.restore();
    });

    ctx.restore();

    // Center hub
    const hubColor = safeColor(brandColor);
    ctx.beginPath();
    ctx.arc(cx, cy, radius * 0.15, 0, TWO_PI);
    ctx.fillStyle = "#fff";
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = hubColor;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, radius * 0.05, 0, TWO_PI);
    ctx.fillStyle = hubColor;
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
  }, [prizes, brandColor, labelColor, labelSize, size]);

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
            borderTop: `28px solid ${safeColor(brandColor)}`,
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
