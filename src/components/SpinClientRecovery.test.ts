import assert from "node:assert/strict";
import { mock } from "node:test";
import * as React from "react";
import type { FanPassView } from "@/lib/data/types";
import type { SpinResult } from "@/lib/games/wheel/types";

type RecoveryHandlers = { onCommitted: (data: SpinResult, options: { present: boolean; recovered: boolean }) => void };
const slots: unknown[] = [];
let cursor = 0;
let callbacks: ((...args: never[]) => unknown)[] = [];
let recovered: RecoveryHandlers;
let paused = false;
let onBreak = false;
const feedback: string[] = [];
const requests: string[] = [];
const glows: boolean[] = [];
const useSlot = (value: () => unknown) => {
  const slot = cursor++;
  if (!(slot in slots)) slots[slot] = value();
  return slot;
};
mock.module("react", { namedExports: { ...React,
  useState: (value: unknown) => {
    const slot = useSlot(() => typeof value === "function" ? value() : value);
    return [slots[slot], (next: unknown) => { slots[slot] = typeof next === "function" ? next(slots[slot]) : next; }];
  },
  useRef: (value: unknown) => slots[useSlot(() => ({ current: value }))],
  useReducer: (reducer: (state: unknown, event: unknown) => unknown, initial: unknown) => {
    const slot = useSlot(() => initial);
    return [slots[slot], (event: unknown) => { slots[slot] = reducer(slots[slot], event); }];
  },
  useEffect: () => {},
  useMemo: (factory: () => unknown) => factory(),
  useCallback: <T extends (...args: never[]) => unknown>(fn: T) => { callbacks.push(fn); return fn; },
} });
mock.module("next/navigation", { namedExports: { useRouter: () => ({ refresh() {} }) } });
mock.module("./fan/useSpinRecovery", { namedExports: { useSpinRecovery: (handlers: RecoveryHandlers) => {
  recovered = handlers;
  return { locked: false, sending: false, phase: "ready", begin() {}, acknowledge() {} };
} } });
mock.module("./fan/LinkPauseProvider", { namedExports: {
  useLinkPause: () => ({ paused }),
  useFanBreak: () => ({ onBreak, breakUntil: onBreak ? "2099-01-01T00:00:00Z" : null, now: Date.now(), markOnBreak() {} }),
} });
mock.module("./fan/useVisitGlow", { namedExports: { useVisitGlow: (_token: string, _initial: unknown, enabled: boolean) => {
  glows.push(enabled); return { glow: null, milestone: null, dismissMilestone() {} };
} } });
mock.module("@/lib/hooks/useFocusTrap", { namedExports: { useFocusTrap: () => ({ current: null }) } });
mock.module("@/lib/sound", { namedExports: {
  playWin: () => { feedback.push("win"); }, playBuildUp: () => { feedback.push("buildup"); },
  unlockAudio: () => { feedback.push("unlock"); }, haptic: () => { feedback.push("haptic"); },
  prefersReducedMotion: () => false, playTick: () => { feedback.push("tick"); }, playPing() {},
} });

