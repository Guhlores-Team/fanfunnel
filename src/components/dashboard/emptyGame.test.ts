import assert from "node:assert";
import { abandonedEmptyGame, emptyGameNotice } from "./emptyGame";

let passed = 0;
const check = (label: string, cond: unknown) => {
  assert.ok(cond, label);
  passed++;
};

const row = { id: "g2", title: "New wheel 2", prizeCount: 0, isActive: false, archivedAt: null };
const other = { id: "g1", title: "Main", prizeCount: 6, isActive: true, archivedAt: null };

check("switching to another game offers the empty one", abandonedEmptyGame("g2", "g1", [other, row])?.id === "g2");
check("leaving the Games section offers it too", abandonedEmptyGame("g2", null, [other, row])?.id === "g2");
check("still editing it: nothing", abandonedEmptyGame("g2", "g2", [other, row]) === null);
check("nothing was created this visit: nothing", abandonedEmptyGame(null, "g1", [other, row]) === null);
check("a game that got a prize is kept silently", abandonedEmptyGame("g2", "g1", [other, { ...row, prizeCount: 1 }]) === null);
check("a live game is never offered", abandonedEmptyGame("g2", "g1", [other, { ...row, isActive: true }]) === null);
check("an archived game is never offered", abandonedEmptyGame("g2", "g1", [other, { ...row, archivedAt: "2026-11-10T00:00:00Z" }]) === null);
check("a game already gone is never offered", abandonedEmptyGame("g2", "g1", [other]) === null);
check("the notice names the game and says why it matters", /"New wheel 2" has no prizes yet/.test(emptyGameNotice("New wheel 2")));

console.log(`emptyGame: ${passed} checks passed`);
