// A25 workflow guard: real-Supabase, RLS-runtime and login-UI jobs FAIL when the
// TEST secrets are missing, except on a fork PR, which skips visibly.
//
//   node scripts/test/ci-secrets-gate.test.mjs
//
// Pins three things: the gate's decision table, the gate CLI's exit codes /
// outputs / annotations, and the workflow wiring (gate first, every security
// step gated on it, no secrets-unset branch that exits 0). The wiring checker is
// also run against mutated copies of the workflows to prove it is not vacuous.
// Pure: no network, no secrets, no hosted project.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decide, SECRET_NAMES } from "../ci/supabase-secrets-gate.mjs";
import { jobBlock, readWorkflow, stepIf, steps } from "./workflow-text.mjs";

let passed = 0;
const check = (label, ok) => {
  assert.ok(ok, label);
  passed++;
};

const REPO = "Guhlores-Team/fanfunnel";
const all = Object.fromEntries(SECRET_NAMES.map((n) => [n, true]));
const none = Object.fromEntries(SECRET_NAMES.map((n) => [n, false]));

// ---------------------------------------------------------------- decision ---
const d = (ctx) => decide({ repository: REPO, ...ctx });
check("push to main without secrets fails", d({ eventName: "push", ref: "refs/heads/main", present: none }).action === "fail");
check("push to main names the protected target", /protected branch/.test(d({ eventName: "push", ref: "refs/heads/main", present: none }).reason));
check("same-repo PR into dashboard-redesign without secrets fails", d({ eventName: "pull_request", baseRef: "dashboard-redesign", headRepo: REPO, present: none }).action === "fail");
check("same-repo PR into main without secrets fails", d({ eventName: "pull_request", baseRef: "main", headRepo: REPO, present: none }).action === "fail");
check("same-repo PR into another branch without secrets also fails", d({ eventName: "pull_request", baseRef: "gaps/b3-ops", headRepo: REPO, present: none }).action === "fail");
check("manual dispatch on dashboard-redesign without secrets fails", d({ eventName: "workflow_dispatch", ref: "refs/heads/dashboard-redesign", present: none }).action === "fail");
const partial = d({ eventName: "pull_request", baseRef: "main", headRepo: REPO, present: { ...all, SUPABASE_SERVICE_ROLE_KEY: false } });
check("one missing secret fails and is named", partial.action === "fail" && partial.missing.join() === "SUPABASE_SERVICE_ROLE_KEY");
const dependabot = d({ eventName: "pull_request", baseRef: "main", headRepo: REPO, actor: "dependabot[bot]", present: none });
check("Dependabot PR without secrets fails with the Dependabot-secrets hint", dependabot.action === "fail" && /Dependabot secrets/.test(dependabot.reason));
check("fork PR without secrets skips", d({ eventName: "pull_request", baseRef: "main", headRepo: "someone/fanfunnel", present: none }).action === "skip");
check("fork PR into dashboard-redesign without secrets skips", d({ eventName: "pull_request", baseRef: "dashboard-redesign", headRepo: "someone/fanfunnel", present: none }).action === "skip");
check("fork PR with only some secrets fails (misconfiguration)", d({ eventName: "pull_request", baseRef: "main", headRepo: "someone/fanfunnel", present: { ...none, NEXT_PUBLIC_SUPABASE_URL: true } }).action === "fail");
check("PR with unknown head repository fails closed", d({ eventName: "pull_request", baseRef: "main", headRepo: "", present: none }).action === "fail");
check("head repository differing only in case is not a fork", d({ eventName: "pull_request", baseRef: "main", headRepo: REPO.toLowerCase(), present: none }).action === "fail");
check("push is never a fork skip even with a foreign-looking head", d({ eventName: "push", ref: "refs/heads/main", headRepo: "someone/fanfunnel", present: none }).action === "fail");
check("unknown repository fails closed", decide({ eventName: "pull_request", baseRef: "main", headRepo: "someone/fanfunnel", repository: "", present: none }).action === "fail");
for (const ctx of [{ eventName: "push", ref: "refs/heads/main" }, { eventName: "pull_request", baseRef: "main", headRepo: "someone/fanfunnel" }]) {
  check(`all secrets present runs (${ctx.eventName})`, d({ ...ctx, present: all }).action === "run");
}