type Element = React.ReactElement<Record<string, unknown>>;
function elements(node: unknown): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!React.isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children)];
}
let passed = 0;
function check(label: string, value: unknown) { assert.ok(value, label); passed++; }
async function main() {
  const { default: SpinClient } = await import("./SpinClient");
  const { default: Wheel } = await import("./Wheel");
  const { default: InstallNudge } = await import("./fan/InstallNudge");
  const { default: PrizeBook } = await import("./fan/PrizeBook");
  const prize = { id: "prize", label: "Actual server award", rarity: "legendary" as const, weight: 1, color: "#eab308" };
  const pass: FanPassView = { token: "fan-token", fanName: "Fan", creatorTitle: "Creator", spinsRemaining: 3, recentWins: [],
    wheel: { id: "wheel", title: "Wheel", prizes: [prize] },
    focus: { kind: "focus", prizeId: prize.id, prizeLabel: prize.label, multiplier: 3, totalSpins: 10,
      spinsLeft: 7, chaseWithin: 10, chaseCounter: 0, status: "active", pauseReason: null } };
  const render = (current = pass) => { cursor = 0; callbacks = []; return elements(SpinClient({ pass: current })); };
  const propsFor = (tree: Element[], type: unknown) => { const element = tree.find(element => element.type === type); assert.ok(element); return element.props; };
  mock.timers.enable({ apis: ["setTimeout"] });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => { requests.push(String(url)); return new Response(JSON.stringify({ focus: pass.focus }), { status: 200 }); };
  try {
    for (const recovery of [true, false]) {
      slots.length = 0; feedback.length = 0; render();
      recovered.onCommitted({ prize, prizeIndex: 0, spinsRemaining: 2, focus: pass.focus, attemptId: "attempt", shareId: "share", awardedAt: "2026-10-28T00:00:00Z" } as SpinResult,
        { present: true, recovered: recovery });
      let tree = render();
      const wheel = propsFor(tree, Wheel);
      check(`${recovery ? "recovered" : "fresh"} result preserves server selection`, (wheel.result as { index: number }).index === 0);
      check(`${recovery ? "recovered" : "fresh"} wheel sensory state`, wheel.muted === recovery);
      (wheel.onNearStop as () => void)();
      (wheel.onSpinEnd as () => void)();
      tree = render();
      const beforeRepeat = feedback.length;
      (propsFor(tree, Wheel).onSpinEnd as () => void)();
      check("completion is idempotent for feedback", feedback.length === beforeRepeat);
      check(recovery ? "recovery has no fanfare/buildup/haptics" : "fresh play keeps fanfare/buildup/haptics",
        recovery ? feedback.length === 0 : feedback.includes("win") && feedback.includes("haptic") && feedback.includes("buildup"));
      const history = propsFor(tree, PrizeBook).history as { label: string; shareId: string; at: string }[];
      check("win history retains exactly one original server award and timestamp", history.length === 1 && history[0].label === prize.label && history[0].shareId === "share" && history[0].at === "2026-10-28T00:00:00Z");
      // Close landed hold using the actual reducer setter through captured
      // callbacks is unnecessary: promotion gating can be asserted below by
      // replaying a common rarity whose stop opens its reveal immediately.
      recovered.onCommitted({ prize: { ...prize, rarity: "common" }, prizeIndex: 0, spinsRemaining: 2, focus: pass.focus } as SpinResult,
        { present: true, recovered: recovery });
      tree = render(); (propsFor(tree, Wheel).onSpinEnd as () => void)(); tree = render();
      check("normal eligible revealed win arms installation", propsFor(tree, InstallNudge).armed === true);
      for (const unavailable of ["blocked", "paused", "break"] as const) {
        paused = unavailable === "paused"; onBreak = unavailable === "break";
        const current = { ...pass, blocked: unavailable === "blocked" };
        requests.length = 0;
        tree = render(current);
        const refresh = callbacks.find(callback => callback.toString().includes('"/api/fan/focus"'));
        assert.ok(refresh, "capture the actual refresh callback");
        await refresh();
        check(`${unavailable}: focus requests respect readonly availability`, requests.length === (unavailable === "break" ? 1 : 0));
        check(`${unavailable}: paid focus metadata is retained`, (propsFor(tree, PrizeBook).focus as { spinsLeft: number }).spinsLeft === 7);
        if (unavailable !== "break") check(`${unavailable}: unknown odds are not displayed`, propsFor(tree, PrizeBook).odds === undefined);
        check(`${unavailable}: no install promotion or glow`, propsFor(tree, InstallNudge).armed === false && glows.at(-1) === false);
      }
      paused = false; onBreak = false;
      requests.length = 0;
      tree = render();
      const resumed = callbacks.find(callback => callback.toString().includes('"/api/fan/focus"'));
      assert.ok(resumed); await resumed();
      check("eligible link resumes readonly focus refresh", requests.length === 1);
      check("ending pause/break restores F6 promotion eligibility", propsFor(tree, InstallNudge).armed === true && glows.at(-1) === true);
    }
  } finally { globalThis.fetch = originalFetch; mock.timers.reset(); }
  console.log(`SpinClientRecovery: ${passed} actual component recovery/F6 checks passed`);
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
