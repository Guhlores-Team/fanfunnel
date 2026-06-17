// In-app debug error console — shared store + activation flag.
//
// Producers (window listeners + the React error boundary) push here; the
// DebugConsole panel subscribes. Everything is gated behind `isDebugActive()`
// so that when debug mode is OFF we register nothing and surface nothing.

export type CapturedKind = "error" | "unhandledrejection" | "react";

export interface CapturedError {
  id: number;
  kind: CapturedKind;
  message: string;
  source?: string;
  line?: number;
  column?: number;
  stack?: string;
  timestamp: number;
}

// Session-scoped so debug is NOT sticky across browser restarts (it previously
// persisted in localStorage, which made it "always on" forever).
const SS_KEY = "ff:debug";
const LEGACY_LS_KEY = "ff:debug";

// The in-app console only activates for admins. DebugConsole confirms admin via
// /api/me and flips this; until then nothing activates, even with ?debug=1.
let adminOk = false;

/**
 * Resolve whether the in-app console is active, honoring (and persisting) the
 * URL switch:
 *   ?debug=1  → turn on  + remember (localStorage)
 *   ?debug=0  → turn off + forget
 *   otherwise → whatever was remembered
 * Safe to call during SSR (returns false; there's no window).
 */
export function resolveDebug(): boolean {
  if (typeof window === "undefined") return false;
  // Migration: a previous build persisted this flag in localStorage, which made
  // debug "always on" forever. Purge that legacy key so it can never re-activate.
  try {
    window.localStorage.removeItem(LEGACY_LS_KEY);
  } catch {
    /* ignore */
  }
  let fromUrl: string | null = null;
  try {
    fromUrl = new URLSearchParams(window.location.search).get("debug");
  } catch {
    /* malformed URL — ignore */
  }
  if (fromUrl === "1") {
    try {
      window.sessionStorage.setItem(SS_KEY, "1");
    } catch {
      /* storage blocked — still active for this load */
    }
    return true;
  }
  if (fromUrl === "0") {
    try {
      window.sessionStorage.removeItem(SS_KEY);
    } catch {
      /* ignore */
    }
    return false;
  }
  try {
    return window.sessionStorage.getItem(SS_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Cheap re-check used by producers (the error boundary) that can fire before
 * the console component has mounted. Reads the persisted flag / URL directly.
 */
export function isDebugActive(): boolean {
  // Admin-gated: never active until DebugConsole confirms the user is an admin.
  return adminOk && resolveDebug();
}

const errors: CapturedError[] = [];
const listeners = new Set<(errors: CapturedError[]) => void>();
let nextId = 1;

function emit() {
  for (const l of listeners) l(errors.slice());
}

/**
 * Admin gate setter. DebugConsole calls this after confirming admin via /api/me.
 * Non-admins never flip this, so the console (and error capture) stays inert.
 */
export function setDebugAdmin(value: boolean): void {
  if (adminOk === value) return;
  adminOk = value;
  emit();
}

/** Record one captured error (newest is kept at the front of the list). */
export function reportError(
  e: Omit<CapturedError, "id" | "timestamp">
): void {
  // Only retain anything while debug mode is active.
  if (!isDebugActive()) return;
  errors.unshift({ ...e, id: nextId++, timestamp: Date.now() });
  // Bound memory: keep the most recent 200.
  if (errors.length > 200) errors.length = 200;
  emit();
}

export function getErrors(): CapturedError[] {
  return errors.slice();
}

export function clearErrors(): void {
  errors.length = 0;
  emit();
}

export function subscribe(fn: (errors: CapturedError[]) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
