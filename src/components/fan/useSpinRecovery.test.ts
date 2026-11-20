// Exercise the real hook's send/status/apply validation, not a copied validator.
import assert from "node:assert/strict";
import { mock } from "node:test";
import { setTimeout as tick } from "node:timers/promises";
import type { SpinResult } from "@/lib/games/wheel/types";
import { spinIntentKey } from "./spinIntent";

let effects: (() => void | (() => void))[] = [];
let states: unknown[] = [];
mock.module("react", { namedExports: {
  useCallback: <T>(fn: T) => fn,
  useRef: <T>(value: T) => ({ current: value }),
  useState: (value: unknown) => {
    const slot = states.length;
    states.push(value);
    return [value, (next: unknown) => { states[slot] = next; }];
  },
  useEffect: (effect: () => void | (() => void)) => { effects.push(effect); },
} });

const token = "test-fan-token";
const requestId = "4199c8cd-d2ea-4a3e-92b7-77fe34cdbf7a";
const saved = { v: 1, requestId, clientSeed: "seed", publishedSeedHash: "a".repeat(64) };
const prize = { id: "public-prize", label: "Server award", rarity: "rare", color: "#123456", weight: 1 };
const valid = { attemptId: requestId, prize, prizeIndex: 0, spinsRemaining: 2 };
let passed = 0;
function check(label: string, value: unknown) { assert.ok(value, label); passed++; }

