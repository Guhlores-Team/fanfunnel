import assert from "node:assert";
import { readFileSync } from "node:fs";
import { spinIntentBody, type BrowserSpinIntent } from "../fan/spinIntent";
import { RARITY_COLORS, RARITY_ORDER, type Rarity } from "@/lib/games/wheel/types";
import {
  BUILD_UP_RARITIES,
  MAX_THEATER_EXTRA_MS,
  REDUCED_SPIN_MS,
  REVEAL_IDLE,
  SKIP_AFTER_SPINS,
  SKIP_LANDING,
  SPIN_MS,
  SPIN_WATCHDOG_MS,
  canSkip,
  nearStopAtMs,
  resolveRevealTier,
  revealConfetti,
  revealEntrance,
  revealInFlight,
  revealReducer,
  spinDurationMs,
  theaterExtraMs,
  theaterVisible,
  type RevealEvent,
  type RevealState,
} from "./revealTiers";

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

// --- tier mapping ----------------------------------------------------------
{
  const tiers = RARITY_ORDER.map((r) => resolveRevealTier(r));

  check("default build-up rarities are epic + legendary (D1 option b)",
    BUILD_UP_RARITIES.length === 2 && BUILD_UP_RARITIES.includes("epic") && BUILD_UP_RARITIES.includes("legendary"));
  check("only epic and legendary build up by default",
    tiers.filter((t) => t.buildUp).map((t) => t.rarity).join(",") === "epic,legendary");

  for (let i = 1; i < tiers.length; i++) {
    const [a, b] = [tiers[i - 1], tiers[i]];
    check(`spin time never shrinks with rarity (${a.rarity} → ${b.rarity})`, spinDurationMs(b) >= spinDurationMs(a));
    check(`theater extra never shrinks with rarity (${a.rarity} → ${b.rarity})`, theaterExtraMs(b) >= theaterExtraMs(a));
    check(`medallion never shrinks with rarity (${a.rarity} → ${b.rarity})`, b.medallionPx >= a.medallionPx);
    check(`rank climbs with rarity (${b.rarity})`, b.rank === a.rank + 1);
  }
  check("legendary is strictly longer than common", spinDurationMs(tiers[4]) > spinDurationMs(tiers[0]));

  const common = resolveRevealTier("common");
  check("common adds no time at all", theaterExtraMs(common) === 0 && spinDurationMs(common) === SPIN_MS);
  check("uncommon adds no time at all", theaterExtraMs(resolveRevealTier("uncommon")) === 0);
  check("common keeps today's quick pop: lift, no confetti", common.stopEffect === "lift" && common.confetti === 0);

  const rare = resolveRevealTier("rare");
  check("rare: spin unchanged, spotlight at the stop", rare.extraMs === 0 && rare.stopEffect === "spotlight" && !rare.buildUp);

  const epic = resolveRevealTier("epic");
  check("epic: +500ms slower stop", epic.extraMs === 500);
  check("epic: 70% dim during the build-up", epic.dim === 0.7);
  check("epic: purple glow", epic.color === RARITY_COLORS.epic);
  check("epic: build-up ~1s before the stop", nearStopAtMs(epic) === SPIN_MS + 500 - 1000);

  const legendary = resolveRevealTier("legendary");
  check("legendary: +1.0s slower stop", legendary.extraMs === 1000);
  check("legendary: gold rays + rumble", legendary.rays && legendary.buildUpSound === "rumble");
  check("legendary: Share is the primary button", legendary.sharePrimary && !epic.sharePrimary);
  check("legendary: build-up ~1.2s before the stop", nearStopAtMs(legendary) === SPIN_MS + 1000 - 1200);
  check("non-build-up tiers have no near-stop", nearStopAtMs(common) === null && nearStopAtMs(rare) === null);

  for (const t of tiers) {
    check(`${t.rarity}: theater extra within the ${MAX_THEATER_EXTRA_MS}ms cap`, theaterExtraMs(t) <= MAX_THEATER_EXTRA_MS);
    check(`${t.rarity}: whole reveal fits under the watchdog`, spinDurationMs(t) + t.stopBeatMs < SPIN_WATCHDOG_MS);
    check(`${t.rarity}: uses the shared rarity colour`, t.color === RARITY_COLORS[t.rarity]);
    check(`${t.rarity}: dim stays a dim, never a blackout`, t.dim >= 0 && t.dim <= 0.7);
  }
  check("legendary uses the full cap and no more", theaterExtraMs(legendary) === MAX_THEATER_EXTRA_MS);
  check("watchdog outlasts the longest theater", SPIN_WATCHDOG_MS > SPIN_MS + MAX_THEATER_EXTRA_MS);

  // Reduced motion: a calm, static reveal that still carries the rarity.
  for (const r of RARITY_ORDER) {
    const t = resolveRevealTier(r, { reducedMotion: true });
    check(`${r} reduced: adds no time`, theaterExtraMs(t) === 0 && spinDurationMs(t) === REDUCED_SPIN_MS);
    check(`${r} reduced: no build-up, dim, rays or confetti`, !t.buildUp && t.dim === 0 && !t.rays && t.confetti === 0);
    check(`${r} reduced: nothing animates`, t.animate === false);
    check(`${r} reduced: rarity still carried (label, colour, rank)`,
      t.label.length > 0 && t.color === RARITY_COLORS[r] && t.rank === RARITY_ORDER.indexOf(r) + 1);
  }

  // D1 is one constant: (a) no build-up, (c)-ish adds rare.
  check("D1 option (a): [] means no build-up anywhere",
    RARITY_ORDER.every((r) => !resolveRevealTier(r, { buildUpRarities: [] }).buildUp));
  check("D1 option (a): legendary then adds only the stop beat",
    theaterExtraMs(resolveRevealTier("legendary", { buildUpRarities: [] })) === legendary.stopBeatMs);
  const rareBuild = resolveRevealTier("rare", { buildUpRarities: ["rare", "epic", "legendary"] });
  check("D1 option (c)-ish: rare builds up when listed", rareBuild.buildUp && rareBuild.extraMs > 0);

  check("unknown rarity falls back to common", resolveRevealTier("mythic" as Rarity).rarity === "common");
  check("missing rarity falls back to common", resolveRevealTier(undefined).rarity === "common");
}

