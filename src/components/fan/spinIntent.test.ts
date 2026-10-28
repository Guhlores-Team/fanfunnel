import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import FocusChip, { FOCUS_PAUSE_COPY } from "./FocusChip";
import { mergeFanWins } from "./spinPresentation";
import type { FanFocusView } from "@/lib/data/focusView";
import { classifySpinStatus, finishBrowserSpinIntent, parseBrowserSpinIntent, persistBrowserSpinIntent, readBrowserSpinIntent, spinIntentBody,
  spinIntentKey, type BrowserSpinIntent, type IntentLock, type SpinIntentStore, SPIN_RECOVERY_COPY } from "./spinIntent";

let passed = 0;
function check(label: string, value: unknown) { assert.ok(value, label); passed++; }
const first: BrowserSpinIntent = { v: 1, requestId: "4199c8cd-d2ea-4a3e-92b7-77fe34cdbf7a", clientSeed: "client-seed", publishedSeedHash: "a".repeat(64) };
const second = { ...first, requestId: "b17708ae-399b-4a63-bf72-952b068db026" };
const memory = new Map<string, string>();
let queue: Promise<unknown> = Promise.resolve();
const lock: IntentLock = (_name, action) => {
  const next = queue.then(action); queue = next.catch(() => undefined); return next;
};
const store: SpinIntentStore = { key: "hashed-key", lock, storage: {
  getItem: key => memory.get(key) ?? null,
  setItem: (key, value) => { memory.set(key, value); },
  removeItem: key => { memory.delete(key); },
} };
async function main() {
  assert.deepEqual(parseBrowserSpinIntent(JSON.stringify(first)), first); passed++;
  for (const value of [null, {}, { status: "absent" }, { status: "pending" }, { status: "conflict" }, { status: "unavailable" },
    { status: "declined", error: "spin_pending" }, { status: "declined", error: "unknown" }, { status: "committed" }, { status: "committed", result: null }]) {
    check("nonterminal or malformed status retains identity " + JSON.stringify(value), classifySpinStatus(value, true).kind === "keep");
  }
  check("HTTP failure cannot authorize a decline", classifySpinStatus({ status: "declined", error: "no_spins" }, false).kind === "keep");
  check("only successful authoritative decline releases identity", classifySpinStatus({ status: "declined", error: "no_spins" }, true).kind === "declined");
  check("committed outcome is recovered without starting play", classifySpinStatus({ status: "committed", result: { attemptId: first.requestId } }, true).kind === "committed");
  const token = "fan-secret-link-token";
  const key = await spinIntentKey(token);
  check("storage key hashes bearer token", key.length > 64 && !key.includes(token));
  check("hash key stable for same link", key === await spinIntentKey(token));
  check("different link has distinct storage key", key !== await spinIntentKey(token + "other"));
  for (const value of ["null", "[]", "{}", "garbage", JSON.stringify({ ...first, token }), JSON.stringify({ ...first, reward: "secret" }),
    JSON.stringify({ ...first, publishedSeedHash: "wrong" }), JSON.stringify({ ...first, requestId: "not-uuid" }), JSON.stringify({ ...first, clientSeed: "x".repeat(257) })]) {
    assert.throws(() => parseBrowserSpinIntent(value)); passed++;
  }
  const [a,b] = await Promise.all([persistBrowserSpinIntent(store, first), persistBrowserSpinIntent(store, second)]);
  check("racing tabs share original requestId", a.requestId === first.requestId && b.requestId === first.requestId);
  check("persisted before any caller can POST", readBrowserSpinIntent(store)?.requestId === first.requestId);
  const before = memory.get(store.key);
  await persistBrowserSpinIntent(store, second);
  check("unknown/absent has no expiry or replacement", memory.get(store.key) === before);
  assert.deepEqual(spinIntentBody(token, a), spinIntentBody(token, b)); passed++;
  check("storage contains neither token nor reward", !before?.includes(token) && !before?.includes("reward"));
  check("stale tab cannot clear newer request", !await finishBrowserSpinIntent(store, second.requestId));
  check("old request survived stale clear", readBrowserSpinIntent(store)?.requestId === first.requestId);
  check("authoritative terminal acknowledgement clears matching intent", await finishBrowserSpinIntent(store, first.requestId));
  check("cleared slot can hold next explicitly initiated play", (await persistBrowserSpinIntent(store, second)).requestId === second.requestId);
  const broken: SpinIntentStore = { ...store, storage: { ...store.storage, setItem: () => { throw new Error("quota"); } } };
  memory.clear();
  await assert.rejects(persistBrowserSpinIntent(broken, first)); passed++;
  check("storage failure has no saved request to send", readBrowserSpinIntent(store) === null);
  memory.set(store.key, "malformed");
  await assert.rejects(persistBrowserSpinIntent(store, first)); passed++;
  check("corrupt pending intent never overwritten", memory.get(store.key) === "malformed");
  const silent: SpinIntentStore = { ...store, storage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined } };
  await assert.rejects(persistBrowserSpinIntent(silent, first)); passed++;
  check("unavailable copy locks before another play", /locked until/.test(SPIN_RECOVERY_COPY.unavailable));
  check("absent offers same identity only", /same spin/.test(SPIN_RECOVERY_COPY.absent));
  const focus: FanFocusView = { kind: "focus", prizeId: "target", prizeLabel: "Private target", multiplier: 3, totalSpins: 10, spinsLeft: 7,
    chaseWithin: 10, chaseCounter: 3, status: "active", pauseReason: null };
  const markup = (value: FanFocusView, onBreak = false) => renderToStaticMarkup(createElement(FocusChip, { focus: value, onBreak }));
  check("focus uses authoritative remaining count", markup(focus).includes("7 focused spins left"));
  check("requested multiplier is not mislabelled actual combined odds", markup(focus).includes("up to ×3"));
  for (const pauseReason of Object.keys(FOCUS_PAUSE_COPY) as (keyof typeof FOCUS_PAUSE_COPY)[]) {
    check("pause copy " + pauseReason, markup({ ...focus, status: "paused", pauseReason }).includes(FOCUS_PAUSE_COPY[pauseReason]));
  }
  check("break pauses presentation without urging play", markup(focus, true).includes("paused during your break"));
  check("chase progress uses actual server count", markup({ ...focus, kind: "chase" }).includes("Guaranteed within 7 eligible spins"));
  check("completed pack does not nudge another play", markup({ ...focus, status: "completed" }) === "");
  check("cancelled pack hidden", markup({ ...focus, status: "cancelled" }) === "");
  const old = { label: "Old win", rarity: "common" as const, shareId: "older", at: "2026-01-01T00:00:00Z" };
  const recent = { ...old, label: "Latest win", shareId: "latest", at: "2026-02-01T00:00:00Z" };
  const merged = mergeFanWins([old, recent], [{ ...old, at: "2026-10-01T00:00:00Z" }]);
  check("recovered history remains one event", merged.length === 2);
  check("server timestamp wins over a stale local copy", merged[1].at === old.at);
  check("late recovery cannot reorder an older win as fresh", merged[0].shareId === recent.shareId);
  check("history helper does not mutate server win", old.at === "2026-01-01T00:00:00Z");
  console.log(`spinIntent.test: ${passed} checks passed`);
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
