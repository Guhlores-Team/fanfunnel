// SC-07 guard: the PR migration job skips visibly, and only when it should.
//
//   node scripts/test/migration-test-gate.test.mjs
//
// Pure: no network, no secrets. Runs the gate's decision table and the real
// CLI (outputs, notice, summary), then pins how supabase-migrations.yml wires it.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decide } from "../ci/migration-test-gate.mjs";
import { jobBlock, readWorkflow, stepIf, steps } from "./workflow-text.mjs";

let passed = 0;
const check = (label, ok) => {
  assert.ok(ok, label);
  passed++;
};
const REPO = "Guhlores-Team/fanfunnel";
const base = { REPOSITORY: REPO, HEAD_REPO: REPO, ACTOR: "someone", CHANGED_FILES: "src/app/page.tsx\nREADME.md" };

// ------------------------------------------------------------ decision table ---
check("same-repo PR without DB changes runs", decide(base).run);
check("same-repo PR with DB changes runs", decide({ ...base, CHANGED_FILES: "supabase/migrations/0073_x.sql" }).run);
check("Dependabot PR without DB changes skips", !decide({ ...base, ACTOR: "dependabot[bot]" }).run);
check("Dependabot PR that touches supabase/ still runs (fails closed later)", decide({ ...base, ACTOR: "dependabot[bot]", CHANGED_FILES: "package.json\nsupabase/schema.sql" }).run);
check("fork PR without DB changes skips", !decide({ ...base, HEAD_REPO: "outsider/fanfunnel" }).run);
check("fork PR with a migration runs", decide({ ...base, HEAD_REPO: "outsider/fanfunnel", CHANGED_FILES: "supabase/migrations/0073_evil.sql" }).run);
check("fork detection ignores case", decide({ ...base, HEAD_REPO: REPO.toUpperCase() }).run);
check("a missing head repo is treated as same-repo (fail closed on secrets, not silently skipped)", decide({ ...base, HEAD_REPO: "" }).run);
check("an empty file list on an untrusted PR skips", !decide({ ...base, ACTOR: "dependabot[bot]", CHANGED_FILES: "" }).run);
check("only a path under supabase/ counts as a DB change", !decide({ ...base, ACTOR: "dependabot[bot]", CHANGED_FILES: "docs/supabase/notes.md\nsrc/lib/supabase/server.ts" }).run);
check("CRLF file lists are read", decide({ ...base, ACTOR: "dependabot[bot]", CHANGED_FILES: "a.ts\r\nsupabase/config.toml\r\n" }).run);
check("the skip reason names Dependabot", /Dependabot/.test(decide({ ...base, ACTOR: "dependabot[bot]" }).reason));
check("the skip reason names the fork", /outsider\/fanfunnel/.test(decide({ ...base, HEAD_REPO: "outsider/fanfunnel" }).reason));

// ---------------------------------------------------------------------- CLI ---
const GATE = new URL("../ci/migration-test-gate.mjs", import.meta.url).pathname;
const run = (env) => {
  const dir = mkdtempSync(join(tmpdir(), "ff-mig-gate-"));
  const out = join(dir, "out.txt");
  const summary = join(dir, "summary.md");
  writeFileSync(out, "");
  writeFileSync(summary, "");
  const r = spawnSync(process.execPath, [GATE], { env: { ...env, PATH: process.env.PATH, GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: summary }, encoding: "utf8", timeout: 10_000 });
  return { ...r, output: readFileSync(out, "utf8"), summary: readFileSync(summary, "utf8") };
};
const skipped = run({ ...base, ACTOR: "dependabot[bot]" });
check("CLI skip exits 0 (a skip is not a failure)", skipped.status === 0);
check("CLI skip writes run=false", skipped.output === "run=false\n");
check("CLI skip prints a ::notice and a NOT RUN summary line", /^::notice title=TEST migrations not run::/m.test(skipped.stdout) && /NOT RUN/.test(skipped.summary));
const ran = run(base);
check("CLI run writes run=true and no notice", ran.status === 0 && ran.output === "run=true\n" && !/::notice/.test(ran.stdout) && ran.summary === "");

// ------------------------------------------------------------- the workflow ---
const wf = readWorkflow("supabase-migrations.yml");
const testJob = jobBlock(wf, "test");
const list = steps(testJob);
const gate = list.findIndex((s) => s.includes("id: gate"));
check("the TEST job has the gate step", gate >= 0 && list[gate].includes("node scripts/ci/migration-test-gate.mjs"));
check("the gate lists files through the read-only API, never from PR text", list[gate].includes('gh api --paginate "repos/$REPOSITORY/pulls/$PR/files"') && list[gate].includes("GH_TOKEN: ${{ github.token }}") && !list[gate].includes("secrets."));
check("the gate fails closed when the file list cannot be read", list[gate].includes("set -euo pipefail"));
check("the job asks only for pull-requests: read for that call", /\n {6}pull-requests: read\n/.test(testJob.slice(0, testJob.indexOf("\n    steps:\n"))) && !/:\s*write\b/.test(testJob));
const after = list.slice(gate + 1);
check("every step after the gate is conditional on run == 'true'", after.length >= 5 && after.every((s) => stepIf(s) === "steps.gate.outputs.run == 'true'"));
const code = (s) => s.replace(/^\s*#.*$/gm, "");
check("the gate runs before any credential is chosen", list.slice(0, gate).every((s) => !code(s).includes("secrets.")));
check("the gate runs after checkout (it needs the script) and setup-node", list.slice(0, gate).some((s) => s.includes("actions/checkout@")) && list.slice(0, gate).some((s) => s.includes("actions/setup-node@")));
check("CI runs this guard", jobBlock(readWorkflow("ci.yml"), "verify").includes("node scripts/test/migration-test-gate.test.mjs"));

console.log(`migration-test-gate.test: ${passed} checks passed`);
