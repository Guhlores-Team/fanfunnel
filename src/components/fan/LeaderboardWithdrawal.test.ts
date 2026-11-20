import assert from "node:assert/strict";
import { mock } from "node:test";
import { existsSync } from "node:fs";
import * as React from "react";
import type { FanPassView } from "@/lib/data/types";

// A small hook host executes the actual parent, board and withdrawal handlers.
// It stores React state; consent payload/validation and render decisions stay
// inside the production components under test.
type Host = { slots: unknown[]; cursor: number };
const host = (): Host => ({ slots: [], cursor: 0 });
let current: Host;
function slot<T>(initial: () => T) {
  const owner = current, index = owner.cursor++;
  if (!(index in owner.slots)) owner.slots[index] = initial();
  return { owner, index, value: owner.slots[index] as T };
}
let paused = false, onBreak = false, refreshes = 0;
const reads: string[] = [];
let boardView: unknown = { enabled: true, creatorTitle: "Creator", entries: [] };
mock.module("react", { namedExports: { ...React,
  useState: (initial: unknown) => {
    const state = slot(() => typeof initial === "function" ? initial() : initial);
    return [state.value, (next: unknown) => {
      state.owner.slots[state.index] = typeof next === "function" ? next(state.owner.slots[state.index]) : next;
    }];
  },
  useRef: (value: unknown) => slot(() => ({ current: value })).value,
  useReducer: (_reducer: unknown, initial: unknown) => [initial, () => {}],
  useMemo: (factory: () => unknown) => factory(),
  useCallback: (callback: unknown) => callback,
  useId: () => "withdrawal-control",
  useEffect: () => {},
} });
mock.module("next/navigation", { namedExports: { useRouter: () => ({ refresh() { refreshes++; } }) } });
mock.module("./useSpinRecovery", { namedExports: { useSpinRecovery: () => ({
  locked: false, sending: false, phase: "ready", begin() {}, acknowledge() {},
}) } });
mock.module("./LinkPauseProvider", { namedExports: {
  useLinkPause: () => ({ paused }),
  useFanBreak: () => ({ onBreak, breakUntil: onBreak ? "2099-01-01T00:00:00Z" : null,
    now: Date.parse("2026-10-28T00:00:00Z"), markOnBreak() {} }),
} });
mock.module("./useVisitGlow", { namedExports: { useVisitGlow: () => ({ glow: null, milestone: null, dismissMilestone() {} }) } });
mock.module("@/lib/hooks/useFocusTrap", { namedExports: { useFocusTrap: () => ({ current: null }) } });
mock.module("@/lib/sound", { namedExports: {
  playWin() {}, playBuildUp() {}, unlockAudio() {}, haptic() {}, prefersReducedMotion: () => false,
  playTick() {}, playPing() {},
} });
mock.module("@/lib/hooks/useFetch", { namedExports: { useFetch: (url: string) => {
  reads.push(url);
  return { data: boardView, loading: false, error: null, reload: async () => {}, setData() {} };
} } });

