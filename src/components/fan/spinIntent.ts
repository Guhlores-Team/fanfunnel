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
/** A lease another page of this tab may hold (sessionStorage), with an expiry so a crashed page cannot wedge it. */
export interface IntentLease { storage: IntentStorage | null; now?: () => number; ttlMs?: number; pollMs?: number }
const LEASE_PREFIX = "ff-spin-lease-v1:";
const sameTabChains = new Map<string, Promise<unknown>>();
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function readLease(storage: IntentStorage, key: string): { id: string; until: number } | null {
  try {
    const value = JSON.parse(storage.getItem(key) ?? "null") as { id?: unknown; until?: unknown } | null;
    return value && typeof value.id === "string" && typeof value.until === "number" ? { id: value.id, until: value.until } : null;
  } catch { return null; }
}
/**
 * FD-4: the lock for browsers without the Web Locks API (Safari before 15.4,
 * older Chrome and Samsung Internet, some webviews). Calls in this page are
 * chained one after another, and where storage works a short lease also keeps
 * a second page of the same tab out. Cross-tab races are still settled by the
 * server, which commits a request id at most once.
 */
export function sameTabIntentLock({ storage, now = Date.now, ttlMs = 10_000, pollMs = 50 }: IntentLease): IntentLock {
  return async <T>(name: string, action: () => Promise<T>): Promise<T> => {
    const previous = sameTabChains.get(name) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(async () => {
      const key = LEASE_PREFIX + name, id = Math.random().toString(36).slice(2) + now().toString(36);
      let held = false;
      if (storage) {
        try {
          for (const deadline = now() + ttlMs; ;) {
            const lease = readLease(storage, key);
            if (!lease || lease.until <= now() || now() >= deadline) break;
            await sleep(pollMs);
          }
          storage.setItem(key, JSON.stringify({ id, until: now() + ttlMs }));
          held = readLease(storage, key)?.id === id;
        } catch { held = false; /* storage refused the lease: the chain alone still serializes this page */ }
      }
      try { return await action(); }
      finally {
        if (held && storage) try { if (readLease(storage, key)?.id === id) storage.removeItem(key); } catch { /* expires on its own */ }
      }
    });
    sameTabChains.set(name, run);
    try { return await run; }
    finally { if (sameTabChains.get(name) === run) sameTabChains.delete(name); }
  };
}
type LockManagerLike = { request?: <T>(name: string, action: () => Promise<T>) => Promise<T> } | undefined;
/** Web Locks where the browser has them, otherwise the same-tab fallback. */
export function chooseIntentLock(locks: LockManagerLike, lease: () => IntentStorage | null): IntentLock {
  if (typeof locks?.request === "function") {
    const request = locks.request.bind(locks);
    return async (name, action) => await request(name, action);
  }
  return sameTabIntentLock({ storage: lease() });
}
function sessionLease(): IntentStorage | null {
  try { return window.sessionStorage; } catch { return null; }
}
export async function browserSpinIntentStore(token: string): Promise<SpinIntentStore> {
  return { key: await spinIntentKey(token), storage: window.localStorage,
    lock: chooseIntentLock(typeof navigator === "undefined" ? undefined : navigator.locks as LockManagerLike, sessionLease) };
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
  absent: "Your spin has not been confirmed. Try this same spin again: it keeps the same request, so it can only count once.",
  unavailable: "We cannot check your spin right now. Your next play stays locked until this one is confirmed.",
  conflict: "This saved spin could not be matched safely. Keep this link and contact your creator before playing again.",
  storage: "Playing needs this browser to save a spin request safely. Allow site storage in your browser settings, then check again. You can still view your previous wins.",
  // FD-5: an app's built-in browser has no site settings to change.
  storageInApp: "This app's built-in browser can't save your spin safely. Open this link in your phone's browser (Safari or Chrome) to play. Your wins are saved.",
};

/** Only a bound, successful terminal status can release the saved identity. */
export function classifySpinStatus(value: unknown, httpOk: boolean):
  | { kind: "committed"; result: unknown }
  | { kind: "declined"; error: string }
  | { kind: "keep"; message: string; absent: boolean } {
  const body = value && typeof value === "object" ? value as Record<string, unknown> : {};
  if (httpOk && body.status === "committed" && body.result && typeof body.result === "object") return { kind: "committed", result: body.result };
  const terminalErrors = ["not_found", "no_spins", "no_prizes", "rate_limited", "blocked", "on_break", "needs_ack", "db_error"];
  if (httpOk && body.status === "declined" && typeof body.error === "string" && terminalErrors.includes(body.error)) return { kind: "declined", error: body.error };
  return { kind: "keep", absent: httpOk && body.status === "absent", message: body.status === "absent" ? SPIN_RECOVERY_COPY.absent
    : body.status === "conflict" ? SPIN_RECOVERY_COPY.conflict
    : httpOk && body.status === "pending" ? SPIN_RECOVERY_COPY.pending : SPIN_RECOVERY_COPY.unavailable };
}
