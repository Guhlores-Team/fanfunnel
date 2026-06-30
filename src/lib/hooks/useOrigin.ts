"use client";

/**
 * The current page origin (e.g. "https://fanfunnel.app").
 *
 * SSR-safe: returns "" when there is no `window` (server / prerender),
 * otherwise `window.location.origin`. This is a drop-in replacement for the
 * hand-rolled `typeof window !== "undefined" ? window.location.origin : ""`
 * repeated across the dashboard, computed synchronously so callers that build
 * URLs during render keep behaving exactly as before.
 */
export function useOrigin(): string {
  return typeof window !== "undefined" ? window.location.origin : "";
}
