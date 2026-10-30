import assert from "node:assert/strict";
import { mock } from "node:test";
import { existsSync } from "node:fs";
import * as React from "react";
import type { FanPassView } from "@/lib/data/types";

let paused = false, onBreak = false;
const reads: string[] = [];
mock.module("react", { namedExports: { ...React,
  useState: (initial: unknown) => [typeof initial === "function" ? initial() : initial, () => {}],
  useRef: (value: unknown) => ({ current: value }),
  useReducer: (_reducer: unknown, initial: unknown) => [initial, () => {}],
  useMemo: (factory: () => unknown) => factory(),
  useCallback: (callback: unknown) => callback,
  useId: () => "widget-control",
  useEffect: () => {},
} });
mock.module("next/navigation", { namedExports: { useRouter: () => ({ refresh() {} }) } });
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
// The actual widgets remain in the test. Their shared transport hook records
// which public reads a mount would admit, without sending any network request.
mock.module("@/lib/hooks/useFetch", { namedExports: { useFetch: (url: string) => {
  reads.push(url);
  return { data: url.startsWith("/api/leaderboard/")
    ? { enabled: true, creatorTitle: "Creator", entries: [] } : [],
  loading: false, error: null, reload: async () => {}, setData() {} };
} } });

type Element = React.ReactElement<Record<string, unknown>>;
function elements(node: unknown): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!React.isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children)];
}
let passed = 0;
function check(label: string, value: unknown) { assert.ok(value, label); passed++; }
async function main() {
  const controller = new URL("./FanGameController.tsx", import.meta.url);
  const specifier = existsSync(controller) ? "./" + "FanGameController" : "../" + "SpinClient";
  const { default: Client } = await import(specifier) as { default: (props: { pass: FanPassView }) => unknown };
  const { default: FanLeaderboard } = await import("./FanLeaderboard");
  const { default: RecentWinsTicker } = await import("./RecentWinsTicker");
  const { default: PrizeBook } = await import("./PrizeBook");
  const { default: WinsGallery } = await import("./WinsGallery");
  const prize = { id: "prize", label: "Paid prize", rarity: "common" as const, weight: 1, color: "#123456" };
  const history = [{ label: "Earned win", rarity: "common" as const, at: "2026-10-27T00:00:00Z" }];
  const pass: FanPassView = { token: "unit-fan", fanName: "Fan", creatorTitle: "Creator", creatorId: "creator",
    leaderboardEnabled: true, spinsRemaining: 3, recentWins: history,
    wheel: { id: "wheel", title: "Wheel", prizes: [prize] },
    focus: { kind: "focus", prizeId: prize.id, prizeLabel: prize.label, multiplier: 3, totalSpins: 10,
      spinsLeft: 7, chaseWithin: 10, chaseCounter: 0, status: "active", pauseReason: null } };
  for (const state of ["eligible", "blocked", "paused", "break", "resumed", "board-off", "missing-creator"] as const) {
    paused = state === "paused"; onBreak = state === "break"; reads.length = 0;
    const current = { ...pass, blocked: state === "blocked", leaderboardEnabled: state !== "board-off",
      creatorId: state === "missing-creator" ? undefined : pass.creatorId };
    const tree = elements(Client({ pass: current }));
    const boards = tree.filter(element => element.type === FanLeaderboard);
    const tickers = tree.filter(element => element.type === RecentWinsTicker);
    const eligible = state === "eligible" || state === "resumed";
    check(`${state}: competitive board follows engagement and creator settings`, boards.length === (eligible ? 1 : 0));
    check(`${state}: promotional recent-wins ticker follows the same engagement gate`, tickers.length === (eligible ? 1 : 0));
    for (const widget of [...boards, ...tickers]) {
      if (widget.type === FanLeaderboard) FanLeaderboard(widget.props as Parameters<typeof FanLeaderboard>[0]);
      else RecentWinsTicker(widget.props as Parameters<typeof RecentWinsTicker>[0]);
    }
    check(`${state}: only eligible widget mounts admit public reads`, eligible
      ? reads.length === 2 && reads.some(url => url.startsWith("/api/leaderboard/creator"))
        && reads.some(url => url.startsWith("/api/recent-wins/creator")) : reads.length === 0);
    const book = tree.find(element => element.type === PrizeBook);
    const gallery = tree.find(element => element.type === WinsGallery);
    check(`${state}: purchased focus progress remains readable`, (book?.props.focus as { spinsLeft?: number })?.spinsLeft === 7);
    check(`${state}: earned history remains available`, JSON.stringify(gallery?.props.history) === JSON.stringify(history));
  }
  console.log(`EngagementWidgets: ${passed} actual parent/widget/read-admission checks passed`);
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
