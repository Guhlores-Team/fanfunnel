import assert from "node:assert/strict";
import {
  mockAckFan, mockCreatePass, mockGetFanPass, mockGetWheel, mockReadSpinAttempt,
  mockSaveWheel, mockSelfExclude, mockSetFanBlocked, mockSpin, mockTakeBreak,
} from "./mock";

async function main() {
  let passed = 0;
  const check = (label: string, condition: unknown) => { assert.ok(condition, label); passed++; };
  const original = mockGetWheel();
  mockSaveWheel({ ...original, prizes: [{ id: "break-status-prize", label: "Saved prize", rarity: "common", weight: 10 }] });
  const fan = mockCreatePass("Break status owner", 3);
  mockAckFan(fan.token);
  const before = (await mockGetFanPass(fan.token))!;
  const intent = { requestId: crypto.randomUUID(), clientSeed: "break-status", publishedSeedHash: before.nextSpinHash! };
  const win = await mockSpin(fan.token, intent.clientSeed, intent.requestId, intent.publishedSeedHash);
  assert.ok(!("error" in win));
  const committedView = (await mockGetFanPass(fan.token))!;
  check("fixture committed exactly one paid win", win.spinsRemaining === 2);
  check("fan can start its own break", "ok" in mockTakeBreak(fan.token, 24 * 60 * 60 * 1000));
  const recovered = await mockReadSpinAttempt(fan.token, intent);
  check("read-only committed receipt recovery stays available during break", recovered.status === "committed");
  assert.ok(recovered.status === "committed");
  check("break reconciliation preserves immutable win and current balance", recovered.result.shareId === win.shareId && recovered.result.spinsRemaining === 2 && recovered.result.replayed);
  const unknown = { requestId: crypto.randomUUID(), clientSeed: "not-sent" };
  check("an absent request can be checked safely during break", (await mockReadSpinAttempt(fan.token, unknown)).status === "absent");
  const declined = await mockSpin(fan.token, unknown.clientSeed, unknown.requestId);
  check("F6 still refuses a NEW paid attempt during break", "error" in declined && declined.error === "on_break");
  const declinedStatus = await mockReadSpinAttempt(fan.token, unknown);
  check("declined on-break attempt can be reconciled without a new identity", declinedStatus.status === "declined" && declinedStatus.error === "on_break");
  const after = (await mockGetFanPass(fan.token))!;
  check("status reads and refused new plays preserve balance and next commitment", after.spinsRemaining === committedView.spinsRemaining && after.nextSpinHash === committedView.nextSpinHash);
  const other = mockCreatePass("Different status owner", 1); mockAckFan(other.token);
  check("another token cannot recover a broken fan's win", (await mockReadSpinAttempt(other.token, intent)).status === "conflict");
  mockSetFanBlocked(fan.fanId, true);
  check("blocking still refuses the committed receipt", (await mockReadSpinAttempt(fan.token, intent)).status === "unavailable");
  check("blocking still refuses absent status enumeration", (await mockReadSpinAttempt(fan.token, { requestId: crypto.randomUUID() })).status === "unavailable");
  mockSetFanBlocked(fan.fanId, false);
  check("removing block restores safe status reads while break stays active", (await mockReadSpinAttempt(fan.token, intent)).status === "committed");
  mockSelfExclude(fan.token);
  check("self-exclusion still refuses committed receipt reads", (await mockReadSpinAttempt(fan.token, intent)).status === "unavailable");
  check("self-exclusion still refuses absent status enumeration", (await mockReadSpinAttempt(fan.token, { requestId: crypto.randomUUID() })).status === "unavailable");
  mockSaveWheel(original);
  console.log(`mockBreakStatus.test: ${passed} checks passed`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