// --------------------------------------------------------------------- CLI ---
const GATE = new URL("../ci/supabase-secrets-gate.mjs", import.meta.url).pathname;
const work = mkdtempSync(join(tmpdir(), "ff-gate-"));
function runCli(extra) {
  const out = join(work, `out-${passed}`);
  const summary = join(work, `summary-${passed}`);
  writeFileSync(out, "");
  writeFileSync(summary, "");
  const env = { PATH: process.env.PATH, REPOSITORY: REPO, GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: summary, GATE_JOB: "Gate test", ...extra };
  const r = spawnSync(process.execPath, [GATE], { env, encoding: "utf8", timeout: 10_000 });
  return { status: r.status, stdout: r.stdout, output: readFileSync(out, "utf8"), summary: readFileSync(summary, "utf8") };
}
try {
  const has = { HAS_SUPABASE_URL: "true", HAS_SUPABASE_ANON_KEY: "true", HAS_SUPABASE_SERVICE_ROLE_KEY: "true" };
  const fail = runCli({ EVENT_NAME: "push", REF: "refs/heads/main" });
  check("CLI: missing secrets on main exit 1", fail.status === 1);
  check("CLI: failure is an ::error annotation naming every missing secret", /^::error title=/m.test(fail.stdout) && SECRET_NAMES.every((n) => fail.stdout.includes(n)));
  check("CLI: failure sets run=false", fail.output.includes("run=false\n") && fail.output.includes("action=fail\n"));
  const skip = runCli({ EVENT_NAME: "pull_request", BASE_REF: "main", HEAD_REPO: "someone/fanfunnel" });
  check("CLI: fork PR exits 0", skip.status === 0);
  check("CLI: fork skip is a visible ::warning annotation", /^::warning title=Gate test NOT run \(fork PR\)::/m.test(skip.stdout));
  check("CLI: fork skip sets run=false so gated steps show as skipped", skip.output.includes("run=false\n") && skip.output.includes("action=skip\n"));
  check("CLI: fork skip is written to the job summary as NOT RUN", /\*\*Gate test: NOT RUN\*\*/.test(skip.summary));
  const run = runCli({ EVENT_NAME: "pull_request", BASE_REF: "main", HEAD_REPO: REPO, ...has });
  check("CLI: secrets present exits 0 with run=true", run.status === 0 && run.output.includes("run=true\n"));
  const notTrue = runCli({ EVENT_NAME: "push", REF: "refs/heads/main", HAS_SUPABASE_URL: "1", HAS_SUPABASE_ANON_KEY: "yes", HAS_SUPABASE_SERVICE_ROLE_KEY: "true" });
  check("CLI: only the literal 'true' counts as present", notTrue.status === 1);
  const dependabotCli = runCli({ EVENT_NAME: "pull_request", BASE_REF: "main", HEAD_REPO: REPO, ACTOR: "dependabot[bot]" });
  check("CLI: Dependabot PR without secrets exits 1", dependabotCli.status === 1);
} finally {
  rmSync(work, { recursive: true, force: true });
}

