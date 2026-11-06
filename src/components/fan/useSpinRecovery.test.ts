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
