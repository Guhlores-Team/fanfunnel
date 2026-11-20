import assert from "node:assert/strict";
import { mock } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import * as React from "react";
import type { WonPrize } from "@/lib/data/types";

// Execute the real two components and their effects/handlers. This small host
// supplies hook storage and React's type/key instance identity; it does not copy
// the components' fetching, pagination, refresh or disclosure behavior.
type Effect = { deps?: readonly unknown[]; cleanup?: () => void };
type Host = { slots: unknown[]; cursor: number; pending: (() => void)[] };
const host = (): Host => ({ slots: [], cursor: 0, pending: [] });
let current: Host;
let id = 0;
const same = (left?: readonly unknown[], right?: readonly unknown[]) =>
  !!left && !!right && left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
function slot<T>(initial: () => T): { owner: Host; index: number; value: T } {
  const owner = current, index = owner.cursor++;
  if (!(index in owner.slots)) owner.slots[index] = initial();
  return { owner, index, value: owner.slots[index] as T };
}
function memo<T>(factory: () => T, deps?: readonly unknown[]): T {
  const state = slot<{ value: T; deps?: readonly unknown[] }>(() => ({ value: factory(), deps }));
  if (!same(state.value.deps, deps)) state.owner.slots[state.index] = { value: factory(), deps };
  return (state.owner.slots[state.index] as { value: T }).value;
}
mock.module("react", { namedExports: { ...React,
  useState: (initial: unknown) => {
    const state = slot(() => typeof initial === "function" ? initial() : initial);
    return [state.value, (next: unknown) => {
      state.owner.slots[state.index] = typeof next === "function" ? next(state.owner.slots[state.index]) : next;
    }];
  },
  useRef: (value: unknown) => slot(() => ({ current: value })).value,
  useId: () => slot(() => `history-panel-${++id}`).value,
  useMemo: memo,
  useCallback: (callback: () => unknown, deps?: readonly unknown[]) => memo(() => callback, deps),
  useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
    const state = slot<Effect>(() => ({}));
    if (same(state.value.deps, deps)) return;
    state.owner.pending.push(() => {
      state.value.cleanup?.();
      const cleanup = effect();
      state.owner.slots[state.index] = { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined };
    });
  },
} });
mock.module("@/lib/hooks/useNow", { namedExports: { useNow: () => Date.parse("2026-10-28T00:00:00Z") } });
mock.module("@/lib/hooks/useFocusTrap", { namedExports: { useFocusTrap: () => ({ current: null }) } });

type Element = React.ReactElement<Record<string, unknown>>;
function elements(node: unknown): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!React.isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children)];
}
function run<T>(owner: Host, render: () => T): T {
  current = owner; owner.cursor = 0;
  const tree = render();
  for (const effect of owner.pending.splice(0)) effect();
  return tree;
}
function dispose(owner: Host) {
  for (const value of owner.slots) if (value && typeof value === "object" && "cleanup" in value) {
    (value as Effect).cleanup?.();
  }
}
let passed = 0;
function check(label: string, value: unknown) { assert.ok(value, label); passed++; }
const settle = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };

async function main() {
  const { default: WinsGallery } = await import("./WinsGallery");
  const { default: InstantRewardHistory } = await import("./InstantRewardHistory");
  const controller = new URL("./FanGameController.tsx", import.meta.url);
  const gallerySource = readFileSync(existsSync(controller) ? controller : new URL("../SpinClient.tsx", import.meta.url), "utf8");
  check("the actual caller keys the gallery by fan identity", gallerySource.includes("<WinsGallery key={pass.token}"));
  const requests: { path: string; token: string; cursor?: string }[] = [];
  let rewardRequests = 0;
  const row = (shareId: string) => ({ shareId, at: "2026-10-27T00:00:00Z", label: `Saved ${shareId}`, rarity: "common" });
  let firstPage = [row("first")];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body)) as { token: string; cursor?: string };
    check("private reads remain no-store POSTs", init?.method === "POST" && init.cache === "no-store");
    if (String(url) === "/api/fan/reward") {
      rewardRequests++;
      return new Response(JSON.stringify({ reward: { kind: "code", value: "UNIT-NO-VALUE-REWARD" } }), { status: 200 });
    }
    assert.equal(String(url), "/api/fan/reward/history");
    requests.push({ path: String(url), ...body });
    return new Response(JSON.stringify({ wins: body.cursor ? [row("older")] : firstPage,
      nextCursor: body.cursor ? null : "older-cursor" }), { status: 200 });
  };
  const manual: WonPrize = { label: "Manual primary", rarity: "common", at: "2026-10-28T00:00:00Z" };
  let galleryHost = host(), historyHost = host(), token = "fan-a", nonce = 1;
  let childKey: string | null | undefined, mounts = 0;
  let tree: Element[] = [];
  let galleryNodes: Element[] = [];
  const render = () => {
    const gallery = run(galleryHost, () => WinsGallery({ token, historyNonce: nonce, history: [manual] }));
    galleryNodes = elements(gallery);
    const child = galleryNodes.find(element => element.type === InstantRewardHistory);
    assert.ok(child, "real gallery exposes paginated history");
    if (mounts === 0 || child.key !== childKey) {
      if (mounts) dispose(historyHost);
      historyHost = host(); mounts++; childKey = child.key;
    }
    tree = elements(run(historyHost, () => InstantRewardHistory(child.props as Parameters<typeof InstantRewardHistory>[0])));
    return tree;
  };
  const byId = (name: string) => {
    const node = tree.find(element => element.props["data-testid"] === name);
    assert.ok(node, `real ${name} control exists`); return node;
  };
  const click = async (name: string) => {
    (byId(name).props.onClick as () => void)(); await settle(); render();
  };
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    check("an untouched empty gallery remains hidden", run(host(), () => WinsGallery({ token, history: [], historyNonce: 0 })) === null);
    check("a credited empty recent gallery still exposes saved-history access", elements(run(host(), () => WinsGallery({ token, history: [], historyNonce: 1 })))
      .some(element => element.type === InstantRewardHistory));
    for (nonce = 1; nonce <= 24; nonce++) { render(); mock.timers.tick(0); await settle(); }
    check("24 credited plays do not make unsolicited reward-history requests", requests.length === 0);
    check("credited plays preserve the unopened history instance", mounts === 1);
    check("history starts collapsed", byId("reward-history-toggle").props["aria-expanded"] === false);
    await click("reward-history-toggle");
    check("explicit opening requests exactly one first page", requests.length === 1 && requests[0].cursor === undefined);
    check("explicit opening uses only this fan's token", requests[0].token === "fan-a");
    check("first page is rendered", tree.filter(element => element.props["data-testid"] === "reward-history-win").length === 1);
    for (nonce = 25; nonce <= 48; nonce++) { render(); mock.timers.tick(0); await settle(); }
    check("24 more credited plays do not refetch an open history panel", requests.length === 1);
    check("open history stays open and retains its first-page result", byId("reward-history-toggle").props["aria-expanded"] === true
      && tree.filter(element => element.props["data-testid"] === "reward-history-win").length === 1 && mounts === 1);
    await click("reward-history-more");
    check("explicit pagination uses the real next cursor", requests.length === 2 && requests[1].cursor === "older-cursor");
    check("older page is appended without removing the current page", tree.filter(element => element.props["data-testid"] === "reward-history-win").length === 2);
    firstPage = [row("newest"), row("first")];
    await click("reward-history-refresh");
    check("explicit Refresh requests exactly one fresh first page", requests.length === 3 && requests[2].cursor === undefined);
    check("Refresh replaces older pages with current first-page results", tree.filter(element => element.props["data-testid"] === "reward-history-win").length === 2
      && JSON.stringify(tree.map(element => element.props.children)).includes("Saved newest"));
    await click("reward-history-toggle");
    check("closing the panel adds no request and hides saved references", requests.length === 3
      && byId("reward-history-toggle").props["aria-expanded"] === false && !tree.some(element => element.props["data-testid"] === "reward-history-win"));
    await click("reward-history-toggle");
    check("reopening loaded history preserves its pages without another request", requests.length === 3
      && tree.filter(element => element.props["data-testid"] === "reward-history-win").length === 2);
    await click("reward-history-view");
    const dialog = galleryNodes.find(element => element.props.view && typeof element.props.onClose === "function");
    assert.ok(dialog, "real gallery opens saved reward dialog");
    check("explicit View reward loads the immutable private value", rewardRequests === 1
      && (dialog.props.view as { reward?: { value: string } }).reward?.value === "UNIT-NO-VALUE-REWARD");
    (dialog.props.onClose as () => void)(); render();
    check("closing clears the actual gallery's decrypted reward state", !galleryNodes.some(element => element.props.view));
    await click("reward-history-view");
    check("a second explicit view requests the value afresh", rewardRequests === 2 && galleryNodes.some(element => element.props.view));
    // Model the actual caller's token key: changing fans unmounts both instances.
    dispose(historyHost); dispose(galleryHost); galleryHost = host(); historyHost = host(); mounts = 0; childKey = undefined;
    token = "fan-b"; nonce = 1; render(); mock.timers.tick(0); await settle();
    check("switching fans clears open history and prior fan references", byId("reward-history-toggle").props["aria-expanded"] === false
      && !tree.some(element => element.props["data-testid"] === "reward-history-win") && requests.length === 3
      && !galleryNodes.some(element => element.props.view));
    await click("reward-history-toggle");
    check("new fan's explicit open sends only its own identity", requests.length === 4 && requests[3].token === "fan-b");
  } finally { dispose(historyHost); dispose(galleryHost); mock.timers.reset(); globalThis.fetch = originalFetch; }
  console.log(`WinsGalleryHistory: ${passed} actual component lifecycle/request checks passed`);
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
