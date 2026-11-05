"use client";

export interface IntentStorage { getItem: (key: string) => string | null; setItem: (key: string, value: string) => void; removeItem: (key: string) => void }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** A game id (a UUID, or a demo-store id): never fan details or a link token. */
const GAME_ID = /^[A-Za-z0-9_-]{1,64}$/;
export interface CreatorIntentReceipt {
  id: string;
  signature: string;
  /** Top-up to a new link: the game that link is set to play once the grant
   *  commits. Kept with the receipt so a reload, a retry or "Check outcome"
   *  still sets it (the server's reply carries no game). */
  pin?: string;
}
/** Read metadata only; malformed receipts must never be silently replaced. */
export function readCreatorIntent(storage: IntentStorage, scope: string): CreatorIntentReceipt | null {
  const previous = storage.getItem(`ff:creator-intent:${scope}`);
  if (previous === null) return null;
  let stored: { id?: unknown; signature?: unknown; pin?: unknown };
  try { stored = JSON.parse(previous); } catch { throw new Error("intent_unreadable"); }
  if (!stored || typeof stored !== "object" || typeof stored.id !== "string" || !UUID.test(stored.id) || typeof stored.signature !== "string" || !/^[a-f0-9]{64}$/.test(stored.signature)) throw new Error("intent_unreadable");
  if (stored.pin !== undefined && (typeof stored.pin !== "string" || !GAME_ID.test(stored.pin))) throw new Error("intent_unreadable");
  return { id: stored.id, signature: stored.signature, ...(stored.pin !== undefined ? { pin: stored.pin as string } : {}) };
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
/** Persist only an opaque operation UUID and SHA-256 of the intended request,
 *  plus, for a top-up to a new link, the game id it is set to play (`pin`).
 *  A retry of the same request keeps the first submission's pin: the request,
 *  not the form's current state, decides which link the server credits. */
export async function durableCreatorIntent(storage: IntentStorage, scope: string, payload: unknown, pin?: string | null): Promise<string> {
  if (pin != null && !GAME_ID.test(pin)) throw new Error("intent_invalid_pin");
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(payload)));
  const signature = Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const key = `ff:creator-intent:${scope}`;
  const stored = readCreatorIntent(storage, scope);
  if (stored) {
    if (stored.signature === signature) return stored.id;
    throw new Error("intent_pending");
  }
  const id = crypto.randomUUID();
  const receipt = JSON.stringify(pin != null ? { id, signature, pin } : { id, signature });
  storage.setItem(key, receipt);
  if (storage.getItem(key) !== receipt) throw new Error("intent_not_persisted");
  return id;
}
export function completeCreatorIntent(storage: IntentStorage, scope: string, id: string) {
  const key = `ff:creator-intent:${scope}`;
  const stored = storage.getItem(key);
  if (!stored) return;
  let matches = false;
  try { matches = (JSON.parse(stored) as { id?: unknown } | null)?.id === id; } catch { /* never erase a request we cannot identify */ }
  if (matches) {
    storage.removeItem(key);
    if (storage.getItem(key) !== null) throw new Error("intent_not_cleared");
  }
}
export const creatorIntent = (scope: string, payload: unknown, pin?: string | null) => durableCreatorIntent(window.sessionStorage, scope, payload, pin);
export const creatorIntentComplete = (scope: string, id: string) => completeCreatorIntent(window.sessionStorage, scope, id);
export const creatorIntentReceipt = (scope: string) => readCreatorIntent(window.sessionStorage, scope);
