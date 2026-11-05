import assert from "node:assert/strict";
import { linkNames, topUpOutcome, topUpTargets, type TopUpPass } from "./topUpTargets";
import { linkGame, mintPlaysReason, type ChoiceGame } from "./gameAssignment";

let passed = 0;
const check = (label: string, cond: unknown) => { assert.ok(cond, label); passed++; };
const now = new Date("2026-11-05T12:00:00Z");
const game = (id: string, title: string, extra: Partial<ChoiceGame> = {}): ChoiceGame => ({
  id, title, isActive: false, archivedAt: null, activeFrom: null, activeUntil: null,
  createdAt: `2026-01-0${id.length}T00:00:00Z`, gameKind: "wheel", gameReady: true, prizeCount: 4, ...extra,
});
const live = game("w", "Main wheel", { isActive: true });
const second = game("w2", "Second wheel");
const empty = game("w03", "QA Empty Wheel", { prizeCount: 0 });
const draft = game("w004", "Bingo draft", { gameKind: "bingo", gameReady: false });
const archived = game("w0005", "Old wheel", { archivedAt: "2026-02-01T00:00:00Z" });
const games = [live, second, empty, draft, archived];
const pass = (token: string, wheelId: string, extra: Partial<TopUpPass> = {}): TopUpPass => ({
  token, wheelId, campaignId: null, pinnedWheelId: null, campaignName: null, spinsRemaining: 0, createdAt: "2026-03-01T00:00:00Z", ...extra,
});

// QA b5 M2: a fan with one unpinned link on the live wheel.
{
  const { existing, fresh } = topUpTargets({ passes: [pass("t1", "w", { spinsRemaining: 1 })], campaigns: [], games, now });
  check("the fan's own link is offered by what it plays", existing.length === 1 && existing[0].label === "Link (no campaign) · plays Main wheel (1 spin)");
  check("existing links credit their stored game, never a new link", existing[0].wheelId === "w" && existing[0].token === "t1" && existing[0].pinWheelId === null);
  check("a 0-prize wheel is never offered", !fresh.some((t) => t.wheelId === "w03"));
  check("a draft or archived game is never offered", !fresh.some((t) => t.wheelId === "w004" || t.wheelId === "w0005"));
  check("a game with a stored link is not offered as a new link", !fresh.some((t) => t.wheelId === "w"));
  check("another playable game is offered only as a clearly new, pinned link",
    fresh.length === 1 && fresh[0].wheelId === "w2" && fresh[0].token === null && fresh[0].pinWheelId === "w2" && /^New link that plays Second wheel/.test(fresh[0].label));
  check("the new-link outcome says a new link is created and what it plays", /Creates a new link .* plays Second wheel/.test(topUpOutcome(fresh[0], null, 3)));
  check("the existing outcome says which link and what it plays", topUpOutcome(existing[0], null, 3) === "Link (no campaign) gets 3 spins (4 spins after). It plays Main wheel.");
}

// A link stored on the second wheel that plays the live one (the old bug's
// hidden duplicate): the option names what it really plays.
{
  const passes = [pass("t1", "w"), pass("t2", "w2", { createdAt: "2026-04-01T00:00:00Z", spinsRemaining: 3 })];
  const { existing, fresh } = topUpTargets({ passes, campaigns: [], games, now });
  const names = linkNames(passes, [], games, now);
  check("two unpinned no-campaign links playing the same game get numbered names", names.get("t1") === "Link (no campaign) · Main wheel (1)" && names.get("t2") === "Link (no campaign) · Main wheel (2)");
  check("their options are distinct too", new Set(existing.map((t) => t.label)).size === existing.length && existing.length === 2);
  check("the second link's option says it plays the live game, not its stored game", existing[1].label === "Link (no campaign) (2) · plays Main wheel (3 spins)");
  check("no new link is offered for a game that already has a stored link", fresh.length === 0);
}

// Only the oldest link per stored game can receive spins (server order).
{
  const passes = [pass("newer", "w", { createdAt: "2026-05-01T00:00:00Z" }), pass("older", "w", { createdAt: "2026-01-01T00:00:00Z" })];
  const { existing } = topUpTargets({ passes, campaigns: [], games, now });
  check("one option per stored game, the oldest link", existing.length === 1 && existing[0].token === "older");
}

// A link whose stored game is archived would be refused (no_wheel).
{
  const { existing } = topUpTargets({ passes: [pass("t9", "w0005")], campaigns: [], games, now });
  check("a link stored on an archived game is not offered", existing.length === 0);
}

// A pinned link plays its pin; a top-up in a campaign moves the link into it.
{
  const campaigns = [{ id: "c1", name: "Launch", pinnedWheelId: "w2" }];
  const pinned = topUpTargets({ passes: [pass("t1", "w", { pinnedWheelId: "w2" })], campaigns, games, now });
  check("a link set to its own game is labelled with that game", /plays Second wheel/.test(pinned.existing[0].label));
  const moved = topUpTargets({ passes: [pass("t1", "w")], campaigns, games, now, campaignId: "c1" });
  check("the option shows the game after the campaign moves the link", /plays Second wheel/.test(moved.existing[0].label));
  check("and the outcome explains the move", /moves it into that campaign, so it will play Second wheel instead of Main wheel/.test(topUpOutcome(moved.existing[0], "Launch", 1)));
  const named = topUpTargets({ passes: [pass("t1", "w", { campaignId: "c1", campaignName: "Launch" })], campaigns, games, now });
  check("a link in a campaign is named by it", /^Link in “Launch” · plays Second wheel/.test(named.existing[0].label));
}

check("1 spin is singular", topUpOutcome(topUpTargets({ passes: [pass("t1", "w")], campaigns: [], games, now }).existing[0], null, 1).startsWith("Link (no campaign) gets 1 spin (1 spin after)"));
// QA b5 m7: the mint line for a campaign set to an archived game.
{
  const campaigns = [{ id: "c1", name: "Spring", pinnedWheelId: "w0005" }, { id: "c2", name: "Open", pinnedWheelId: null }, { id: "c3", name: "Pinned", pinnedWheelId: "w2" }];
  const mint = (campaignId: string | null) => mintPlaysReason(linkGame({ wheelId: "", campaignId }, campaigns, games, now)!);
  check("an archived campaign game is named, not called 'follows'", mint("c1") === "(your live game: “Spring” is set to play Old wheel, but it's archived)");
  check("a following campaign still says it follows", mint("c2") === "(your live game, because “Open” follows it)");
  check("a campaign game is named as chosen", mint("c3") === "(the game chosen for “Pinned”)");
  check("no campaign: just the live game", mint(null) === "(your live game)");
}
console.log(`topUpTargets.test: ${passed} checks passed`);