// --- reveal state machine + skip ---------------------------------------------
function run(events: RevealEvent[], from: RevealState = REVEAL_IDLE): RevealState {
  return events.reduce(revealReducer, from);
}
const start = (rarity: Rarity, reducedMotion = false, spinsBefore = 0): RevealEvent => ({ type: "start", rarity, reducedMotion, spinsBefore });

{
  check("common: stop opens the card at once", run([start("common"), { type: "stop" }]).phase === "revealed");
  check("common: near-stop does nothing", run([start("common"), { type: "nearStop" }]).phase === "spinning");

  const leg = run([start("legendary"), { type: "nearStop" }]);
  check("legendary: near-stop enters the build-up", leg.phase === "buildup");
  check("legendary: theater visible in the build-up", theaterVisible(leg));
  const landed = revealReducer(leg, { type: "stop" });
  check("legendary: stop holds on the landed slice", landed.phase === "landed");
  check("legendary: theater stays up through the hold", theaterVisible(landed));
  const opened = revealReducer(landed, { type: "beatDone" });
  check("legendary: the hold ends on the card", opened.phase === "revealed" && !theaterVisible(opened));
  check("legendary: animated entrance + confetti when not skipped",
    revealEntrance(opened) === "animated" && revealConfetti(opened) > 0);
  check("close returns to idle", revealReducer(opened, { type: "close" }).phase === "idle");

  // Tap-to-skip mid-spin: flags skip, the wheel snaps, its stop lands on the card.
  const skipping = run([start("legendary"), { type: "nearStop" }, { type: "skip" }]);
  check("skip mid-spin flags skipped and drops the theater", skipping.skipped && !theaterVisible(skipping));
  const skippedOpen = revealReducer(skipping, { type: "stop" });
  check("skip: the stop goes straight to the card (no hold)", skippedOpen.phase === "revealed");
  check("skip lands on the final state: static, no confetti",
    revealEntrance(skippedOpen) === SKIP_LANDING.entrance && revealConfetti(skippedOpen) === 0);
  check("skip before the build-up suppresses it", run([start("epic"), { type: "skip" }, { type: "nearStop" }]).phase === "spinning");
  check("skip during the landed hold opens the card", run([start("epic"), { type: "nearStop" }, { type: "stop" }, { type: "skip" }]).phase === "revealed");
  check("skip is idempotent", run([start("rare"), { type: "skip" }, { type: "skip" }]).skipped);
  check("skip when idle does nothing", revealReducer(REVEAL_IDLE, { type: "skip" }) === REVEAL_IDLE);
  check("skip on the open card does nothing", revealReducer(opened, { type: "skip" }) === opened);
  check("a late stop after the card opened is ignored", revealReducer(opened, { type: "stop" }) === opened);
  check("a new spin clears the skip flag", !run([start("legendary"), { type: "skip" }, start("common")]).skipped);

  // Reduced motion: no build-up, no hold, a static card.
  const calm = run([start("legendary", true), { type: "nearStop" }]);
  check("reduced: near-stop never dims", calm.phase === "spinning" && !theaterVisible(calm));
  const calmOpen = revealReducer(calm, { type: "stop" });
  check("reduced: stop opens the card at once", calmOpen.phase === "revealed");
  check("reduced: the card is static with no confetti", revealEntrance(calmOpen) === "static" && revealConfetti(calmOpen) === 0);

  check("in flight from start to the card", ["spinning", "buildup", "landed"].every((p) => revealInFlight(p as RevealState["phase"])));
  check("not in flight idle or revealed", !revealInFlight("idle") && !revealInFlight("revealed"));

  // When Skip is offered.
  const base = { phase: "spinning" as const, skipped: false, reducedMotion: false };
  check("skip shows after the first spin of a session (default 1)", SKIP_AFTER_SPINS === 1);
  check("no skip on the session's first spin", !canSkip({ ...base, spinsBefore: 0 }));
  check("skip offered from the second spin", canSkip({ ...base, spinsBefore: 1 }));
  check("skip offered in the build-up and the hold",
    canSkip({ ...base, phase: "buildup", spinsBefore: 3 }) && canSkip({ ...base, phase: "landed", spinsBefore: 3 }));
  check("no skip once the card is open or idle",
    !canSkip({ ...base, phase: "revealed", spinsBefore: 3 }) && !canSkip({ ...base, phase: "idle", spinsBefore: 3 }));
  check("no skip after skipping", !canSkip({ ...base, skipped: true, spinsBefore: 3 }));
  check("no skip under reduced motion (nothing to skip)", !canSkip({ ...base, reducedMotion: true, spinsBefore: 3 }));

  // The session's first spin plays in full, its landed hold included, even
  // though it counts as finished the moment the wheel stops.
  const first = run([start("legendary", false, 0), { type: "nearStop" }, { type: "stop" }]);
  check("first spin: no skip in its landed hold", first.phase === "landed" && !canSkip({ ...first, reducedMotion: false }));
  const second = run([start("legendary", false, 1), { type: "nearStop" }]);
  check("second spin: skip offered in the build-up", canSkip({ ...second, reducedMotion: false }));
  check("the session count survives closing the card",
    run([start("common", false, 2), { type: "stop" }, { type: "close" }]).spinsBefore === 2);
}

