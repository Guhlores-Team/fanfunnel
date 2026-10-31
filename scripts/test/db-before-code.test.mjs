// A39 workflow guard: DB-before-code ordering for Production.
//
//   node scripts/test/db-before-code.test.mjs
//
// Production code may not be promoted before its migrations are applied. The
// mechanism (docs/GO_LIVE.md section 5): Vercel Deployment Checks hold every
// Production deployment until the GitHub check `db-migrations-production`
// passes, and that job runs on every push to main, applies migrations, then
// re-reads the remote history. This test pins the parts that live in the repo:
// the history verifier, the job's trigger/name/order, and the doc naming the
// same check. Pure: no network, no secrets, no hosted project.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { compareHistory, localVersions, parseMigrationList, verify } from "../ci/verify-migrations-applied.mjs";
import { jobBlock, readWorkflow, stepIf, steps } from "./workflow-text.mjs";

let passed = 0;
const check = (label, ok) => {
  assert.ok(ok, label);
  passed++;
};
const refused = (fn, code) => {
  assert.throws(fn, (e) => e instanceof Error && e.message.startsWith(code));
  passed++;
};

const FILES = readdirSync(new URL("../../supabase/migrations/", import.meta.url));
const VERSIONS = localVersions(FILES);
const CHECK_NAME = "db-migrations-production";

// The table layout `supabase migration list` prints, with its progress line.
const listing = (rows) =>
  [
    "Connecting to remote database...",
    "",
    "  ",
    "   Local | Remote | Time (UTC) ",
    "  -------|--------|------------",
    ...rows.map(([l, r]) => `   ${l.padEnd(4)} | ${r.padEnd(4)} | ${l || r} `),
    "",
  ].join("\n");
const full = VERSIONS.map((v) => [v, v]);

// ------------------------------------------------------------ the verifier ---
check("every migration file has a numeric version", VERSIONS.length === FILES.filter((f) => f.endsWith(".sql")).length);
check("versions are ordered and the newest is last", VERSIONS.join() === [...VERSIONS].sort().join() && VERSIONS.at(-1) === FILES.filter((f) => f.endsWith(".sql")).sort().at(-1).split("_")[0]);
refused(() => localVersions(["0001_a.sql", "0001_b.sql"]), "MIGRATION_VERSION_DUPLICATED");
refused(() => localVersions(["init.sql"]), "MIGRATION_NAME_UNPARSEABLE");
check("fully applied history passes", verify(listing(full), FILES, "PRODUCTION").ok);
check("pass message names the newest migration", verify(listing(full), FILES, "PRODUCTION").lines[0].includes(`through ${VERSIONS.at(-1)}`));
const missingLatest = verify(listing(full.map(([l, r], i) => [l, i === full.length - 1 ? "" : r])), FILES, "PRODUCTION");
check("the newest migration missing remotely fails", !missingLatest.ok && missingLatest.lines.some((l) => l.startsWith("::error title=PRODUCTION migrations not verified::") && l.includes(VERSIONS.at(-1))));
const missingMiddle = compareHistory(VERSIONS, parseMigrationList(listing(full.map(([l, r]) => [l, l === "0042" ? "" : r]))));
check("a gap in the middle fails", !missingMiddle.ok && missingMiddle.problems.join().includes("0042"));
const unknown = compareHistory(VERSIONS, parseMigrationList(listing([...full, ["", "9999"]])));
check("a remote version with no file in this commit fails", !unknown.ok && unknown.problems.join().includes("9999"));
const unlisted = compareHistory(VERSIONS, parseMigrationList(listing(full.slice(1))));
check("a listing from a different checkout fails", !unlisted.ok);
check("an empty table fails", !compareHistory(VERSIONS, parseMigrationList(listing([]))).ok);
check("no local migrations fails", !compareHistory([], parseMigrationList(listing(full))).ok);
for (const [label, text] of [
  ["empty output", ""],
  ["CLI error text", "Error: failed to connect to postgres"],
  ["rows without a header", "  0001 | 0001 | 0001\n"],
  ["non-numeric cell", listing([["0001", "abcd"]])],
  ["row with neither side", listing([["", ""]])],
]) {
  check(`fails closed on ${label}`, !verify(text, FILES, "PRODUCTION").ok);
}
const VERIFIER = new URL("../ci/verify-migrations-applied.mjs", import.meta.url).pathname;
const cli = (input) => spawnSync(process.execPath, [VERIFIER, "--label", "PRODUCTION"], { input, encoding: "utf8", timeout: 10_000 });
check("CLI exits 0 on a complete history", cli(listing(full)).status === 0);
const cliMissing = cli(listing(full.slice(0, -1).concat([[VERSIONS.at(-1), ""]])));
check("CLI exits 1 with an annotation on a missing migration", cliMissing.status === 1 && /^::error title=PRODUCTION/m.test(cliMissing.stdout));
check("CLI exits 1 on empty input", cli("").status === 1);

