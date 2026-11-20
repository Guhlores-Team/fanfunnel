import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GameProof, gameOddsReplay } from "@/app/verify/[shareId]/GameProof";
import { OddsUsed } from "@/app/verify/[shareId]/OddsUsed";
import { buildScratchPoolSnapshot, buildBingoPoolSnapshot, hashGamePoolSnapshot, parseGamePoolSnapshot, parseBingoState, primarySnapshot, type GamePoolSnapshot } from "./gameProof";
import { drawGame } from "./play";
import { parseGamePresentation } from "./presentation";
import { replayGameV3, parseGameTrace } from "./replay";
import { makeFairRngV3, sha256Hex } from "../wheel/fairness";
import { makeGameRngV3, MAX_GAME_RANDOM_DRAWS } from "./fairness";
import { canonicalJson, drawFromSnapshot } from "../wheel/fairnessV3";
import { scratchFace } from "../scratch/engine";
import { advanceBingo, BINGO_LINE_MASKS, completedLines, bingoEligible, safeCell, pickLineBonus, type BingoState } from "../bingo/engine";
import { estimateBingoValue } from "../bingo/ev";
import type { WheelConfig } from "./types";

let checks = 0;
const check = (condition: unknown, message: string) => { assert.ok(condition, message); checks++; };
const equal = (actual: unknown, expected: unknown, message: string) => { assert.deepEqual(actual, expected, message); checks++; };
const throws = (run: () => unknown, message: string) => { assert.throws(run, message); checks++; };
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const config: WheelConfig = { id: "pool", title: "Test", prizes: Array.from({ length: 9 }, (_, i) => ({
  id: `p${i}`, label: `Prize ${i}`, emoji: i % 2 ? "★" : "★️", rarity: i === 0 ? "rare" : "common", weight: i + 1, stock: null, cost: 100,
})) };
config.prizes.push({ id: "zfinite", label: "Line prize", emoji: "◇", rarity: "epic", weight: 3, stock: 1, cost: 700 });
const options = { pityCounter: 0, happyHourMultiplier: null };
const card = (mask: number): BingoState => ({ cells: config.prizes.slice(0, 9).map(safeCell), markedMask: mask, awardedLinesMask: completedLines(mask), version: 20 });
const scratch = buildScratchPoolSnapshot(config, options);
const bingo = buildBingoPoolSnapshot(config, options, { size: 3, linePrizeId: "zfinite" }, null);
check(parseGamePoolSnapshot(scratch).ok && parseGamePoolSnapshot(bingo).ok, "new strict rules parse");
equal(canonicalJson(parseGamePoolSnapshot(scratch)), canonicalJson({ ok: true, snapshot: scratch }), "scratch roundtrip canonical");
check(!parseGamePoolSnapshot({ ...scratch, cost: 1 }).ok, "private/unknown top-level field refused");
check(!parseGamePoolSnapshot({ ...scratch, gameRules: "scratch-v2" }).ok, "unknown version refused");
check(!parseGamePoolSnapshot({ ...scratch, gameConfig: { style: "classic", bait: true } }).ok, "unknown config field refused");
check(!parseGamePoolSnapshot({ ...scratch, game: "bingo" }).ok, "kind/version mismatch refused");
check(!parseGameTrace({ excluded: [], won: "p0", bonuses: [], extra: true }), "trace extra field refused");
check(!parseGameTrace({ excluded: ["p0", "p0"], won: "p1", bonuses: [] }), "duplicate primary exclusion refused");
check(!parseGameTrace({ excluded: [], won: "p0", bonuses: [{ line: 8, excluded: [], won: "p1" }] }), "out-of-range line refused");
check(!parseBingoState({ ...card(1), awardedLinesMask: 1 }), "forged line mask refused");
check(!parseBingoState({ ...card(7), version: 2 }), "version cannot predate marks");
check(!parseBingoState({ ...card(0), cells: Array(9).fill(safeCell(config.prizes[0])) }), "duplicate cells refused");
throws(() => buildBingoPoolSnapshot({ ...config, prizes: config.prizes.slice(1) }, options, { size: 3, linePrizeId: "zfinite" }, null), "requires nine eligible and unlimited rare fallback");
throws(() => buildBingoPoolSnapshot({ ...config, prizes: config.prizes.map((p) => p.id === "p0" ? { ...p, delivery: "codes" } : p) }, options, { size: 3, linePrizeId: "zfinite" }, null), "null stock codes cannot satisfy cell/fallback requirements");
check(!bingoEligible({ ...config.prizes[0], delivery: "codes" }), "codes excluded even null stock");
check(!bingoEligible({ ...config.prizes[0], weight: 0 }), "zero base weight excluded");
check(!bingoEligible({ ...config.prizes[0], stock: 1 }), "finite stock excluded");
const stranded = card(1); stranded.cells[0].id = "deleted";
throws(() => buildBingoPoolSnapshot(config, options, { size: 3, linePrizeId: "zfinite" }, stranded), "active historical card cannot silently lose eligibility");
for (let line = 0; line < 8; line++) {
  const mask = BINGO_LINE_MASKS[line];
  check((completedLines(mask) & (1 << line)) !== 0, `line ${line} recognized`);
  for (let cell = 0; cell < 9; cell++) if (mask & (1 << cell)) check(!(completedLines(mask & ~(1 << cell)) & (1 << line)), `line ${line} needs cell ${cell}`);
}
for (let mask = 0; mask <= 511; mask++) {
  const before = card(mask);
  for (let cell = 0; cell < 9; cell++) {
    const update = advanceBingo(config.prizes.slice(0, 9).map(safeCell), before, `p${cell}`, () => 0.5);
    check(update.newLines.length <= 4, "one cell completes at most four lines");
    check(update.markedIndex !== null && (update.after.markedMask & (1 << update.markedIndex)) !== 0, "drawn cell marked");
    if (mask !== 511) {
      equal(update.newLines, BINGO_LINE_MASKS.flatMap((_, n) => ((completedLines(mask | (1 << cell)) & ~completedLines(mask)) & (1 << n)) ? [n] : []), "only newly completed lines awarded");
      equal(update.after.cells, before.cells, "active cell order immutable");
    }
  }
}
const noMark = advanceBingo(config.prizes.slice(0, 9).map(safeCell), card(3), "outside", () => { throw Error("existing card uses no RNG"); });
equal(noMark.after.markedMask, 3, "outside-card primary still no mark");
equal(noMark.after.version, 21, "every primary advances version, including outside card");
throws(() => advanceBingo(config.prizes.slice(0, 9).map(safeCell), { ...card(1), version: Number.MAX_SAFE_INTEGER }, "p0", () => 0.5), "version overflow throws before commit");
const full = advanceBingo(config.prizes.slice(0, 9).map(safeCell), card(511), "p0", () => 0);
check(full.newCard && full.after.version === 1 && full.after.markedMask !== 511, "only next paid play replaces full card");
const multi = buildBingoPoolSnapshot(config, options, { size: 3, linePrizeId: "zfinite" }, card(511 & ~(1 << 4)));
// Roll 0.25 lands p4 in canonical base pool (tickets 1..9 then3).
const lineDraw = drawGame(multi, { excluded: [], won: "p4" }, () => 0.25);
equal(lineDraw.presentation.kind === "bingo" && lineDraw.presentation.newLines, [1, 4, 6, 7], "center can complete four lines in fixed order");
equal(lineDraw.bonuses.map((b) => b.prize.id), ["zfinite", "zfinite", "zfinite", "zfinite"], "uncontended pure plan selects configured line prize each time");
// First allocation takes its last unit; next line fails that candidate and falls back.
const retries = lineDraw.trace.bonuses.map((b, n) => ({ ...b, excluded: n === 1 ? ["zfinite"] : [], won: n === 0 ? "zfinite" : "p0" }));
const lineRetry = drawGame(multi, { excluded: [], won: "p4" }, () => 0.25, retries);
equal(lineRetry.bonuses.map((b) => b.prize.id), ["zfinite", "p0", "p0", "p0"], "later finite failure never changes earlier successful bonus");
throws(() => drawGame(multi, { excluded: [], won: "p4" }, () => 0.25, retries.map((b, n) => n === 3 ? { ...b, excluded: ["p0"] } : b)), "unlimited fallback cannot be excluded");
const tiny = { id: "winner", label: "★", emoji: "★️" };
let calls = 0;
const tinyFace = scratchFace(tiny, [tiny, { id: "x", label: "★", emoji: "★" }], () => { calls++; return 0; });
equal(calls, 13, "scratch fixed five plus eight cosmetic draws");
equal(tinyFace.cells.filter((p) => p.id === "winner").length, 3, "tiny/colliding pool still exactly triple");
equal(tinyFace.cells.filter((p) => p.kind === "decoration").length, 6, "tiny pool uses distinct neutral decorations");
check(parseGamePresentation(tinyFace, { kind: "scratch", prizeId: "winner" }) !== null, "client guard accepts committed scratch shape");
check(!parseGamePresentation(tinyFace, { kind: "scratch", prizeId: "other" }), "client guard refuses a different winning prize");
check(!parseGamePresentation({ ...tinyFace, cells: tinyFace.cells.slice(1) }), "client guard refuses missing scratch cells");
check(!parseGamePresentation({ ...tinyFace, extra: true }), "client guard refuses unknown presentation keys");
const badTriple = clone(tinyFace); badTriple.cells[0] = { kind: "decoration", id: "fake", label: "Fake", emoji: "?" };
check(!parseGamePresentation(badTriple), "client guard refuses fabricated decorative identity");
check(parseGamePresentation(lineDraw.presentation, { kind: "bingo", prizeId: "p4" }) !== null, "client guard accepts exact bingo transition");
if (lineDraw.presentation.kind === "bingo") {
  check(!parseGamePresentation({ ...lineDraw.presentation, after: { ...lineDraw.presentation.after, version: 999 } }), "client guard refuses version jumps");
  check(!parseGamePresentation({ ...lineDraw.presentation, newLines: [] }), "client guard refuses omitted owed lines");
  check(!parseGamePresentation({ ...lineDraw.presentation, markedIndex: 0 }, { kind: "bingo", prizeId: "p4" }), "client guard refuses forged marked cell");
  check(!parseGamePresentation({ ...lineDraw.presentation, newCard: true }), "client guard refuses arbitrary card replacement");
}
throws(() => scratchFace(tiny, [], () => 1), "out-of-range RNG rejected");
const reservedIdFace = scratchFace({ id: "scratch-v1:circle", label: "Win", emoji: null }, [], () => 0.5);
equal(reservedIdFace.cells.filter((c) => c.id === "scratch-v1:circle").length, 3, "neutral IDs never collide with actual prize identity");
const awkwardWinner = { id: "awkward", label: "Decorative circle", emoji: "■" };
const awkward = scratchFace(awkwardWinner, [
  { id: "d1", label: "Decorative triangle", emoji: "◆" }, { id: "d2", label: "Decorative star", emoji: "✿" },
  { id: "d3", label: "Decorative crescent", emoji: "☀" }, { id: "d4", label: "Decorative heart", emoji: "✚" },
  { id: "d5", label: "Decorative hexagon", emoji: "⬟" },
], () => 0.5);
equal(awkward.cells.length, 9, "adversarial labels and symbols cannot exhaust neutral decorations");
if (bingo.game === "bingo") {
  for (const alter of [
    (s: typeof bingo) => { s.bingo.bonus.fallback[0].w++; },
    (s: typeof bingo) => { s.bingo.bonus.fallback[0].unlimited = false; },
    (s: typeof bingo) => { s.gameConfig.linePrizeId = "other"; },
    (s: typeof bingo) => { s.bingo.catalog[0].label = "forged"; },
    (s: typeof bingo) => { s.bingo.catalog[0].id = s.bingo.catalog[1].id; },
  ]) {
    const forged = clone(bingo); alter(forged);
    check(!parseGamePoolSnapshot(forged).ok, "forged catalog/base/guarantee/config rejected");
  }
}
const blankSymbols = scratchFace({ id: "w", label: "Win", emoji: null }, Array.from({ length: 8 }, (_, n) => ({ id: `${n}`, label: `No emoji ${n}`, emoji: null })), () => 0.5);
equal(blankSymbols.cells.filter((p) => p.kind === "decoration").length, 6, "missing emojis use distinct neutral symbols, never repeated fallback diamonds");
const bonusOnly = buildBingoPoolSnapshot({ ...config, prizes: config.prizes.map((p) => p.id === "zfinite" ? { ...p, weight: 0 } : p) }, options, { size: 3, linePrizeId: "zfinite" }, card(511 & ~(1 << 4)));
check(bonusOnly.game === "bingo" && bonusOnly.bingo.bonus.selected?.w === 0, "available configured weight-zero bonus remains selected");
const codeBonus = buildBingoPoolSnapshot({ ...config, prizes: config.prizes.map((p) => p.id === "zfinite" ? { ...p, delivery: "codes", stock: 2 } : p) }, options, { size: 3, linePrizeId: "zfinite" }, card(511 & ~(1 << 4)));
check(codeBonus.game === "bingo" && codeBonus.bingo.bonus.selected?.unlimited === false, "code bonus always has finite inventory");
const reservedOnly = buildBingoPoolSnapshot({ ...config, prizes: config.prizes.map((p) => p.id === "zfinite" ? { ...p, delivery: "codes", stock: 0 } : p) },
  { ...options, chase: { prizeId: "zfinite", counter: 0, within: 10, reserved: true } }, { size: 3, linePrizeId: "zfinite" }, card(0));
