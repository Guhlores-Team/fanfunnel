"use client";

import { useCallback, useEffect, useId, useRef, useState, type PointerEvent } from "react";
import type { ScratchPresentation } from "@/lib/games/scratch/engine";
import { addScratchCoverage, scratchPoint, SCRATCH_BRUSH_FRACTION, SCRATCH_REVEAL_FRACTION, type ScratchPoint } from "./scratchGeometry";

/** Cosmetic foil over the immutable server ticket. Gestures never select an outcome. */
export default function ScratchTicket({ presentation, onReveal, reducedMotion = false }: {
  presentation: ScratchPresentation;
  onReveal: () => void;
  reducedMotion?: boolean;
}) {
  const instructions = useId();
  const [revealed, setRevealed] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const activePointer = useRef<number | null>(null);
  const covered = useRef(new Set<number>());
  const strokes = useRef<ScratchPoint[][]>([]);
  const completed = useRef(false);
  const reveal = useCallback(() => {
    if (completed.current) return;
    completed.current = true;
    activePointer.current = null;
    setRevealed(true);
    onReveal();
  }, [onReveal]);

  const paint = useCallback(() => {
    const target = canvas.current;
    if (!target) return;
    const bounds = target.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;
    const ratio = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    target.width = Math.round(bounds.width * ratio);
    target.height = Math.round(bounds.height * ratio);
    const context = target.getContext("2d");
    if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.fillStyle = "#65566f";
    context.fillRect(0, 0, bounds.width, bounds.height);
    context.fillStyle = "#ffffff";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.font = `600 17px ${getComputedStyle(target).fontFamily}`;
    context.fillText("Scratch to reveal", bounds.width / 2, bounds.height / 2 - 12);
    context.font = `400 12px ${getComputedStyle(target).fontFamily}`;
    context.fillText("or choose Reveal all below", bounds.width / 2, bounds.height / 2 + 13);
    context.globalCompositeOperation = "destination-out";
    context.lineWidth = Math.min(bounds.width, bounds.height) * SCRATCH_BRUSH_FRACTION * 2;
    context.lineCap = "round";
    context.lineJoin = "round";
    for (const stroke of strokes.current) {
      if (!stroke.length) continue;
      context.beginPath();
      context.moveTo(stroke[0].x * bounds.width, stroke[0].y * bounds.height);
      if (stroke.length === 1) context.lineTo(stroke[0].x * bounds.width + 0.1, stroke[0].y * bounds.height + 0.1);
      for (const point of stroke.slice(1)) context.lineTo(point.x * bounds.width, point.y * bounds.height);
      context.stroke();
    }
  }, []);
  useEffect(() => {
    const target = canvas.current;
    if (!target) return;
    const observer = new ResizeObserver(paint);
    observer.observe(target);
    window.addEventListener("resize", paint);
    const frame = requestAnimationFrame(paint);
    return () => { observer.disconnect(); window.removeEventListener("resize", paint); cancelAnimationFrame(frame); };
  }, [paint]);
  useEffect(() => {
    if (!reducedMotion) return;
    const timer = setTimeout(reveal, 0);
    return () => clearTimeout(timer);
  }, [reducedMotion, reveal]);

  const scratch = (event: PointerEvent<HTMLCanvasElement>) => {
    if (completed.current || activePointer.current !== event.pointerId) return;
    const point = scratchPoint(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect());
    if (!point) return;
    const stroke = strokes.current.at(-1);
    if (!stroke) return;
    const prior = stroke.at(-1) ?? point;
    stroke.push(point);
    const fraction = addScratchCoverage(covered.current, prior, point);
    paint();
    if (fraction >= SCRATCH_REVEAL_FRACTION) reveal();
  };
  const begin = (event: PointerEvent<HTMLCanvasElement>) => {
    if (completed.current || !event.isPrimary || (event.pointerType === "mouse" && event.button !== 0)) return;
    activePointer.current = event.pointerId;
    strokes.current.push([]);
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* Reveal all remains available. */ }
    scratch(event);
  };
  const stop = (event: PointerEvent<HTMLCanvasElement>) => {
    if (activePointer.current !== event.pointerId) return;
    if (event.type !== "pointercancel") scratch(event);
    activePointer.current = null;
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* A cancelled pointer may already have released capture. */ }
  };
  return (
    <section aria-label="Your scratch ticket" className="w-full min-w-0 rounded-2xl border border-line bg-surface p-3 sm:p-4" data-testid="scratch-ticket" data-revealed={String(revealed)}>
      <p id={instructions} className="mb-3 text-sm text-muted">Every ticket wins. Scratch the foil, or use Reveal all to see the same result.</p>
      <div className="relative overflow-hidden rounded-xl border border-line">
        <table aria-label="Committed scratch ticket symbols" aria-hidden={!revealed} className="w-full table-fixed border-collapse text-center" data-testid="scratch-face">
          <tbody>{[0,1,2].map(row => <tr key={row}>{presentation.cells.slice(row * 3, row * 3 + 3).map((cell, column) => (
            <td key={`${row}-${column}`} className="h-28 border border-line bg-base px-1 py-3 align-middle" data-testid="scratch-cell" data-cell-kind={cell.kind} data-symbol-id={cell.id}>
              <span className="block text-2xl" aria-hidden="true">{cell.emoji ?? "◇"}</span>
              <span className="mt-2 block break-words text-xs font-semibold leading-snug text-ink [overflow-wrap:anywhere]">{cell.label}</span>
            </td>
          ))}</tr>)}</tbody>
        </table>
        {!revealed && <canvas ref={canvas} aria-hidden="true" data-testid="scratch-foil"
          className="absolute inset-0 h-full w-full cursor-crosshair touch-none rounded-xl" onPointerDown={begin} onPointerMove={scratch} onPointerUp={stop} onPointerCancel={stop} />}
      </div>
      <button type="button" onClick={reveal} disabled={revealed} aria-describedby={instructions} data-testid="scratch-reveal-all"
        className="btn-brand mt-4 min-h-11 w-full rounded-xl px-4 py-3 font-bold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand-text)]">
        {revealed ? "Ticket revealed" : "Reveal all"}
      </button>
      <p role="status" aria-live="polite" className="mt-2 text-center text-xs text-muted">{revealed ? "Your ticket is revealed. Your prize is shown in the win card." : "Reveal all works with a keyboard and gives the same prize as scratching."}</p>
    </section>
  );
}
