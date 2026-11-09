"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * Text a creator typed that must survive leaving a section and coming back
 * (C14): the inbox reply per thread, the Public page tagline and note. Kept in
 * this tab's memory only, never in storage, so it is gone after a reload. The
 * dashboard therefore asks before a reload or sign-out while any is held.
 */
interface Entry { value: string; description: string }
const store = new Map<string, Entry>();
const listeners = new Set<() => void>();
let version = 0;
const emit = () => { version++; for (const l of listeners) l(); };

export function subscribeSessionDrafts(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function readSessionDraft(key: string): string | undefined {
  return store.get(key)?.value;
}
/** `null` (or the saved value, via the hook) forgets the draft. */
export function writeSessionDraft(key: string, value: string | null, description = "unsaved text") {
  if (value === null) {
    if (!store.delete(key)) return;
  } else {
    const old = store.get(key);
    if (old?.value === value && old.description === description) return;
    store.set(key, { value, description });
  }
  emit();
}
/** What the leave prompt names ("an unsent reply"), once each. */
export function sessionDraftDescriptions(): string[] {
  return [...new Set([...store.values()].map((e) => e.description))];
}
export function clearSessionDrafts() {
  if (store.size === 0) return;
  store.clear();
  emit();
}
const snapshot = () => version;

/** Whether any session draft is held (re-renders on change). */
export function useSessionDraftsHeld(): boolean {
  useSyncExternalStore(subscribeSessionDrafts, snapshot, () => 0);
  return store.size > 0;
}

/**
 * `useState` for a text field whose unsaved value outlives the component.
 * `base` is the saved value: typing it back (or `clear()` after a save)
 * forgets the draft. `key` null: plain state is not kept (nothing loaded yet).
 */
export function useSessionDraft(key: string | null, base: string, description: string) {
  useSyncExternalStore(subscribeSessionDrafts, snapshot, () => 0);
  const held = key ? store.get(key)?.value : undefined;
  const value = held ?? base;
  const set = useCallback((next: string | ((prev: string) => string)) => {
    if (!key) return;
    const prev = store.get(key)?.value ?? base;
    const v = typeof next === "function" ? next(prev) : next;
    writeSessionDraft(key, v === base ? null : v, description);
  }, [key, base, description]);
  const clear = useCallback(() => { if (key) writeSessionDraft(key, null); }, [key]);
  return [value, set, clear, held !== undefined] as const;
}