check(reservedOnly.game === "bingo" && reservedOnly.bingo.bonus.selected === null && !reservedOnly.bingo.bonus.fallback.some((p) => p.id === "zfinite"), "personal primary reservation never becomes free bonus inventory");
const neutralFallback = buildBingoPoolSnapshot({ ...config, prizes: config.prizes.map((p) => p.id === "p1" ? { ...p, rarity: "rare" } : p.id === "zfinite" ? { ...p, stock: 0 } : p) },
  { ...options, happyHourMultiplier: 5, focus: { prizeId: "p1", multiplier: 5, spinsLeft: 10, totalSpins: 10 } }, { size: 3, linePrizeId: "zfinite" }, null);
check(neutralFallback.game === "bingo" && neutralFallback.bingo.bonus.selected === null, "sold-out selected prize uses fallback");
if (neutralFallback.game === "bingo") {
  equal(neutralFallback.bingo.bonus.fallback.map((p) => p.w), [1, 2], "bonus keeps base tickets despite happy hour and focus");
  equal(pickLineBonus(neutralFallback.bingo.bonus, new Set(), () => 0.2).id, "p0", "weighted fallback draw uses neutral odds");
}
const noBonusRng = drawGame(multi, { excluded: [], won: "p4" }, (() => { let calls = 0; return () => { calls++; if (calls > 1) throw Error("unexpected bonus RNG"); return 0.25; }; })());
equal(noBonusRng.bonuses.length, 4, "direct selected bonuses use zero RNG draws");
const exactEv = estimateBingoValue(config, { linePrizeId: "zfinite", plays: 1, before: card(510) });
check(Math.abs(exactEv.expectedLines - 3 / 48) < 1e-12, "one-play line expectation matches analytic primary chance");
check(Math.abs(exactEv.expectedPrimaryCostCents! - 137.5) < 1e-12, "ordinary payout cost matches weighted analytic EV");
check(Math.abs(exactEv.expectedBonusCostCents! - 43.75) < 1e-12, "three potential lines each include selected bonus cost");

