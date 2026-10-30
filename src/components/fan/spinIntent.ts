/** Durable browser intent. Storage contains no link token or reward value. */
export interface BrowserSpinIntent {
  v: 1;
  requestId: string;
  clientSeed: string;
  publishedSeedHash?: string;
}
export interface IntentStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
export type IntentLock = <T>(name: string, action: () => Promise<T>) => Promise<T>;
export interface SpinIntentStore { key: string; storage: IntentStorage; lock: IntentLock }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/i;

export function parseBrowserSpinIntent(value: string): BrowserSpinIntent {
  const x = JSON.parse(value) as Record<string, unknown>;
  if (!x || typeof x !== "object" || Array.isArray(x)
    || Object.keys(x).some(k => !["v", "requestId", "clientSeed", "publishedSeedHash"].includes(k))
    || x.v !== 1 || typeof x.requestId !== "string" || !UUID.test(x.requestId)
    || typeof x.clientSeed !== "string" || x.clientSeed.length > 256
    || (x.publishedSeedHash !== undefined && (typeof x.publishedSeedHash !== "string" || !HASH.test(x.publishedSeedHash)))) {
    throw new Error("Saved spin cannot be read safely");
  }
  return x as unknown as BrowserSpinIntent;
}
export async function spinIntentKey(token: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return "ff-spin-intent-v1:" + Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, "0")).join("");
}
export async function browserSpinIntentStore(token: string): Promise<SpinIntentStore> {
  if (!navigator.locks?.request) throw new Error("Safe browser storage is unavailable");
  return { key: await spinIntentKey(token), storage: window.localStorage,
    lock: async (name, action) => await navigator.locks.request(name, action) };
}
export function readBrowserSpinIntent(store: SpinIntentStore): BrowserSpinIntent | null {
  const value = store.storage.getItem(store.key);
  return value === null ? null : parseBrowserSpinIntent(value);
}
/** Serialize tabs. An existing unresolved intent always wins, regardless of age. */
export async function persistBrowserSpinIntent(
  store: SpinIntentStore,
  proposed: BrowserSpinIntent,
): Promise<BrowserSpinIntent> {
  return store.lock(store.key, async () => {
    const existing = readBrowserSpinIntent(store);
    if (existing) return existing;
    const text = JSON.stringify(parseBrowserSpinIntent(JSON.stringify(proposed)));
    store.storage.setItem(store.key, text);
    if (store.storage.getItem(store.key) !== text) throw new Error("Could not save spin safely");
    return proposed;
  });
}
/** Clear only after authoritative decline or explicit acknowledgement of a committed win. */
export async function finishBrowserSpinIntent(store: SpinIntentStore, requestId: string): Promise<boolean> {
  return store.lock(store.key, async () => {
    const current = readBrowserSpinIntent(store);
    if (current && current.requestId !== requestId) return false;
    store.storage.removeItem(store.key);
    if (store.storage.getItem(store.key) !== null) throw new Error("Could not finish saved spin");
    return true;
  });
}
export function spinIntentBody(token: string, intent: BrowserSpinIntent) {
  return { token, requestId: intent.requestId, clientSeed: intent.clientSeed,
    ...(intent.publishedSeedHash ? { publishedSeedHash: intent.publishedSeedHash } : {}) };
}
export const SPIN_RECOVERY_COPY = {
  pending: "Your spin is still being checked. Keep this page or return to this link to recover the same spin.",
  absent: "Your spin has not been confirmed. You can check again or retry this same spin. A retry keeps the same request.",
  unavailable: "We cannot check your spin right now. Your next play stays locked until this one is confirmed.",
  conflict: "This saved spin could not be matched safely. Keep this link and contact your creator before playing again.",
  storage: "Playing needs this browser to save a spin request safely. Allow site storage in your browser settings, then check again. You can still view your previous wins.",
};

/** Only a bound, successful terminal status can release the saved identity. */
export function classifySpinStatus(value: unknown, httpOk: boolean):
  | { kind: "committed"; result: unknown }
  | { kind: "declined"; error: string }
  | { kind: "keep"; message: string } {
  const body = value && typeof value === "object" ? value as Record<string, unknown> : {};
  if (httpOk && body.status === "committed" && body.result && typeof body.result === "object") return { kind: "committed", result: body.result };
  const terminalErrors = ["not_found", "no_spins", "no_prizes", "rate_limited", "blocked", "on_break", "needs_ack", "db_error"];
  if (httpOk && body.status === "declined" && typeof body.error === "string" && terminalErrors.includes(body.error)) return { kind: "declined", error: body.error };
  return { kind: "keep", message: body.status === "absent" ? SPIN_RECOVERY_COPY.absent
    : body.status === "conflict" ? SPIN_RECOVERY_COPY.conflict
    : httpOk && body.status === "pending" ? SPIN_RECOVERY_COPY.pending : SPIN_RECOVERY_COPY.unavailable };
}