async function main() {
  const { useSpinRecovery } = await import("./useSpinRecovery");
  function RecoveryHarness(props: Parameters<typeof useSpinRecovery>[0]) {
    return useSpinRecovery(props);
  }
  const key = await spinIntentKey(token);
  const memory = new Map<string, string>();
  const storage = { getItem: (k: string) => memory.get(k) ?? null,
    setItem: (k: string, value: string) => { memory.set(k, value); }, removeItem: (k: string) => { memory.delete(k); } };
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const install = (name: string, value: unknown) => {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  install("navigator", { locks: { request: async (_name: string, action: () => Promise<unknown>) => action() } });
  install("window", { localStorage: storage, addEventListener() {}, removeEventListener() {} });
  install("document", { visibilityState: "visible", addEventListener() {}, removeEventListener() {} });
  const bad: [string, unknown][] = [
    ["null", null], ["HTTP failure", valid], ["missing prize", { ...valid, prize: null }],
    ["wrong attempt", { ...valid, attemptId: "b17708ae-399b-4a63-bf72-952b068db026" }],
    ["fractional index", { ...valid, prizeIndex: 0.5 }], ["missing index", { ...valid, prizeIndex: undefined }],
    ["negative balance", { ...valid, spinsRemaining: -1 }], ["fractional balance", { ...valid, spinsRemaining: 0.5 }],
    ["unsafe balance", { ...valid, spinsRemaining: Number.MAX_SAFE_INTEGER + 1 }],
  ];
  try {
    for (const mode of ["status", "send"] as const) for (const [label, result] of [...bad, ["valid", valid]] as [string, unknown][]) {
      effects = []; states = []; memory.clear(); memory.set(key, JSON.stringify(saved));
      const observed: { result: SpinResult; present: boolean; recovered: boolean }[] = [];
      const requests: { path: string; body: unknown }[] = [];
      let ready = false;
      Object.defineProperty(globalThis, "fetch", { configurable: true, writable: true,
        value: async (path: string, init: RequestInit) => {
          requests.push({ path, body: JSON.parse(String(init.body)) });
          const body = mode === "send" && !ready ? { status: "pending" }
            : path === "/api/spin/status" ? { status: "committed", result } : result;
          return { ok: !(ready || mode === "status") || label !== "HTTP failure", json: async () => body };
        } });
      const hook = RecoveryHarness({ token, canRetry: true,
        onCommitted: (result, options) => { observed.push({ result, ...options }); }, onRefusal() {} });
      const cleanups = effects.map(effect => effect());
      try {
        // The actual initialization effect loads the real saved intent and runs
        // its scheduled status check. Wait for that request to finish, bounded.
        for (let i = 0; i < 30 && (requests.length === 0 || states[0] === "loading"); i++) await tick(1);
        check(`${mode}/${label}: initialization checked the saved identity`, requests.length === 1 && requests[0].path === "/api/spin/status");
        ready = true;
        if (mode === "send") await hook.retry();
        check(`${mode}/${label}: exact transport keys exclude all reveal state`, requests.every(request =>
          JSON.stringify(request.body) === JSON.stringify({ token, requestId, clientSeed: saved.clientSeed, publishedSeedHash: saved.publishedSeedHash })));
        check(`${mode}/${label}: saved intent survives until explicit acknowledgement`, memory.get(key) === JSON.stringify(saved));
        if (label === "valid") {
          check(`${mode}: only matching committed server result reaches presentation`, observed.length === 1 && observed[0].result === result && states[0] === "revealing");
          check(`${mode}: recovery flag follows the actual transport`, observed[0].recovered === (mode === "status"));
          await hook.check();
          check(`${mode}: replayed receipt cannot present a second win`, observed.length === 2 && observed[0].present && !observed[1].present);
          await hook.acknowledge();
          check(`${mode}: explicit acknowledgement clears exact saved request`, !memory.has(key) && states[0] === "ready");
        } else {
          check(`${mode}/${label}: malformed receipt never reaches reveal`, observed.length === 0 && states[0] === "pending");
        }
      } finally { cleanups.forEach(cleanup => cleanup?.()); }
    }
    // FD-3/FD-13: run one scenario against the real hook with scripted replies.
    const scenario = async (replies: Record<string, { ok: boolean; body: unknown }>, act: (hook: ReturnType<typeof useSpinRecovery>) => Promise<void>) => {
      effects = []; states = []; memory.clear(); memory.set(key, JSON.stringify(saved));
      const requests: string[] = [], refusals: unknown[] = [];
      Object.defineProperty(globalThis, "fetch", { configurable: true, writable: true,
        value: async (path: string) => { requests.push(path); const reply = replies[path]; return { ok: reply.ok, json: async () => reply.body }; } });
      const hook = RecoveryHarness({ token, canRetry: true, onCommitted() {}, onRefusal: code => { refusals.push(code); } });
      const cleanups = effects.map(effect => effect());
      try {
        for (let i = 0; i < 30 && (requests.length === 0 || states[0] === "loading"); i++) await tick(1);
        await act(hook);
      } finally { cleanups.forEach(cleanup => cleanup?.()); }
      return { requests, refusals };
    };
    {
      const run = await scenario({ "/api/spin/status": { ok: true, body: { status: "absent" } } }, async () => {});
      check("absent status offers the same request again (absent flag set)", states[0] === "pending" && states[2] === true && run.requests.join() === "/api/spin/status");
    }
    {
      const run = await scenario({ "/api/spin/status": { ok: true, body: { status: "pending" } } }, async () => {});
      check("a request still being checked is not offered as a retry", states[0] === "pending" && states[2] === false && run.requests.length === 1);
    }
    {
      const run = await scenario({ "/api/spin/status": { ok: true, body: { status: "absent" } },
        "/api/spin": { ok: false, body: { error: "blocked" } } }, async hook => { await hook.retry(); });
      check("FD-3: a blocked refusal releases the saved request instead of looping", !memory.has(key) && states[0] === "ready");
      check("FD-3: the fan is told the link isn't active", typeof states[1] === "string" && /isn't active/.test(states[1] as string));
      check("FD-3: the page is asked to refresh via the refusal", run.refusals.includes("blocked"));
    }
    {
      await scenario({ "/api/spin/status": { ok: true, body: { status: "absent" } },
        "/api/spin": { ok: false, body: { error: "spin_pending" } } }, async hook => { await hook.retry(); });
      check("an uncertain refusal still keeps the saved request", memory.get(key) === JSON.stringify(saved) && states[0] === "pending");
    }
    {
      // FD-4: no Web Locks API. The page still starts, saves the request and sends it.
      Object.defineProperty(globalThis, "navigator", { configurable: true, writable: true, value: { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 14_8 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.1.2 Mobile/15E148 Safari/604.1" } });
      const session = new Map<string, string>();
      Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: { localStorage: storage,
        sessionStorage: { getItem: (k: string) => session.get(k) ?? null, setItem: (k: string, v: string) => { session.set(k, v); }, removeItem: (k: string) => { session.delete(k); } },
        addEventListener() {}, removeEventListener() {} } });
      effects = []; states = []; memory.clear();
      const requests: string[] = [];
      Object.defineProperty(globalThis, "fetch", { configurable: true, writable: true,
        value: async (path: string, init: RequestInit) => { requests.push(path);
          return { ok: true, json: async () => ({ ...valid, attemptId: JSON.parse(String(init.body)).requestId }) }; } });
      const hook = RecoveryHarness({ token, canRetry: true, onCommitted() {}, onRefusal() {} });
      const cleanups = effects.map(effect => effect());
      try {
        for (let i = 0; i < 30 && states[0] === "loading"; i++) await tick(1);
        check("FD-4: without navigator.locks the page is ready, not a storage error", states[0] === "ready");
        await hook.begin("seed", null);
        check("FD-4: the spin is saved and sent once", requests.join() === "/api/spin" && memory.has(key));
        check("FD-4: no storage advice for a Locks problem", states[1] === null && states[0] === "revealing");
        check("FD-4: the same-tab lease is released after use", session.size === 0);
      } finally { cleanups.forEach(cleanup => cleanup?.()); }
    }
    {
      // FD-5: storage blocked inside Instagram's browser points at the phone's browser.
      Object.defineProperty(globalThis, "navigator", { configurable: true, writable: true, value: { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 307.0.0.34.111" } });
      Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: {
        get localStorage() { throw new DOMException("blocked", "SecurityError"); }, addEventListener() {}, removeEventListener() {} } });
      effects = []; states = [];
      const cleanups = effects.map(effect => effect());
      RecoveryHarness({ token, canRetry: true, onCommitted() {}, onRefusal() {} });
      const later = effects.map(effect => effect());
      try {
        for (let i = 0; i < 30 && states[0] === "loading"; i++) await tick(1);
        check("FD-5: blocked storage in an in-app browser says to open the phone's browser", states[0] === "storage" && /Safari or Chrome/.test(String(states[1])) && !/settings/.test(String(states[1])));
      } finally { [...cleanups, ...later].forEach(cleanup => cleanup?.()); }
    }
  } finally {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
  console.log(`useSpinRecovery: ${passed} actual hook transport/apply checks passed`);
}
const originalFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");
void main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  if (originalFetch) Object.defineProperty(globalThis, "fetch", originalFetch);
});
