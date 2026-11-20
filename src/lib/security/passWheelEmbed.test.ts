// 0065 gives fan_passes a second foreign key to wheels (pinned_wheel_id), so a
// PostgREST embed between the two tables must name its foreign key: a bare
// `wheels(...)` from fan_passes (or `fan_passes(...)` from wheels) fails at
// runtime with PGRST201, which the in-memory fakes used by unit tests do not
// model. This scans every non-test source file for such an embed.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dirname, "../../..");
const SRC = join(ROOT, "src");
const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? walk(path) : /\.(ts|tsx)$/.test(name) && !/\.test\.ts$/.test(name) ? [path] : [];
});
let checks = 0;
const bad: string[] = [];
let hinted = 0;
for (const file of walk(SRC)) {
  if (file.endsWith("db.types.ts")) continue;
  const source = readFileSync(file, "utf8");
  for (const [table, other] of [["fan_passes", "wheels"], ["wheels", "fan_passes"]] as const) {
    // The statement that reads `table`: from the table name to the end of its chain.
    for (const match of source.matchAll(new RegExp(`["'\`]${table}["'\`]`, "g"))) {
      const window = source.slice(match.index ?? 0, (match.index ?? 0) + 600).split(/;\s*\n/)[0];
      checks++;
      if (new RegExp(`\\b${other}\\(`).test(window)) bad.push(`${relative(ROOT, file)}: embeds ${other} from ${table} without naming the foreign key`);
      if (new RegExp(`\\b${other}!fan_passes_wheel_id_fkey\\(`).test(window)) hinted++;
    }
  }
}
assert.deepEqual(bad, [], bad.join("\n"));
assert.ok(hinted >= 3, `the known fan_passes -> wheels embeds name fan_passes_wheel_id_fkey (found ${hinted})`);
console.log(`passWheelEmbed.test: ${checks} fan_passes/wheels reads checked, ${hinted} named embeds, none ambiguous`);
