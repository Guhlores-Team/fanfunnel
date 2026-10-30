"use client";

export interface IntentStorage { getItem: (key: string) => string | null; setItem: (key: string, value: string) => void; removeItem: (key: string) => void }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Read metadata only; malformed receipts must never be silently replaced. */
export function readCreatorIntent(storage: IntentStorage, scope: string): { id: string; signature: string } | null {
  const previous = storage.getItem(`ff:creator-intent:${scope}`);
  if (previous === null) return null;
  let stored: { id?: unknown; signature?: unknown };
  try { stored = JSON.parse(previous); } catch { throw new Error("intent_unreadable"); }
  if (!stored || typeof stored !== "object" || typeof stored.id !== "string" || !UUID.test(stored.id) || typeof stored.signature !== "string" || !/^[a-f0-9]{64}$/.test(stored.signature)) throw new Error("intent_unreadable");
  return { id: stored.id, signature: stored.signature };
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
/** Persist only an opaque operation UUID and SHA-256 of the intended request. */
export async function durableCreatorIntent(storage: IntentStorage, scope: string, payload: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(payload)));
  const signature = Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const key = `ff:creator-intent:${scope}`;
  const stored = readCreatorIntent(storage, scope);
  if (stored) {
    if (stored.signature === signature) return stored.id;
    throw new Error("intent_pending");
  }
  const id = crypto.randomUUID();
  const receipt = JSON.stringify({ id, signature });
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
export const creatorIntent = (scope: string, payload: unknown) => durableCreatorIntent(window.sessionStorage, scope, payload);
export const creatorIntentComplete = (scope: string, id: string) => completeCreatorIntent(window.sessionStorage, scope, id);
export const creatorIntentReceipt = (scope: string) => readCreatorIntent(window.sessionStorage, scope);