// --- the theater cannot influence the outcome --------------------------------
// The outcome request carries only fan identity, seed and durable attempt binding.
// Theater state must not cross the transport boundary or pick the awarded prize.
{
  const client = readFileSync(new URL("../SpinClient.tsx", import.meta.url), "utf8");
  const recovery = readFileSync(new URL("../fan/useSpinRecovery.ts", import.meta.url), "utf8");
  check("SpinClient delegates spins to the recovery hook, without a second spin transport",
    /import \{ useSpinRecovery \} from "\.\/fan\/useSpinRecovery"/.test(client) &&
    /const recovery = useSpinRecovery\(\{[\s\S]*?onCommitted, onRefusal \}\)/.test(client) &&
    /await recovery\.begin\(clientSeed, nextSpinHash\)/.test(client) && !/fetch\("\/api\/spin"/.test(client));
  const calls = [...recovery.matchAll(/postIntent\("\/api\/spin", token, saved\)/g)];
  check("the recovery hook has exactly one /api/spin call", calls.length === 1);
  check("that transport serializes only the shared intent body",
    /fetch\(path,[\s\S]*?body: JSON\.stringify\(spinIntentBody\(token, intent\)\)/.test(recovery));
  const intent: BrowserSpinIntent = { v: 1, requestId: "4199c8cd-d2ea-4a3e-92b7-77fe34cdbf7a", clientSeed: "seed", publishedSeedHash: "a".repeat(64) };
  for (const bound of [intent, { ...intent, publishedSeedHash: undefined }]) {
    // Runtime extra fields cannot smuggle rarity, prize, timing or skip state.
    const body = spinIntentBody("fan-token", { ...bound, rarity: "legendary", prize: "chosen", skipped: true, phase: "revealed" } as BrowserSpinIntent);
    assert.deepEqual(body, { token: "fan-token", requestId: intent.requestId, clientSeed: intent.clientSeed,
      ...(bound.publishedSeedHash ? { publishedSeedHash: intent.publishedSeedHash } : {}) });
    passed++;
  }
  const committed = client.slice(client.indexOf("const onCommitted ="), client.indexOf("const onRefusal ="));
  check("the reveal starts only from the committed server prize",
    /dispatchReveal\(\{\s*type: "start", rarity: data\.prize\.rarity/.test(committed) &&
    /setWon\(data\.prize\)/.test(committed) && /setResult\(\{ index: data\.prizeIndex/.test(committed));
  for (const f of ["revealTiers.ts", "RewardReveal.tsx", "RevealTheater.tsx"]) {
    const src = readFileSync(new URL(`./${f}`, import.meta.url), "utf8");
    check(`${f} makes no network calls`, !/\bfetch\(|XMLHttpRequest|sendBeacon|\/api\//.test(src));
  }
}

console.log(`revealTiers.test: ${passed} checks passed`);
