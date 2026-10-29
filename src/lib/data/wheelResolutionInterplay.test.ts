// TS mirror of the SQL game-resolution matrix (A26 interplay suite). The
// fixture is what scripts/db/interplayProbe.mjs observed on a real Postgres:
// per case the wheel/campaign rows, the pass, SQL's now() and the game each
// SQL path chose. resolveWheelId (the fan-page and spin-route read) must pick
// the same game as _resolved_spin_wheel on exactly those rows.
// Default mode prints documented issuance/spin disagreements as KNOWN-BUG;
// INTERPLAY_STRICT=1 fails on them. An undocumented disagreement always fails.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolveWheelId } from "./wheels";
import type { AnyClient } from "./shared";
interface Row extends Record<string, unknown> { id: string; creator_id: string }
interface Case {
  id: string; now: string; wheels: Row[]; campaigns: Row[];
  pass: { creator_id: string; campaign_id: string | null; wheel_id: string };
  letters: Record<string, string>;
  result: { issuance: string | null; context: string | null; spin: string | null };
  expected: { issuance: string | null; spin: string | null; bug?: string; surprise?: string };
}
const fixture = JSON.parse(readFileSync(new URL("../../../scripts/db/interplay-resolution.fixture.json", import.meta.url), "utf8")) as { bugs: Record<string, string>; surprises: Record<string, string>; cases: Case[] };
const strict = process.env.INTERPLAY_STRICT === "1";
const client = (c: Case): AnyClient => ({ from: (table: string) => {
  let rows: Row[] = table === "wheels" ? [...c.wheels] : table === "campaigns" ? [...c.campaigns] : [];
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.eq = (key: string, value: unknown) => { rows = rows.filter(row => row[key] === value); return chain; };
  chain.is = chain.eq;
  chain.maybeSingle = async () => ({ data: rows[0] ?? null, error: null });
  chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(resolve);
  return chain;
} } as unknown as AnyClient);
let checks = 0; const knownBugs: string[] = []; const surprises = new Set<string>();
async function main() {
  assert.ok(fixture.cases.length >= 40, "fixture carries the full matrix");
  for (const c of fixture.cases) {
    const ts = await resolveWheelId(client(c), c.pass, new Date(c.now));
    const tsLetter = ts ? c.letters[ts] ?? "?" : null;
    assert.equal(tsLetter, c.result.spin, `${c.id}: TS resolveWheelId (${tsLetter}) disagrees with SQL _resolved_spin_wheel (${c.result.spin})`); checks++;
    assert.equal(c.result.spin, c.expected.spin, `${c.id}: documented spin-time expectation`); checks++;
    assert.equal(c.result.context, c.result.spin, `${c.id}: SQL prepare context agrees with spin-time`); checks++;
    if (c.expected.surprise) surprises.add(c.expected.surprise);
    if (c.expected.bug) {
      assert.notEqual(c.result.issuance, c.result.spin, `${c.id}: documented bug ${c.expected.bug} no longer reproduces; update interplayCases.mjs`); checks++;
      knownBugs.push(`${c.expected.bug}: ${c.id} minted for ${c.result.issuance}, played on ${c.result.spin}`);
    }
  }
  for (const line of knownBugs) console.log(`KNOWN-BUG ${line}`);
  for (const id of new Set(knownBugs.map(l => l.split(":")[0]))) console.log(`KNOWN-BUG ${id} = ${fixture.bugs[id]}`);
  console.log(`surprising-but-intended: ${[...surprises].sort().join(", ")}`);
  if (strict && knownBugs.length) assert.fail(`INTERPLAY_STRICT: ${knownBugs.length} documented issuance/spin disagreements still reproduce`);
  console.log(`wheelResolutionInterplay.test: ${checks} checks over ${fixture.cases.length} cases, TS mirror agrees with SQL on every case (${knownBugs.length} known-bug lines)`);
}
main().catch(error => { console.error(error); process.exit(1); });