type Element = React.ReactElement<Record<string, unknown>>;
function elements(node: unknown): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!React.isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children)];
}
function run<T>(owner: Host, render: () => T): T { current = owner; owner.cursor = 0; return render(); }
function text(nodes: Element[]): string { return JSON.stringify(nodes.map(node => node.props.children)); }
const settle = async () => { for (let index = 0; index < 16; index++) await Promise.resolve(); };
let passed = 0;
function check(label: string, value: unknown) { assert.ok(value, label); passed++; }
async function main() {
  const controller = new URL("./FanGameController.tsx", import.meta.url);
  const specifier = existsSync(controller) ? "./" + "FanGameController" : "../" + "SpinClient";
  const { default: Client } = await import(specifier) as { default: (props: { pass: FanPassView }) => unknown };
  const { default: FanLeaderboard, LeaderboardWithdrawal } = await import("./FanLeaderboard");
  const { default: RecentWinsTicker } = await import("./RecentWinsTicker");
  const { default: PrizeBook } = await import("./PrizeBook");
  const { default: WinsGallery } = await import("./WinsGallery");
  const prize = { id: "prize", label: "Paid prize", rarity: "common" as const, weight: 1, color: "#123456" };
  const history = [{ label: "Earned win", rarity: "common" as const, at: "2026-10-27T00:00:00Z" }];
  const pass: FanPassView = { token: "withdraw-fan-a", fanName: "Fan", creatorTitle: "Creator", creatorId: "creator",
    leaderboardEnabled: true, leaderboardOptIn: true, spinsRemaining: 3, recentWins: history,
    wheel: { id: "wheel", title: "Wheel", prizes: [prize] },
    focus: { kind: "focus", prizeId: prize.id, prizeLabel: prize.label, multiplier: 3, totalSpins: 10,
      spinsLeft: 7, chaseWithin: 10, chaseCounter: 0, status: "active", pauseReason: null } };
  let breakFallback: Element | undefined;
  const parent = (next: FanPassView) => elements(run(host(), () => Client({ pass: next })));
  for (const state of ["blocked", "paused", "break", "board-off", "missing-creator"] as const) {
    paused = state === "paused"; onBreak = state === "break"; reads.length = 0;
    const next = { ...pass, blocked: state === "blocked", leaderboardEnabled: state !== "board-off",
      creatorId: state === "missing-creator" ? undefined : pass.creatorId };
    const nodes = parent(next), fallback = nodes.find(node => node.type === LeaderboardWithdrawal);
    check(`${state}: opted-in fans retain withdrawal`, !!fallback);
    check(`${state}: public competitive widgets remain absent`, !nodes.some(node => node.type === FanLeaderboard || node.type === RecentWinsTicker));
    if (fallback) run(host(), () => LeaderboardWithdrawal(fallback.props as Parameters<typeof LeaderboardWithdrawal>[0]));
    check(`${state}: withdrawal does not admit public reads`, reads.length === 0);
    check(`${state}: purchased focus and earned history remain readable`,
      (nodes.find(node => node.type === PrizeBook)?.props.focus as { spinsLeft?: number })?.spinsLeft === 7
      && JSON.stringify(nodes.find(node => node.type === WinsGallery)?.props.history) === JSON.stringify(history));
    check(`${state}: fans without consent get no withdrawal or invitation`, !parent({ ...next, leaderboardOptIn: false }).some(node => node.type === LeaderboardWithdrawal));
    if (state === "break") breakFallback = fallback;
  }
  assert.ok(breakFallback);
  paused = false; onBreak = false;
  const boardNode = (next: FanPassView) => {
    const node = parent(next).find(node => node.type === FanLeaderboard); assert.ok(node); return node;
  };
  const originalBoard = boardNode(pass), withdrawnBoard = boardNode({ ...pass, leaderboardOptIn: false });
  check("authoritative consent refresh remounts competitive board", originalBoard.key !== withdrawnBoard.key);
  check("fan identity change remounts competitive board", originalBoard.key !== boardNode({ ...pass, token: "withdraw-fan-b" }).key);
  check("ordinary paid play does not remount competitive board", originalBoard.key === boardNode({ ...pass, spinsRemaining: 2 }).key);
  onBreak = true;
  const otherFallback = parent({ ...pass, token: "withdraw-fan-b" }).find(node => node.type === LeaderboardWithdrawal);
  check("fan identity change remounts private withdrawal state", breakFallback.key !== otherFallback?.key);
  onBreak = false;
  // No public view (loading, 429 or 503), or a creator switching the board off,
  // must never make explicit withdrawal depend on a successful public read.
  for (const view of [null, { enabled: false, entries: [] }]) {
    boardView = view; reads.length = 0;
    const owner = host();
    const board = elements(run(owner, () => FanLeaderboard(originalBoard.props as Parameters<typeof FanLeaderboard>[0])));
    check(`${view ? "off" : "unavailable"}: opted-in board exposes withdrawal-only fallback`, board.some(node => node.type === LeaderboardWithdrawal));
    check(`${view ? "off" : "unavailable"}: no public join/ranking text`, !/Keep spinning|Top spinners|Board name/.test(text(board)));
    check(`${view ? "off" : "unavailable"}: no-consent board remains empty`, run(host(), () => FanLeaderboard({ ...originalBoard.props as Parameters<typeof FanLeaderboard>[0], optedIn: false })) === null);
  }
  boardView = { enabled: true, creatorTitle: "Creator", entries: [] };
  const freshWithdrawn = elements(run(host(), () => FanLeaderboard(withdrawnBoard.props as Parameters<typeof FanLeaderboard>[0])));
  const switchNode = freshWithdrawn.find(node => typeof node.type === "function");
  assert.ok(switchNode);
  const switchTree = elements(run(host(), () => (switchNode.type as (props: Record<string, unknown>) => unknown)(switchNode.props)));
  check("refreshed board initializes from server false, never a stale true", switchTree.find(node => node.props.role === "switch")?.props["aria-checked"] === false);

  const requests: { url: string; init: RequestInit | undefined; body: unknown }[] = [];
  let response: () => Promise<Response> = async () => new Response(JSON.stringify({ ok: true }));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init, body: JSON.parse(String(init?.body)) });
    return response();
  };
  try {
    let owner = host(); let nodes: Element[] = [];
    const render = (props = breakFallback!.props) => {
      nodes = elements(run(owner, () => LeaderboardWithdrawal(props as Parameters<typeof LeaderboardWithdrawal>[0]))); return nodes;
    };
    const button = () => { const node = nodes.find(node => node.props["data-testid"] === "leaderboard-withdraw"); assert.ok(node); return node; };
    const click = () => (button().props.onClick as () => void)();
    render();
    check("withdrawal mount performs no automatic request", requests.length === 0);
    check("withdrawal contains no join, rename, competition or keep-going control", !/Keep spinning|Top spinners|Board name|Join|Show me on/.test(text(nodes))
      && !nodes.some(node => node.type === "input" || node.props.role === "switch"));
    let release!: (response: Response) => void;
    response = () => new Promise(resolve => { release = resolve; });
    click(); click(); render();
    check("same-tick duplicate withdrawal is admitted once", requests.length === 1);
    check("pending withdrawal visibly disables its control", button().props.disabled === true);
    check("withdrawal sends only the fan token and false", JSON.stringify(requests[0].body) === JSON.stringify({ token: pass.token, optIn: false }));
    check("withdrawal remains a no-store JSON POST to existing consent route", requests[0].url === "/api/leaderboard/opt-in"
      && requests[0].init?.method === "POST" && requests[0].init.cache === "no-store"
      && (requests[0].init.headers as Record<string, string>)["Content-Type"] === "application/json");
    const beforeRefresh = refreshes;
    release(new Response(JSON.stringify({ ok: true }))); await settle(); render();
    check("confirmed success reports removal and refreshes authoritative pass", text(nodes).includes("You're off the leaderboard.") && refreshes === beforeRefresh + 1);
    click(); await settle();
    check("completed withdrawal cannot duplicate its write", requests.length === 1 && button().props.disabled === true);
    // Mount the other fan using the actual parent's identity key.
    owner = host(); render(otherFallback!.props);
    check("a new fan starts without the previous fan's success state", button().props.disabled === false && !text(nodes).includes("You're off the leaderboard."));
    response = async () => new Response(JSON.stringify({ ok: true }));
    click(); await settle(); render(otherFallback!.props);
    check("new fan's explicit action carries only its own token", JSON.stringify(requests.at(-1)?.body) === JSON.stringify({ token: "withdraw-fan-b", optIn: false }));
    for (const failure of ["http", "network", "malformed", "missing", "truthy", "array", "invalid-json"] as const) {
      owner = host(); render(); const requestCount = requests.length, refreshCount = refreshes;
      response = failure === "network" ? async () => { throw new Error("offline"); }
        : async () => failure === "invalid-json" ? new Response("bad-json") : new Response(JSON.stringify(
          failure === "http" ? { ok: true } : failure === "malformed" ? null : failure === "missing" ? {}
            : failure === "truthy" ? { ok: "true" } : [{ ok: true }]), { status: failure === "http" ? 503 : 200 });
      click(); await settle(); render();
      check(`${failure}: unconfirmed response never claims success`, !text(nodes).includes("You're off the leaderboard.") && refreshes === refreshCount);
      check(`${failure}: failure is announced with a retryable control`, nodes.some(node => node.props.role === "alert")
        && text(nodes).includes("Try again.") && button().props.disabled === false);
      response = async () => new Response(JSON.stringify({ ok: true }));
      click(); await settle(); render();
      check(`${failure}: explicit retry succeeds with one additional false-only write`, requests.length === requestCount + 2
        && text(nodes).includes("You're off the leaderboard.") && refreshes === refreshCount + 1
        && JSON.stringify(requests.at(-1)?.body) === JSON.stringify({ token: pass.token, optIn: false }));
    }
    // Execute the regular switch too: withdrawal refreshes authoritative props,
    // while joining again remains a deliberate, fully working operation.
    boardView = { enabled: true, creatorTitle: "Creator", entries: [] };
    const normalBoardOwner = host();
    const normalSwitchOwner = host();
    const normalBoardProps = { ...originalBoard.props as Parameters<typeof FanLeaderboard>[0], youHandle: "Saved_handle" };
    const normalBoard = () => elements(run(normalBoardOwner, () => FanLeaderboard(normalBoardProps)));
    const normalSwitch = () => {
      const child = normalBoard().find(node => typeof node.type === "function"); assert.ok(child);
      return elements(run(normalSwitchOwner, () => (child.type as (props: Record<string, unknown>) => unknown)(child.props)));
    };
    const normalRefresh = refreshes;
    let normalNodes = normalSwitch();
    (normalNodes.find(node => node.props.role === "switch")!.props.onClick as () => void)();
    await settle(); normalNodes = normalSwitch();
    check("regular switch withdrawal refreshes authoritative consent too", refreshes === normalRefresh + 1
      && normalNodes.find(node => node.props.role === "switch")?.props["aria-checked"] === false);
    check("regular switch withdrawal also omits the saved handle", JSON.stringify(requests.at(-1)?.body) === JSON.stringify({ token: pass.token, optIn: false }));
    (normalNodes.find(node => node.props.role === "switch")!.props.onClick as () => void)();
    await settle(); normalNodes = normalSwitch();
    check("intentional rejoin is not masked by a stale false override", normalNodes.find(node => node.props.role === "switch")?.props["aria-checked"] === true
      && JSON.stringify(requests.at(-1)?.body) === JSON.stringify({ token: pass.token, optIn: true, handle: "Saved_handle" }));
    const rejoinRequest = requests.at(-1); assert.equal((rejoinRequest!.body as { optIn: boolean }).optIn, true);
    // If the board read is unavailable, successful withdrawal also clears its
    // local consent immediately instead of waiting for public data to recover.
    boardView = null;
    const boardOwner = host();
    const renderBoard = () => elements(run(boardOwner, () => FanLeaderboard(originalBoard.props as Parameters<typeof FanLeaderboard>[0])));
    const unavailableFallback = renderBoard().find(node => node.type === LeaderboardWithdrawal); assert.ok(unavailableFallback);
    owner = host(); render(unavailableFallback.props); click(); await settle();
    check("unavailable public view does not block consent removal", renderBoard().length === 0);
    check("all withdrawal attempts remain false-only and omit names", requests.filter(request => request !== rejoinRequest).every(request => {
      const value = request.body as Record<string, unknown>;
      return value.optIn === false && !Object.hasOwn(value, "handle") && Object.keys(value).sort().join(",") === "optIn,token";
    }));
  } finally { globalThis.fetch = originalFetch; }
  console.log(`LeaderboardWithdrawal: ${passed} actual parent/control/consent lifecycle checks passed`);
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