const ev = estimateBingoValue(config, { linePrizeId: "zfinite", plays: 1, before: card(511 & ~(1 << 4)), priceCents: 1 });
check(ev.available && ev.expectedLines > 0, "EV includes new line bonuses");
check(ev.expectedTotalCostCents! > ev.expectedPrimaryCostCents!, "total EV includes ordinary plus line payouts");
check(ev.priceBelowExpectedCost, "cents price compared to total cost");
const missing = estimateBingoValue({ ...config, prizes: config.prizes.map((p) => p.id === "zfinite" ? { ...p, cost: null } : p) }, { linePrizeId: "zfinite", plays: 1, before: card(511 & ~(1 << 4)), priceCents: 0 });
equal(missing.expectedTotalCostCents, null, "unknown potential payout cost stays unknown");
check(missing.expectedKnownCostCents > 0 && missing.priceBelowExpectedCost, "known lower bound still warns below cost");
const zero = estimateBingoValue({ ...config, prizes: config.prizes.map((p) => ({ ...p, cost: 0 })) }, { linePrizeId: "zfinite", plays: 1 });
equal(zero.expectedTotalCostCents, 0, "explicit zero costs known");

async function properties() {
  const unsafe = buildScratchPoolSnapshot({ id: "safe", title: "Safe", prizes: [{ id: "a", label: "<script>alert(1)</script>", emoji: "<svg>", rarity: "common", weight: 1, cost: 77712345 }] }, options);
  const unsafeHash = await hashGamePoolSnapshot(unsafe);
  const unsafeDraw = drawGame(unsafe, { excluded: [] }, await makeGameRngV3("safe", "", 0, unsafeHash));
  const safeReplay = await replayGameV3({ serverSeed: "safe", clientSeed: "", nonce: 0, snapshot: unsafe, poolHash: unsafeHash, trace: unsafeDraw.trace, presentation: unsafeDraw.presentation, prizeId: "a", prizeLabel: "<script>alert(1)</script>" });
  const safeHtml = renderToStaticMarkup(createElement(GameProof, { replay: safeReplay }));
  check(safeHtml.includes("&lt;script&gt;") && !safeHtml.includes("<script>") && !safeHtml.includes("77712345"), "public ticket escapes labels and never carries creator costs");
  check(renderToStaticMarkup(createElement(GameProof, { replay: { ...safeReplay, ok: false } })) === "", "failed proof never presents a claimed valid face");
  const hashFixture = await hashGamePoolSnapshot(scratch);
  const legacyRng = await makeFairRngV3("prefix", "client", 1, hashFixture);
  const gameRng = await makeGameRngV3("prefix", "client", 1, hashFixture);
  for (let i = 0; i < 64; i++) equal(gameRng(), legacyRng(), `legacy prefix float ${i} preserved`);
  const block8 = await sha256Hex(`prefix:client:1:${hashFixture}:8`);
  equal(gameRng(), parseInt(block8.slice(0, 8), 16) / 4294967296, "65th float uses cryptographic block8 continuation");
  const bounded = await makeGameRngV3("prefix", "client", 1, hashFixture);
  for (let i = 0; i < MAX_GAME_RANDOM_DRAWS; i++) check(bounded() >= 0, "every allowed bounded draw exists");
  throws(() => bounded(), "game RNG throws at documented bound instead of reseeding");
  check(MAX_GAME_RANDOM_DRAWS >= 50 + 49 + 50 + 4, "documented bound covers worst-case primary/card/bonus retries");
  const golden = buildScratchPoolSnapshot({ id: "fixture", title: "Fixture", prizes: [
    { id: "a", label: "A", emoji: "★", rarity: "common", weight: 2 },
    { id: "b", label: "B", emoji: "★️", rarity: "rare", weight: 1 },
  ] }, options);
  const goldenHash = await hashGamePoolSnapshot(golden);
  equal(goldenHash, "34b003f96a90eea7e842344302e60a109356c7aafdec177562ccb019c1151019", "scratch-v1 canonical hash fixture");
  const goldenDraw = drawGame(golden, { excluded: [] }, await makeGameRngV3("golden", "client", 1, goldenHash));
  equal(goldenDraw.presentation.kind === "scratch" && goldenDraw.presentation.cells.map((c) => c.id),
    ["scratch-v1:circle", "a", "scratch-v1:diamond", "scratch-v1:crescent", "a", "scratch-v1:flower", "scratch-v1:triangle", "scratch-v1:square", "a"], "scratch-v1 exact cosmetic draw-order fixture");
  let scratches = 0, bingos = 0, exclusions = 0, lineBonuses = 0, bonusFailures = 0;
  for (let n = 0; n < 10000; n++) {
    const local: WheelConfig = { ...config, prizes: config.prizes.map((p, i) => ({ ...p, weight: 1 + ((n + i * 13) % 30) })) };
    const modifiers = { pityCounter: n % 10, happyHourMultiplier: n % 7 === 0 ? 5 : null,
      ...(n % 5 === 0 ? { focus: { prizeId: "p4", multiplier: 3, spinsLeft: 5, totalSpins: 10 } } :
      n % 5 === 1 ? { chase: { prizeId: "p4", counter: n % 10, within: 10, reserved: false } } : {}) };
    let snapshot: GamePoolSnapshot;
    if (n % 2 === 0) { snapshot = buildScratchPoolSnapshot(local, modifiers); scratches++; }
    else { const mask = (n * 19) % 512; snapshot = buildBingoPoolSnapshot(local, modifiers, { size: 3, linePrizeId: "zfinite" }, n % 3 ? card(mask) : null); bingos++; }
    const hash = await hashGamePoolSnapshot(snapshot);
    const rng = await makeGameRngV3(`server${n}`, `client${n}`, n, hash);
    const first = drawFromSnapshot(primarySnapshot(snapshot), new Set(), rng);
    const excluded = n % 3 === 0 && first.prize.id === "zfinite" ? ["zfinite"] : [];
    if (excluded.length) exclusions++;
    const run = () => makeGameRngV3(`server${n}`, `client${n}`, n, hash);
    let draw = drawGame(snapshot, { excluded }, await run());
    if (n % 4 === 1 && draw.bonuses.some((b) => b.prize.id === "zfinite")) {
      const failureIndex = n % draw.bonuses.length;
      const failures = draw.trace.bonuses.map((b, i) => ({ ...b, excluded: i === failureIndex ? ["zfinite"] : [], won: i < failureIndex ? "zfinite" : "p0" }));
      draw = drawGame(snapshot, { excluded }, await run(), failures);
      bonusFailures++;
    }
    assert.ok(parseGamePresentation(draw.presentation, { kind: draw.presentation.kind, prizeId: draw.primary.prize.id, label: draw.primary.prize.label }), `client presentation guard seed ${n}`);
    lineBonuses += draw.bonuses.length;
    if (draw.presentation.kind === "scratch") {
      const tally = new Map<string, number>();
      for (const c of draw.presentation.cells) tally.set(c.id, (tally.get(c.id) ?? 0) + 1);
      assert.equal(tally.get(draw.primary.prize.id), 3);
      assert.equal([...tally.values()].filter((v) => v === 3).length, 1);
      assert.equal([...tally.values()].filter((v) => v === 1).length, 6);
      const symbols = draw.presentation.cells.filter((c) => c.id !== draw.primary.prize.id).map((c) => c.emoji?.normalize("NFKC").replace(/[\uFE0F\uFE0E\u200D]/gu, "") ?? c.label);
      assert.equal(new Set(symbols).size, 6);
    } else {
      assert.equal(draw.presentation.after.awardedLinesMask, completedLines(draw.presentation.after.markedMask));
      assert.equal(draw.bonuses.length, draw.presentation.newLines.length);
      assert.equal(new Set(draw.presentation.after.cells.map((p) => p.id)).size, 9);
    }
    const input = { serverSeed: `server${n}`, clientSeed: `client${n}`, nonce: n, snapshot, poolHash: hash, trace: draw.trace,
      presentation: draw.presentation, prizeId: draw.primary.prize.id, prizeLabel: draw.primary.prize.label };
    const replay = await replayGameV3(input);
    assert.ok(replay.ok, replay.problem ?? `seed ${n}`);
    assert.equal(canonicalJson(replay.draw), canonicalJson(draw));
    if (n === 0 || n === 1) {
      const html = renderToStaticMarkup(createElement(GameProof, { replay }));
      check(html.includes(n === 0 ? "Replayed scratch ticket" : "Replayed bingo card"), "verify names the reproduced game");
      check(html.includes(n === 0 ? "<ol" : "<table"), "verify uses semantic cells/card without canvas");
      const oddsHtml = renderToStaticMarkup(createElement(OddsUsed, { replay: gameOddsReplay(replay), poolHash: hash, game: true }));
      check(oddsHtml.includes("Game and odds fingerprint") && oddsHtml.includes("bonus pools"), "verify fingerprint copy includes all committed game context");
    }
    if (n < 30) {
      const forged = clone(draw.presentation);
      if (forged.kind === "scratch") forged.cells.reverse();
      else forged.after.version++;
      if (canonicalJson(forged) !== canonicalJson(draw.presentation)) check(!(await replayGameV3({ ...input, presentation: forged })).ok, "forged face/card refused");
      check(!(await replayGameV3({ ...input, snapshot: { ...snapshot, gameConfig: { ...snapshot.gameConfig, hidden: true } } })).ok, "forged config refused");
      check(!(await replayGameV3({ ...input, trace: { ...draw.trace, bonuses: [...draw.trace.bonuses, { line: 0, excluded: [], won: "p0" }] } })).ok, "forged line bonus refused");
    }
  }
  console.log(`${checks} checks and 10,000 deterministic full game replays passed (scratch=${scratches}, bingo=${bingos}, primary exclusions=${exclusions}, line bonuses=${lineBonuses}, bonus stock failures=${bonusFailures}).`);
}
properties().catch((error) => { console.error(error); process.exitCode = 1; });