// ---------------------------------------------------------------- workflows ---
const SECURITY_COMMANDS = [/npm run e2e:supabase\b/, /npm run e2e:spin\b/, /scripts\/security\/rls-runtime-test\.mjs/, /npm run e2e:login\b/];
const GATE_IF = "steps.supabase-secrets.outputs.run == 'true'";
const SECRETS_UNSET = /if \[ (?:-z "\$(?:NEXT_PUBLIC_SUPABASE_URL|NEXT_PUBLIC_SUPABASE_ANON_KEY|SUPABASE_SERVICE_ROLE_KEY)"|"\$HAS_SECRETS" != "true")/;

/** @param {string} job @param {string[]} mustRun commands this job must run */
export function auditJob(job, mustRun) {
  const problems = [];
  const list = steps(job);
  const gateIndex = list.findIndex((s) => /\n\s+id: supabase-secrets\n/.test(s + "\n") || /^\s+id: supabase-secrets$/m.test(s));
  if (gateIndex < 0) return ["no supabase-secrets gate step"];
  const gate = list[gateIndex];
  if (!gate.includes("run: node scripts/ci/supabase-secrets-gate.mjs")) problems.push("gate step does not run the gate script");
  if (stepIf(gate)) problems.push("gate step is conditional");
  for (const name of ["HAS_SUPABASE_URL", "HAS_SUPABASE_ANON_KEY", "HAS_SUPABASE_SERVICE_ROLE_KEY"]) {
    if (!new RegExp(`${name}: \\$\\{\\{ secrets\\.[A-Z_]+ != '' \\}\\}`).test(gate)) problems.push(`gate step lacks presence boolean ${name}`);
  }
  if (/\$\{\{ secrets\.[A-Z_]+ \}\}/.test(gate)) problems.push("gate step receives a secret value");
  if (!/HEAD_REPO: \$\{\{ github\.event\.pull_request\.head\.repo\.full_name \}\}/.test(gate)) problems.push("gate step cannot see the PR head repository");
  for (const cmd of mustRun) {
    const idx = list.findIndex((s) => cmd.test(s));
    if (idx < 0) problems.push(`security command ${cmd} missing`);
    else if (idx < gateIndex) problems.push(`security command ${cmd} runs before the gate`);
  }
  list.forEach((s, idx) => {
    const name = (/- name: (.+)/.exec(s) ?? [, `step ${idx}`])[1];
    if (SECURITY_COMMANDS.some((c) => c.test(s)) && !stepIf(s).includes(GATE_IF)) problems.push(`"${name}" is not gated on the secrets check`);
    if (/skips? if secrets unset/i.test(s)) problems.push(`"${name}" still advertises a secrets-unset skip`);
    let at = s.search(SECRETS_UNSET);
    while (at >= 0) {
      const body = s.slice(at, s.indexOf("\n          fi", at) >>> 0 || undefined);
      if (/\bexit 0\b/.test(body) || !/\bexit 1\b/.test(body)) problems.push(`"${name}" passes when secrets are unset`);
      const nextAt = s.slice(at + 1).search(SECRETS_UNSET);
      at = nextAt < 0 ? -1 : at + 1 + nextAt;
    }
  });
  return problems;
}

const supabaseWf = readWorkflow("e2e-supabase.yml");
const loginWf = readWorkflow("e2e-supabase-ui.yml");
const supabaseJob = jobBlock(supabaseWf, "supabase");
const loginJob = jobBlock(loginWf, "login-ui");
const SUPA_CMDS = SECURITY_COMMANDS.slice(0, 3);
const LOGIN_CMDS = [SECURITY_COMMANDS[3]];
assert.deepEqual(auditJob(supabaseJob, SUPA_CMDS), []);
passed++;
assert.deepEqual(auditJob(loginJob, LOGIN_CMDS), []);
passed++;
check("login build is gated too (no mock-mode build passes for the real job)", stepIf(steps(loginJob).find((s) => s.includes("run: npm run build")) ?? "").includes(GATE_IF));

// The checker must catch each way back to a false green.
const mutate = (job, from, to) => {
  assert.ok(job.includes(from), `mutation anchor missing: ${from.slice(0, 60)}`);
  return job.replace(from, to);
};
const rlsIf = "      - name: RLS runtime test — tenant isolation + no self-promotion (TEST project)\n        if: steps.supabase-secrets.outputs.run == 'true'\n";
const mutations = [
  ["RLS step ungated", mutate(supabaseJob, rlsIf, "      - name: RLS runtime test — tenant isolation + no self-promotion (TEST project)\n")],
  ["RLS secrets-unset branch back to exit 0", supabaseJob.replace(/(if \[ -z "\$NEXT_PUBLIC_SUPABASE_URL"[\s\S]*?)exit 1/, "$1exit 0")],
  ["wait step secrets-unset branch back to exit 0", supabaseJob.replace(/(if \[ "\$HAS_SECRETS" != "true" \][\s\S]*?)exit 1/, "$1exit 0")],
  ["gate removed", supabaseJob.replace("id: supabase-secrets", "id: something-else")],
  ["gate receives a value", supabaseJob.replace("HAS_SUPABASE_URL: ${{ secrets.NEXT_PUBLIC_SUPABASE_URL != '' }}", "HAS_SUPABASE_URL: ${{ secrets.NEXT_PUBLIC_SUPABASE_URL }}")],
  ["spin step ungated", mutate(supabaseJob, "      - name: Real-Supabase spin-integrity (double-spend) test\n        if: steps.supabase-secrets.outputs.run == 'true'\n", "      - name: Real-Supabase spin-integrity (double-spend) test\n")],
];
for (const [label, mutated] of mutations) {
  check(`checker rejects mutation: ${label}`, mutated !== supabaseJob && auditJob(mutated, SUPA_CMDS).length > 0);
}
check("checker rejects mutation: login step ungated", auditJob(loginJob.replace("      - name: Login-UI E2E\n        if: steps.supabase-secrets.outputs.run == 'true'\n", "      - name: Login-UI E2E (skips if secrets unset)\n"), LOGIN_CMDS).length >= 2);

// Existing pins elsewhere stay satisfied; the guard itself runs in CI.
check("existing integration commands remain", supabaseWf.includes("run: npm run e2e:supabase") && supabaseWf.includes("run: npm run e2e:spin") && loginWf.includes("run: npm run build"));
check("RLS runtime step stays pinned to the TEST ref and refuses prod", supabaseJob.includes("RLS_TEST_REQUIRE_REF: snmcrmhgevfqggxdiomu") && supabaseJob.includes("*ttlogfmogcccwiraaoae*)"));
const ci = readWorkflow("ci.yml");
check("CI runs this guard on every push and PR", jobBlock(ci, "verify").includes("node scripts/test/ci-secrets-gate.test.mjs"));
// Disposable-Postgres script tests run in the job that has local Postgres 16
// (no hosted DB, no secrets), unconditionally.
const drift = jobBlock(ci, "schema-drift");
for (const cmd of ["node scripts/db/schema-drift-check.mjs", "node scripts/golive/carry-over.db.test.mjs", "node scripts/ops/test-maintenance-db.test.mjs"]) {
  const step = steps(drift).find((s) => s.includes(cmd));
  check(`schema-drift job runs ${cmd} unconditionally`, Boolean(step) && !stepIf(step) && !/continue-on-error/.test(step));
}
check("the maintenance contract test gets an explicit PG_BIN and fails on any error", /PG_BIN="\$\(ls -d \/usr\/lib\/postgresql\/\*\/bin \| sort -V \| tail -1\)"/.test(drift) && /set -euo pipefail[\s\S]*node scripts\/ops\/test-maintenance-db\.test\.mjs/.test(drift));
check("schema-drift job keeps a runner with preinstalled Postgres and no secrets", drift.includes("runs-on: ubuntu-24.04") && !/\$\{\{ secrets\./.test(drift));
check("the e2e-supabase job still runs the pure maintenance guard", supabaseWf.includes("run: node scripts/ops/test-maintenance.test.mjs"));
check("CI runs the pure maintenance guard on every push and PR (the dispatch-only job is not enough)", jobBlock(ci, "verify").includes("node scripts/ops/test-maintenance.test.mjs"));
check("the gate never reads secret values from its environment", !/process\.env\.(NEXT_PUBLIC_SUPABASE_URL|NEXT_PUBLIC_SUPABASE_ANON_KEY|SUPABASE_SERVICE_ROLE_KEY)\b/.test(readFileSync(GATE, "utf8")));

console.log(`ci-secrets-gate.test: ${passed} checks passed`);
