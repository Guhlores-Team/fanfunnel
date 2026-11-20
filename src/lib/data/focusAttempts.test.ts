import assert from "node:assert/strict";
import { replayV3 } from "@/lib/games/wheel/fairnessV3";
import {
  mockAckFan, mockCreatePass, mockGetFanPass, mockGetWheel, mockSaveWheel, mockSpin, mockGetSpinVerification,
  mockReadSpinAttempt, mockGetCreatorFocus, mockCreateCampaignPack, mockGrantFocusPack, mockCancelFanFocus,
  mockSetFanBlocked, mockDeleteFan, mockGetPrizeDelivery, mockAddPrizeCodes, mockCreateWheel, mockSetActiveWheel, mockGetShareCard, mockExportCreatorData,
} from "./mock";
import { mockFocusState } from "./mockFocus";
import { validSpinIntent, spinIntentHash } from "./spinAttempts";

let passed = 0;
function check(label: string, condition: unknown) { assert.ok(condition, label); passed++; }
async function main() {
  check("HTTP rejects missing/replaced request identities", !validSpinIntent({ clientSeed: "x" }) && !validSpinIntent({ requestId: "not-a-uuid" }));
  const intent = { requestId: crypto.randomUUID(), clientSeed: "x", publishedSeedHash: "a".repeat(64) };
  check("seed and published hash bind retries", await spinIntentHash(intent) !== await spinIntentHash({ ...intent, clientSeed: "y" }) && await spinIntentHash(intent) !== await spinIntentHash({ ...intent, publishedSeedHash: "b".repeat(64) }));
  const base = mockGetWheel();
  mockSaveWheel({ ...base, prizes: [
    { id: "focus-target", label: "Target", rarity: "common", weight: 1, boostable: true },
    { id: "focus-other", label: "Other", rarity: "common", weight: 9, boostable: false },
  ] });
  const fan = mockCreatePass("Attempt replay", 100);
  mockAckFan(fan.token);
  const view = (await mockGetFanPass(fan.token))!;
  const requestId = crypto.randomUUID();
  const [first, replay] = await Promise.all([mockSpin(fan.token, "bound", requestId, view.nextSpinHash!), mockSpin(fan.token, "bound", requestId, view.nextSpinHash!)]);
  assert.ok(!("error" in first) && !("error" in replay));
  check("simultaneous retry spends once and returns same receipt", first.shareId === replay.shareId && first.spinsRemaining === 99 && replay.spinsRemaining === 99 && replay.replayed);
  check("immutable receipt is recoverable by bound status", (await mockReadSpinAttempt(fan.token, { requestId, clientSeed: "bound", publishedSeedHash: view.nextSpinHash! })).status === "committed");
  check("changed payload cannot reuse a winner identity", "error" in await mockSpin(fan.token, "changed", requestId, view.nextSpinHash!));
  const foreign = mockCreatePass("Foreign", 2); mockAckFan(foreign.token);
  check("another token cannot read/replay the attempt", (await mockReadSpinAttempt(foreign.token, { requestId, clientSeed: "bound", publishedSeedHash: view.nextSpinHash! })).status === "conflict" && "error" in await mockSpin(foreign.token, "bound", requestId, view.nextSpinHash!));
  for (let i = 0; i < 55; i++) assert.ok(!("error" in await mockSpin(fan.token, `history-${i}`)));
  const oldProof = await mockGetSpinVerification(first.shareId);
  check("manual proofs remain after recent display eviction", oldProof && (await mockGetFanPass(fan.token))!.recentWins.length === 50);
  check("old committed proof still replays", oldProof?.v3 && (await replayV3({ serverSeed: oldProof.serverSeed, clientSeed: oldProof.clientSeed ?? "", nonce: oldProof.nonce, snapshot: oldProof.v3.poolSnapshot, poolHash: oldProof.v3.poolHash, trace: oldProof.v3.fairTrace, prizeId: oldProof.v3.prizeId, prizeLabel: oldProof.prizeLabel })).ok);
  const config = mockGetCreatorFocus(fan.fanId); assert.ok(!("error" in config));
  const pack = mockCreateCampaignPack({ label: "Focus", spins: 5, amountCents: 1500, packKind: "focus", focusSpins: 5, focusMultiplier: 3 });
  const grant = { requestId: crypto.randomUUID(), passId: config.passes[0].id, packId: pack.id, prizeId: "focus-target" };
  const granted = mockGrantFocusPack(fan.fanId, grant); assert.ok(!("error" in granted));
  const grantedAgain = mockGrantFocusPack(fan.fanId, grant); assert.ok(!("error" in grantedAgain));
  check("focus grant credits once from stored pack", grantedAgain.replayed && granted.spinsRemaining === grantedAgain.spinsRemaining);
  const active = mockGetCreatorFocus(fan.fanId); assert.ok(!("error" in active));
  check("creator pass DTO contains no bearer token", !JSON.stringify(active.passes).includes(fan.token));
  check("focus state public projection carries no internal reservation/grant/fan identities", !/fan_id|fan_pass_id|grant_id|reservation|codeId/.test(JSON.stringify(active.focus)));
  check("second focus is refused before credit", "error" in mockGrantFocusPack(fan.fanId, { ...grant, requestId: crypto.randomUUID() }));
  const focusSpin = await mockSpin(fan.token, "focus"); assert.ok(!("error" in focusSpin));
  check("eligible committed focus consumes exactly one", focusSpin.focusConsumed && focusSpin.focus?.spinsLeft === 4);
  mockSaveWheel({ ...mockGetWheel(), prizes: mockGetWheel().prizes.map(prize => prize.id === "focus-target" ? { ...prize, stock: 0 } : prize) });
  const paused = await mockSpin(fan.token, "paused"); assert.ok(!("error" in paused));
  check("sold-out focus pauses without consuming paid focus", !paused.focusConsumed && paused.focus?.spinsLeft === 4 && paused.focus.pauseReason === "sold_out" && paused.odds?.rows.find(row => row.prizeId === "focus-target")?.chance === 0);
  mockSaveWheel({ ...mockGetWheel(), prizes: mockGetWheel().prizes.map(prize => ({ ...prize, stock: null })) });
  const otherWheel = mockCreateWheel({ name: "Other resolved wheel" }).wheel;
  mockSaveWheel({ ...otherWheel, prizes: [{ id: "other-one", label: "Other one", rarity: "common", weight: 1 }, { id: "other-two", label: "Other two", rarity: "common", weight: 1 }] });
  mockSetActiveWheel(otherWheel.id);
  const moved = await mockSpin(fan.token, "other-wheel"); assert.ok(!("error" in moved));
  check("resolved wheel rotation pauses focus and spends only ordinary credit", !moved.focusConsumed && moved.focus?.spinsLeft === 4 && moved.focus.pauseReason === "other_wheel" && moved.prize.id.startsWith("other-"));
  mockSetActiveWheel(base.id);
  const beforeCancel = mockGetCreatorFocus(fan.fanId); assert.ok(!("error" in beforeCancel) && beforeCancel.focusId);
  const oldFocusId = beforeCancel.focusId;
  const firstCancel = mockCancelFanFocus(fan.fanId, oldFocusId); assert.ok(!("error" in firstCancel) && firstCancel.released);
  const laterGrant = mockGrantFocusPack(fan.fanId, { ...grant, requestId: crypto.randomUUID() }); assert.ok(!("error" in laterGrant));
  const newFocus = mockGetCreatorFocus(fan.fanId); assert.ok(!("error" in newFocus) && newFocus.focusId);
  const lateCancel = mockCancelFanFocus(fan.fanId, oldFocusId); assert.ok(!("error" in lateCancel));
  const afterLateCancel = mockGetCreatorFocus(fan.fanId); assert.ok(!("error" in afterLateCancel));
  check("lost cancellation retry cannot release a newer purchased promise", !lateCancel.released && afterLateCancel.focusId === newFocus.focusId && afterLateCancel.focus?.spinsLeft === 5);
  mockCancelFanFocus(fan.fanId, newFocus.focusId);
  const lateReplay = await mockSpin(fan.token, "bound", requestId, view.nextSpinHash!); assert.ok(!("error" in lateReplay));
  const liveView = (await mockGetFanPass(fan.token))!;
  check("late replay preserves immutable winner but returns current balances/focus/commitment", lateReplay.shareId === first.shareId && lateReplay.prize.id === first.prize.id && lateReplay.spinsRemaining === liveView.spinsRemaining && lateReplay.nextSpinHash === liveView.nextSpinHash && lateReplay.focus === null && lateReplay.play?.today === 59);
  mockSetFanBlocked(fan.fanId, true);
  check("F6 blocked focus grant fails closed", "error" in mockGrantFocusPack(fan.fanId, { ...grant, requestId: crypto.randomUUID() }));
  mockSetFanBlocked(fan.fanId, false);
  const chase = mockCreateCampaignPack({ label: "Chase", spins: 5, amountCents: 2000, packKind: "chase", chaseWithin: 5 });
  check("chase is disabled until server rollout", "error" in mockGrantFocusPack(fan.fanId, { ...grant, requestId: crypto.randomUUID(), packId: chase.id }));
  mockFocusState().chaseEnabled = true; // Service-side TEST fixture; no browser toggle or route exists.
  mockAddPrizeCodes("focus-target", ["HELD-SECRET"]);
  const held = mockGrantFocusPack(fan.fanId, { ...grant, requestId: crypto.randomUUID(), packId: chase.id }); assert.ok(!("error" in held));
  const delivery = mockGetPrizeDelivery("focus-target"); assert.ok(!("error" in delivery));
  check("chase holds a concrete code out of the free pool", delivery.codesLeft === 0);
  const otherSpin = await mockSpin(foreign.token, "cannot-steal"); assert.ok(!("error" in otherSpin));
  check("another fan cannot take a reserved code", otherSpin.prize.id === "focus-other" && !otherSpin.reward);
  mockSetActiveWheel(otherWheel.id);
  const chasePaused = await mockSpin(fan.token, "chase-other-wheel"); assert.ok(!("error" in chasePaused));
  check("changing resolved wheel cannot consume a held chase unit or counter", !chasePaused.chaseConsumed && chasePaused.focus?.chaseCounter === 0 && chasePaused.focus.pauseReason === "other_wheel");
  mockDeleteFan(fan.fanId);
  const publicProof = await mockGetSpinVerification(first.shareId);
  const anonymous = mockExportCreatorData().sections.spins.find(row => row.id === first.shareId);
  check("erasure retains anonymous public proof without former fan identity", publicProof?.hashOk && mockGetShareCard(first.shareId)?.prizeLabel === first.prize.label && anonymous?.fan_id === null);
  const released = mockGetPrizeDelivery("focus-target"); assert.ok(!("error" in released));
  check("privacy delete releases held unconsumed code exactly once", released.codesLeft === 1 && mockFocusState().attempts.get(requestId) === undefined);
  mockFocusState().chaseEnabled = false;
  mockSetActiveWheel(base.id);
  mockSaveWheel(base);
  console.log(`focus attempts: ${passed} checks passed`);
}
main().catch(error => { console.error(error); process.exit(1); });
