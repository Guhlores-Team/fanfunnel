import assert from "node:assert/strict";
import { gameWriteError } from "./gameSettings";
import { mockCampaignPinError, mockCreateCampaign, mockCreateWheel, mockGetWheel, mockSaveWheel, mockSetCampaignPinnedWheel, mockSetWheelSchedule } from "./mock";
import { MIN_WHEEL_PRIZES } from "@/lib/games/wheel/validate";

// 0069: a game with fewer than MIN_WHEEL_PRIZES prizes cannot be chosen for a
// campaign or a link, nor scheduled. The database refuses it for every role
// (scripts/db/integrationProbe.mjs); the demo store mirrors it so the e2e
// journeys and the pickers see the same answers, and the schedule route maps
// the database's refusal.

let checks = 0;
const check = (value: unknown, label: string) => { assert.ok(value, label); checks++; };
const eq = (a: unknown, b: unknown, label: string) => { assert.deepEqual(a, b, label); checks++; };

const { wheel: empty } = mockCreateWheel({ name: "Empty game" });
eq(empty.prizes.length, 0, "a new blank game starts without prizes");
eq(mockCampaignPinError(empty.id), "game_not_playable", "an empty game cannot be a campaign's game");
eq(mockSetCampaignPinnedWheel(mockCreateCampaign("Follow").id, empty.id), { error: "game_not_playable" }, "pinning a campaign to an empty game is refused");
const later = new Date(Date.now() + 3_600_000).toISOString();
eq(mockSetWheelSchedule(empty.id, { activeFrom: later, activeUntil: null }), { error: "game_needs_prizes" }, "an empty game cannot be scheduled");
eq(mockSetWheelSchedule(empty.id, { activeFrom: null, activeUntil: null }), { ok: true }, "clearing an empty game's schedule is allowed");

const sample = mockGetWheel().prizes;
check(sample.length >= MIN_WHEEL_PRIZES, "the demo wheel has enough prizes to borrow");
const onePrize = mockSaveWheel({ ...empty, prizes: [{ ...structuredClone(sample[0]), id: "prize-min-1" }] });
eq(onePrize.prizes.length, 1, "one prize saved");
eq(mockCampaignPinError(empty.id), "game_not_playable", `${MIN_WHEEL_PRIZES - 1} prize is still too few`);
eq(mockSetWheelSchedule(empty.id, { activeFrom: null, activeUntil: later }), { error: "game_needs_prizes" }, "a one-prize game cannot be scheduled");
mockSaveWheel({ ...onePrize, prizes: [onePrize.prizes[0], { ...structuredClone(sample[1]), id: "prize-min-2" }] });
eq(mockCampaignPinError(empty.id), null, `${MIN_WHEEL_PRIZES} prizes make the game choosable`);
eq(mockSetCampaignPinnedWheel(mockCreateCampaign("Follow two").id, empty.id), { ok: true }, "a campaign pins the game once it has prizes");
eq(mockSetWheelSchedule(empty.id, { activeFrom: later, activeUntil: null }), { ok: true }, "the game can be scheduled once it has prizes");

eq(gameWriteError({ message: "game_needs_prizes" }), "game_needs_prizes", "the database's schedule refusal reaches the route as game_needs_prizes");
eq(gameWriteError({ message: "game_needs_prizes: extra" }), "game_needs_prizes", "with a detail suffix too");

console.log(`game prize minimum (0069): ${checks} checks passed`);
