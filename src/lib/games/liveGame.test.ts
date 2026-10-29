import assert from "node:assert/strict";
import { pickLiveGame, resolvePlayingGame, scheduleTakeover, playReasonText, type LiveGameCandidate } from "./liveGame";
import { campaignGame, campaignsUsing, defaultCampaignGameId, linkGame, liveExplanation, gameOptionLabel } from "@/components/dashboard/gameAssignment";

// The owner's report: "Test Scratch" was scheduled now → Oct 31 while
// "Spin to Win" was active, so every unpinned link (including one whose
// screen said "Spin to Win") played the scratch ticket. The dashboard must
// explain exactly what the server resolver decides.
const NOW = new Date("2026-10-29T12:00:00Z");
type G = LiveGameCandidate & { title: string };
const game = (id: string, patch: Partial<G> = {}): G => ({ id, title: id, gameKind: "wheel", gameReady: true, isActive: false, archivedAt: null,
  activeFrom: null, activeUntil: null, createdAt: "2026-01-01T00:00:00Z", ...patch });
let passed = 0;
const eq = (actual: unknown, expected: unknown, label: string) => { assert.deepEqual(actual, expected, label); passed++; };

const spin = game("spin", { title: "Spin to Win", isActive: true });
const scratch = game("scratch", { title: "Test Scratch", gameKind: "scratch", activeFrom: "2026-10-29T11:00:00Z", activeUntil: "2026-10-31T23:00:00Z", createdAt: "2026-10-20T00:00:00Z" });
const games = [spin, scratch];

// Schedule overrides the active game.
let live = pickLiveGame(games, NOW);
eq(live?.game.id, "scratch", "an open schedule beats the active game");
eq(live?.reason.kind, "scheduled", "reason names the schedule");
const explained = liveExplanation(games, NOW);
eq(explained?.overriddenActive?.id, "spin", "the paused active game is named");
assert.ok(explained?.because.startsWith("it's scheduled until"), "plain-language reason"); passed++;
eq(pickLiveGame(games, new Date("2026-11-01T00:00:00Z"))?.game.id, "spin", "the active game comes back after the window");
eq(liveExplanation([spin, game("w2")], NOW)?.because, "it's your active game", "active reason text");
eq(pickLiveGame([game("b", { createdAt: "2026-02-01T00:00:00Z" }), game("a2", { createdAt: "2026-03-01T00:00:00Z" })], NOW)?.reason.kind, "oldest", "fallback is the oldest");

// Pin overrides schedule; archived / not-ready / bingo pins are ignored.
eq(resolvePlayingGame(games, { pinnedWheelId: "spin" }, NOW)?.game.id, "spin", "a campaign's game beats an open schedule");
eq(resolvePlayingGame(games, { pinnedWheelId: "spin" }, NOW)?.reason.kind, "pinned", "pinned reason");
for (const [label, patch] of [["archived", { archivedAt: "2026-10-01T00:00:00Z" }], ["not ready", { gameReady: false }], ["bingo", { gameKind: "bingo" as const }]] as const) {
  const bad = game("pinned", { title: "Pinned", ...patch });
  const result = resolvePlayingGame([...games, bad], { pinnedWheelId: "pinned" }, NOW);
  eq(result?.game.id, "scratch", `${label} pin is ignored for the live game`);
  eq(result?.ignoredPin && result.ignoredPin !== "missing" ? result.ignoredPin.id : null, "pinned", `${label} pin is reported as ignored`);
  const card = campaignGame({ pinnedWheelId: "pinned" }, [...games, bad], NOW);
  eq(card.mode === "follows" ? card.ignored?.title : null, "Pinned", `${label} pin explained on the campaign card`);
  assert.ok(/\(/.test(gameOptionLabel(bad)), `${label} game option says why it can't be chosen`); passed++;
}
eq(resolvePlayingGame(games, { pinnedWheelId: "gone" }, NOW)?.ignoredPin, "missing", "a deleted pin is reported");

// Scratch vs wheel: a scratch pin plays scratch, a wheel link's stored id doesn't decide.
eq(resolvePlayingGame([spin, game("s2", { gameKind: "scratch" })], { pinnedWheelId: "s2" }, NOW)?.game.gameKind, "scratch", "scratch pin plays scratch");
const link = linkGame({ wheelId: "spin", campaignId: null }, [], games, NOW);
eq([link?.game.id, link?.via], ["scratch", "live"], "a link made for Spin to Win plays the scheduled scratch (not passes[0].wheelId)");
const pinnedLink = linkGame({ wheelId: "scratch", campaignId: "c1" }, [{ id: "c1", name: "Summer", pinnedWheelId: "spin" }], games, NOW);
eq([pinnedLink?.game.id, pinnedLink?.via, pinnedLink?.because], ["spin", "campaign", "the campaign “Summer” is set to play it"], "campaign link plays the campaign's game");
eq(linkGame({ wheelId: "stored", campaignId: null }, [], [game("stored", { gameKind: "scratch" }), game("x", { archivedAt: "2026-01-02T00:00:00Z" })], NOW)?.game.id, "stored", "only playable game is used");
eq(linkGame({ wheelId: "x", campaignId: null }, [], [game("bingo", { gameKind: "bingo" })], NOW), null, "bingo is never played from a link");
eq(campaignsUsing("spin", [{ id: "c1", name: "A", pinnedWheelId: "spin" }, { id: "c2", name: "B", pinnedWheelId: null }]).map((c) => c.id), ["c1"], "used-by list");
eq(defaultCampaignGameId(games, NOW), "scratch", "new campaigns default to what fans get now");

// Schedule takeover warning.
const plain = game("plain", { title: "Plain", gameKind: "scratch" });
let change = scheduleTakeover([spin, plain], "plain", { activeFrom: null, activeUntil: "2026-10-31T00:00:00Z" }, NOW);
eq([change?.replaces.id, change?.startsNow], ["spin", true], "an open-now schedule replaces the active game");
change = scheduleTakeover([spin, plain], "plain", { activeFrom: "2026-11-02T00:00:00Z", activeUntil: null }, NOW);
eq([change?.replaces.id, change?.startsNow, change?.at.toISOString()], ["spin", false, "2026-11-02T00:00:00.000Z"], "a future schedule names what it replaces then");
eq(scheduleTakeover([spin, plain], "plain", { activeFrom: null, activeUntil: "2026-10-01T00:00:00Z" }, NOW), null, "an expired window takes nothing over");
eq(scheduleTakeover([spin, plain], "plain", { activeFrom: null, activeUntil: null }, NOW), null, "clearing a schedule never warns");
eq(scheduleTakeover([spin, game("draft", { gameReady: false })], "draft", { activeFrom: null, activeUntil: "2026-10-31T00:00:00Z" }, NOW), null, "a draft can't take over");
const later = game("later", { activeFrom: "2026-10-29T11:30:00Z" });
eq(scheduleTakeover([spin, scratch, later], "scratch", { activeFrom: "2026-10-29T11:00:00Z", activeUntil: "2026-10-31T23:00:00Z" }, NOW), null, "a schedule that loses to a later start takes nothing over");
eq(scheduleTakeover([spin, scratch], "scratch", { activeFrom: "2026-10-29T11:00:00Z", activeUntil: "2026-10-31T23:00:00Z" }, NOW)?.replaces.id, "spin", "re-saving an open schedule still names the active game");

eq(playReasonText({ kind: "scheduled", from: null, until: null }), "it's scheduled with no end date", "open-ended schedule text");
live = pickLiveGame([], NOW);
eq(live, null, "no games, no live game");
console.log(`live game explanation: ${passed} checks passed`);
