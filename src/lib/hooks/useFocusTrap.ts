"use client";

import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

export interface FocusTrapOptions {
  /** Whether the trap is active (the dialog is open). */
  active: boolean;
  /** Called when Escape is pressed. Omit to disable Escape (non-dismissable gates). */
  onEscape?: () => void;
  /**
   * Where to send focus on open. Defaults to the first focusable element in the
   * container. Pass a ref to override (e.g. focus a primary action button).
   */
  initialFocus?: RefObject<HTMLElement | null>;
  /** Restore focus to the previously-focused element on close. Defaults to true. */
  restoreFocus?: boolean;
}

/**
 * Keyboard focus management for a modal dialog, shared by every hand-rolled
 * dialog in the app:
 *  - moves focus into the dialog on open (initialFocus, else first focusable),
 *  - cycles Tab / Shift+Tab within the dialog,
 *  - calls `onEscape` on Escape (omit to keep a gate non-dismissable),
 *  - restores focus to the prior element on close.
 *
 * Attach the returned ref to the dialog container. The caller still renders its
 * own markup (with role="dialog" aria-modal="true"), so visuals are unchanged.
 */
export function useFocusTrap<T extends HTMLElement = HTMLDivElement>({
  active,
  onEscape,
  initialFocus,
  restoreFocus = true,
}: FocusTrapOptions): RefObject<T | null> {
  const containerRef = useRef<T>(null);
  // Keep onEscape current without re-running the trap effect on every render.
  // Synced in an effect so the ref is only written off-render.
  const escapeRef = useRef(onEscape);
  useEffect(() => {
    escapeRef.current = onEscape;
  });

  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    const previouslyFocused = document.activeElement as HTMLElement | null;

    // Move focus in: explicit target, else the first focusable element.
    const focusInitial = () => {
      if (initialFocus?.current) {
        initialFocus.current.focus();
        return;
      }
      const focusables = container?.querySelectorAll<HTMLElement>(FOCUSABLE);
      focusables?.[0]?.focus();
    };
    focusInitial();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && escapeRef.current) {
        escapeRef.current();
        return;
      }
      if (e.key !== "Tab" || !container) return;
      const focusables = container.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (restoreFocus) previouslyFocused?.focus?.();
    };
    // initialFocus / restoreFocus are read once on open; we intentionally only
    // re-run when `active` flips.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  return containerRef;
}
