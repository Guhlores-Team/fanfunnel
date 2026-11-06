"use client";

import { useEffect, useRef, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { prefersReducedMotion } from "@/lib/sound";
import { shouldDismissSheet } from "./sheetGesture";

// Movement (px) before a press on the handle becomes a drag, so a tap on the
// handle stays a tap.
const SLOP = 4;

/**
 * Drag-to-dismiss for a bottom sheet's grabber handle. Spread the returned
 * `onPointerDown` on the handle element; `sheetRef` is the sheet panel that
 * follows the finger. Pulling far or flicking down calls `onClose`; otherwise
 * the sheet snaps back (instantly under reduced motion). Esc and the Close
 * button stay the keyboard/screen-reader way to dismiss — the handle is
 * pointer-only.
 *
 * The rest of the gesture is tracked on `window` (not via pointer capture,
 * which some browsers refuse), so it keeps following a finger that leaves the
 * small handle.
 */
export function useSheetDrag<T extends HTMLElement>(
  sheetRef: RefObject<T | null>,
  onClose: () => void
) {
  const closeRef = useRef(onClose);
  const stopRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    closeRef.current = onClose;
  });
  // Unmounting mid-drag (e.g. Esc) drops the window listeners.
  useEffect(() => () => stopRef.current?.(), []);

  const setOffset = (dy: number, animate: boolean) => {
    const el = sheetRef.current;
    if (!el) return;
    el.style.transition =
      animate && !prefersReducedMotion() ? "transform 0.22s cubic-bezier(0.16, 1, 0.3, 1)" : "none";
    el.style.transform = dy > 0 ? `translateY(${dy}px)` : "";
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    stopRef.current?.();
    const id = e.pointerId;
    const startY = e.clientY;
    const startT = e.timeStamp;
    let dy = 0;
    let active = false;

    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return;
      dy = Math.max(0, ev.clientY - startY);
      if (!active && dy < SLOP) return;
      active = true;
      ev.preventDefault();
      setOffset(dy, false);
    };
    const finish = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return;
      stop();
      if (!active) return;
      const height = sheetRef.current?.getBoundingClientRect().height ?? 0;
      const velocity = dy / Math.max(1, ev.timeStamp - startT);
      if (ev.type === "pointerup" && shouldDismissSheet(dy, velocity, height)) closeRef.current();
      else setOffset(0, true);
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      stopRef.current = null;
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    stopRef.current = stop;
  };

  return { onPointerDown };
}
