import assert from "node:assert/strict";
import { browserSpinIntentStore, chooseIntentLock, sameTabIntentLock, type IntentStorage } from "./spinIntent";

// FD-4: without the Web Locks API (Safari < 15.4, older Chrome/Samsung
// Internet, some webviews) the fan can still spin: calls are serialized in the
// page and a short sessionStorage lease, with an expiry, guards the tab.
let passed = 0;
function check(label: string, value: unknown) { assert.ok(value, label); passed++; }
const memoryStorage = () => {
  const map = new Map<string, string>();
  const storage: IntentStorage & { map: Map<string, string> } = { map,
    getItem: k => map.get(k) ?? null, setItem: (k, v) => { map.set(k, v); }, removeItem: k => { map.delete(k); } };
  return storage;
};
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  {
    const storage = memoryStorage();
    const lock = sameTabIntentLock({ storage, pollMs: 2 });
    const order: string[] = [];
    let inside = 0, overlap = false;
    const job = (name: string, ms: number) => lock("k", async () => {
      inside++; if (inside > 1) overlap = true;
      order.push(name + ":start"); await wait(ms); order.push(name + ":end"); inside--; return name;
    });
    const results = await Promise.all([job("a", 15), job("b", 1), job("c", 5)]);
    check("calls never overlap", !overlap);
    check("calls run in order", order.join() === "a:start,a:end,b:start,b:end,c:start,c:end");
    check("each call gets its own result", results.join() === "a,b,c");
    check("the lease is released", storage.map.size === 0);
  }
  {
    const storage = memoryStorage();
    const lock = sameTabIntentLock({ storage, pollMs: 2 });
    await assert.rejects(lock("k", async () => { throw new Error("boom"); })); passed++;
    check("a failed call releases the lease", storage.map.size === 0);
    check("the next call still runs after a failure", await lock("k", async () => "next") === "next");
  }
  {
    // Another page of this tab holds a lease: wait for it, then take over once it expires.
    let clock = 1_000;
    const storage = memoryStorage();
    storage.setItem("ff-spin-lease-v1:k", JSON.stringify({ id: "other", until: 1_050 }));
    const lock = sameTabIntentLock({ storage, now: () => clock, ttlMs: 10_000, pollMs: 1 });
    let ran = false;
    const pending = lock("k", async () => { ran = true; });
    await wait(10);
    check("a live lease held by another page is waited for", !ran);
    clock = 1_100;
    await pending;
    check("an expired lease no longer blocks", ran && storage.map.size === 0);
  }
  {
    const throwing: IntentStorage = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); }, removeItem: () => { throw new Error("denied"); } };
    const lock = sameTabIntentLock({ storage: throwing });
    check("storage that refuses the lease still lets the call run", await lock("k", async () => 7) === 7);
    check("no storage at all still runs", await sameTabIntentLock({ storage: null })("k", async () => 8) === 8);
  }
  {
    let used = 0;
    const real = chooseIntentLock({ request: async <T>(_name: string, action: () => Promise<T>) => { used++; return action(); } }, () => null);
    await real("k", async () => undefined);
    check("Web Locks are used where present", used === 1);
    let leaseAsked = 0;
    const fallback = chooseIntentLock(undefined, () => { leaseAsked++; return memoryStorage(); });
    check("a browser without Web Locks gets the same-tab lock", await fallback("k", async () => "ok") === "ok" && leaseAsked === 1);
  }
  {
    const originals = ["navigator", "window"].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
    try {
      const local = memoryStorage(), session = memoryStorage();
      Object.defineProperty(globalThis, "navigator", { configurable: true, writable: true, value: {} });
      Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: { localStorage: local, sessionStorage: session } });
      const store = await browserSpinIntentStore("token");
      check("without navigator.locks the store opens instead of throwing", store.storage === local);
      check("its lock runs", await store.lock(store.key, async () => "ran") === "ran");
    } finally {
      for (const [name, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
      }
    }
  }
  console.log(`spinIntentLock: ${passed} checks passed`);
}
main().catch(error => { console.error(error); process.exit(1); });