// ------------------------------------------------------------ the workflow ---
const wf = readWorkflow("supabase-migrations.yml");

/** @param {string} text the workflow */
export function auditProductionGate(text) {
  const problems = [];
  const on = text.slice(text.indexOf("\non:\n"), text.indexOf("\nconcurrency:"));
  const push = on.slice(on.indexOf("\n  push:\n"), on.indexOf("\n  pull_request:"));
  if (!/\n {4}branches: \[main\]/.test(push)) problems.push("push trigger is not main");
  if (/\n {4}paths(-ignore)?:/.test(push)) problems.push("push trigger is path-filtered: code-only pushes would leave Vercel with no check");
  let job;
  try {
    job = jobBlock(text, "production");
  } catch {
    return [...problems, "production job missing"];
  }
  if (!job.includes(`\n    name: ${CHECK_NAME}\n`)) problems.push(`production job is not named ${CHECK_NAME}`);
  if (!job.includes("if: github.event_name == 'push' && github.ref == 'refs/heads/main'")) problems.push("production job condition changed");
  if (!job.includes("environment: production")) problems.push("production job lost its environment");
  const list = steps(job);
  const push_ = list.findIndex((s) => s.includes("supabase db push"));
  const verifyIdx = list.findIndex((s) => s.includes("node scripts/ci/verify-migrations-applied.mjs --label PRODUCTION"));
  if (push_ < 0) problems.push("production job no longer applies migrations");
  if (verifyIdx < 0) problems.push("production job has no history read-back");
  else {
    if (verifyIdx < push_) problems.push("read-back runs before the push");
    if (stepIf(list[verifyIdx])) problems.push("read-back is conditional");
    if (!list[verifyIdx].includes("set -euo pipefail") || !list[verifyIdx].includes("supabase migration list --linked")) problems.push("read-back can pass on a failed listing");
  }
  if (/continue-on-error/.test(job)) problems.push("production job may continue on error");
  return problems;
}
assert.deepEqual(auditProductionGate(wf), []);
passed++;
const mutations = [
  ["paths filter re-added", wf.replace("  push:\n    branches: [main]\n", '  push:\n    branches: [main]\n    paths:\n      - "supabase/migrations/**"\n')],
  ["check renamed", wf.replace(`    name: ${CHECK_NAME}\n`, "    name: production\n")],
  ["read-back removed", wf.replace("node scripts/ci/verify-migrations-applied.mjs --label PRODUCTION", "echo skipped")],
  ["pipefail removed", wf.replace(/(Verify PRODUCTION[\s\S]*?)set -euo pipefail\n/, "$1")],
  ["continue-on-error", wf.replace("    environment: production\n", "    environment: production\n    continue-on-error: true\n")],
];
for (const [label, mutated] of mutations) check(`checker rejects mutation: ${label}`, mutated !== wf && auditProductionGate(mutated).length > 0);

const testJob = jobBlock(wf, "test");
check("TEST job also reads back its history after the push", steps(testJob).findIndex((s) => s.includes("--label TEST")) > steps(testJob).findIndex((s) => s.includes("supabase db push")));
check("TEST job keeps refusing a non-TEST ref", testJob.includes('test "${{ secrets.SUPABASE_TEST_PROJECT_REF }}" = "snmcrmhgevfqggxdiomu"'));
check("the existing TEST history step name is kept", testJob.includes("      - name: Confirm TEST migration history\n"));
const workflows = readdirSync(new URL("../../.github/workflows/", import.meta.url)).filter((f) => f.endsWith(".yml"));
const uses = workflows.flatMap((f) => [...readWorkflow(f).matchAll(new RegExp(`(?:\\n {4}name: |\\n {2})${CHECK_NAME}:?\\n`, "g"))]);
check("the check name is unique across workflows (GitHub matches checks by job name)", uses.length === 1);

// --------------------------------------------------------------------- docs ---
const goLive = readFileSync(new URL("../../docs/GO_LIVE.md", import.meta.url), "utf8");
const section5 = goLive.slice(goLive.indexOf("## 5."), goLive.indexOf("## 6."));
check("GO_LIVE section 5 names the exact required Vercel check", section5.includes(`\`${CHECK_NAME}\``) && /Deployment Checks/.test(section5));
check("GO_LIVE section 5 states the residual gaps", /Residual gap/i.test(section5) && /Force Promote/.test(section5));
check("GO_LIVE section 5 records the runtime schema check as a 0066 follow-up", /0066/.test(section5) && /schema_version\(\)/.test(section5));
check("CI runs this guard", jobBlock(readWorkflow("ci.yml"), "verify").includes("node scripts/test/db-before-code.test.mjs"));

console.log(`db-before-code.test: ${passed} checks passed`);
