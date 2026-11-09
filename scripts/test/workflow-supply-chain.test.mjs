// Batch-6 supply-chain guard (SUP-1, SUP-4, SUP-5, SUP-6, SUP-7, SUP-8, SUP-10).
//
//   node scripts/test/workflow-supply-chain.test.mjs
//
// Pins: every action by full commit SHA, a least-privilege token everywhere,
// no persisted checkout credentials, no secret interpolated into shell text,
// the account token kept out of the PR migration job's setup actions, PROD
// secrets only in the main-only production job, the TEST database URL guard,
// and the Vercel install/deploy settings in vercel.json. Each checker also runs
// against mutated copies to prove it is not vacuous. Pure: no network, no secrets.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { testDbUrlProblem, TEST_REF, PROD_REF } from "../ci/supabase-test-db-url.mjs";
import { jobBlock, readWorkflow, steps } from "./workflow-text.mjs";

let passed = 0;
const check = (label, ok) => {
  assert.ok(ok, label);
  passed++;
};

const PINS = {
  "actions/checkout": ["3d3c42e5aac5ba805825da76410c181273ba90b1", "v7.0.1"],
  "actions/setup-node": ["949feb2413d6458794dcd2491c4babbbce0c15c1", "v7.1.0"],
  "actions/upload-artifact": ["cf430e030ddbb5b0abf93d22962f4752f3646cd9", "v7.0.2"],
  "supabase/setup-cli": ["689adcfb80d947100a1eab127289b97d1fb07b13", "v3.2.0"],
};
const names = readdirSync(new URL("../../.github/workflows/", import.meta.url)).filter((f) => f.endsWith(".yml")).sort();
const workflows = Object.fromEntries(names.map((n) => [n, readWorkflow(n)]));
check("found the four workflows", ["ci.yml", "e2e-supabase-ui.yml", "e2e-supabase.yml", "supabase-migrations.yml"].every((n) => n in workflows));

/** Lines that are shell (bodies and inline values of `run:` keys). @param {string} text */
export function runText(text) {
  const out = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(?:- )?run:\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const indent = m[1].length;
    if (m[2] && !/^[|>][-+]?$/.test(m[2])) { out.push(m[2]); continue; }
    for (i++; i < lines.length && (lines[i].trim() === "" || lines[i].search(/\S/) > indent); i++) out.push(lines[i]);
    i--;
  }
  return out.join("\n");
}

/** @param {string} text */
export function auditWorkflow(text) {
  const problems = [];
  for (const m of text.matchAll(/^\s*(?:- )?uses: (\S+?)@(\S+)(.*)$/gm)) {
    const [, action, ref, rest] = m;
    if (!/^[0-9a-f]{40}$/.test(ref)) problems.push(`${action} is not pinned to a commit SHA`);
    else if (!/^ # v\d/.test(rest)) problems.push(`${action} pin has no version comment`);
    const pin = PINS[action];
    if (!pin) problems.push(`${action} is not a reviewed action`);
    else if (ref !== pin[0] || rest.trim() !== `# ${pin[1]}`) problems.push(`${action} pin differs from the reviewed SHA`);
  }
  if (!/\npermissions:\n {2}contents: read\n/.test(text)) problems.push("no top-level least-privilege permissions");
  if (/:\s*write\b/.test(text.replace(/^\s*#.*$/gm, ""))) problems.push("a job asks for write permission");
  for (const m of text.matchAll(/^( *)- uses: actions\/checkout@.*\n((?:\1  .*\n)*)/gm)) {
    if (!/^ *persist-credentials: false$/m.test(m[2])) problems.push("a checkout persists its credentials");
  }
  if (/\$\{\{\s*secrets\./.test(runText(text))) problems.push("a secret is interpolated into shell text");
  return problems;
}

for (const [name, text] of Object.entries(workflows)) {
  assert.deepEqual(auditWorkflow(text), [], name);
  passed++;
}
const ci = workflows["ci.yml"];
const mutations = [
  ["tag pin", ci.replace(/actions\/checkout@[0-9a-f]{40} # v7\.0\.1/, "actions/checkout@v7")],
  ["other SHA", ci.replace(/actions\/setup-node@[0-9a-f]{40}/, "actions/setup-node@" + "a".repeat(40))],
  ["unknown action", ci.replace("      - name: Lint\n", "      - uses: evil/action@" + "b".repeat(40) + " # v1\n      - name: Lint\n")],
  ["no permissions", ci.replace("\npermissions:\n  contents: read\n", "\n")],
  ["write permission", ci.replace("\npermissions:\n  contents: read\n", "\npermissions:\n  contents: write\n")],
  ["persisted checkout", ci.replace("          persist-credentials: false\n", "")],
  ["secret in run block", ci.replace("        run: npm run lint\n", '        run: |\n          echo "${{ secrets.SUPABASE_PROD_DB_PASSWORD }}" | base64\n')],
  ["secret inline run", ci.replace("        run: npm run lint\n", "        run: echo ${{ secrets.X }}\n")],
];
for (const [label, mutated] of mutations) check(`checker rejects mutation: ${label}`, mutated !== ci && auditWorkflow(mutated).length > 0);
check("runText keeps env values out of shell text", !runText("      - env:\n          A: ${{ secrets.A }}\n        run: |\n          echo \"$A\"\n").includes("secrets"));

// --------------------------------------------------- SUP-1 / SUP-6 migrations ---
const mig = workflows["supabase-migrations.yml"];
const testJob = jobBlock(mig, "test");
const prodJob = jobBlock(mig, "production");
const header = (job) => job.slice(0, job.indexOf("\n    steps:\n"));
check("PR job runs only on pull_request", testJob.includes("    if: github.event_name == 'pull_request'\n"));
check("PROD job runs only on a push to main", prodJob.includes("    if: github.event_name == 'push' && github.ref == 'refs/heads/main'\n") && prodJob.includes("    environment: production\n"));
check("PR job has no job-level env (no credential reaches the setup actions)", !/\n {4}env:\n/.test(header(testJob)));
check("PROD job has no job-level env either", !/\n {4}env:\n/.test(header(prodJob)));
const testSteps = steps(testJob);
for (const s of testSteps.filter((s) => /uses: /.test(s))) check(`PR setup action gets no secret: ${s.split("\n")[0].trim()}`, !s.includes("secrets."));
const tokenSteps = testSteps.filter((s) => s.includes("SUPABASE_ACCESS_TOKEN:"));
check("PR job hands the account token only to CLI steps, and only on the legacy path", tokenSteps.length > 0 && tokenSteps.every((s) =>
  s.includes("SUPABASE_ACCESS_TOKEN: ${{ steps.target.outputs.mode == 'token' && secrets.SUPABASE_ACCESS_TOKEN || '' }}") && s.includes("[ -n \"$SUPABASE_ACCESS_TOKEN\" ] || unset SUPABASE_ACCESS_TOKEN")));
check("PR job never names the account token any other way", (testJob.match(/secrets\.SUPABASE_ACCESS_TOKEN/g) ?? []).length === tokenSteps.length);
const choose = testSteps.find((s) => s.includes("id: target")) ?? "";
check("credential choice validates the TEST DB URL before using it", choose.includes("node scripts/ci/supabase-test-db-url.mjs") && choose.includes('echo "mode=db-url"') && choose.includes("set -euo pipefail"));
check("DB-URL path: push, read-back and types all use --db-url", ["supabase db push --db-url \"$TEST_DB_URL\"", "supabase migration list --db-url \"$TEST_DB_URL\"", "supabase gen types typescript --db-url \"$TEST_DB_URL\""].every((c) => testJob.includes(c)));
check("PR job serializes TEST runs across PRs without cancelling one in flight", /\n {4}concurrency:\n {6}group: supabase-migrate-test\n {6}cancel-in-progress: false\n/.test(header(testJob)));
check("workflow-level group never cancels an in-flight PROD run", /\nconcurrency:\n {2}group: supabase-migrate-\$\{\{ github\.ref \}\}\n {2}cancel-in-progress: false\n/.test(mig));
for (const secret of ["SUPABASE_PROD_DB_PASSWORD", "SUPABASE_PROD_PROJECT_REF"]) {
  const holders = Object.entries(workflows).filter(([, t]) => t.includes(`secrets.${secret}`));
  check(`${secret} is used only by supabase-migrations.yml`, holders.length === 1 && holders[0][0] === "supabase-migrations.yml");
  check(`${secret} appears only in the production job`, !testJob.includes(secret) && mig.split(`secrets.${secret}`).length - 1 === prodJob.split(`secrets.${secret}`).length - 1);
}
check("PROD read-back still lists the linked project", prodJob.includes('supabase migration list --linked --password "$PROD_DB_PASSWORD"'));

// ------------------------------------------------------------- SUP-5 Vercel ---
for (const [name, text] of Object.entries(workflows)) {
  const holders = text.split(/\n(?= {6}- )/).filter((s) => s.includes("VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}"));
  for (const s of holders) {
    check(`${name}: VERCEL_TOKEN only in a step that installs and runs no dependency`, !/npm (ci|install)|npx |playwright/.test(s)
      && /run: node (e2e\/preview-(lcp|feature-smoke)\.mjs --preflight|scripts\/ops\/test-maintenance\.mjs)\n/.test(s + "\n"));
  }
  check(`${name}: VERCEL_TOKEN is never job-level`, !/\n {4}env:\n(?: {6}.*\n)*? {6}VERCEL_TOKEN:/.test(text));
}

// ------------------------------------------------- TEST database URL guard ---
const pooled = `postgresql://postgres.${TEST_REF}:p%40ss@aws-0-eu-west-1.pooler.supabase.com:5432/postgres`;
const direct = `postgresql://postgres:secret@db.${TEST_REF}.supabase.co:5432/postgres`;
check("TEST session pooler URL is accepted", testDbUrlProblem(pooled) === null);
check("TEST direct URL is accepted", testDbUrlProblem(direct) === null && testDbUrlProblem(direct.replace("postgresql:", "postgres:")) === null);
const refused = [
  [undefined, "TEST_DB_URL_MISSING"], ["", "TEST_DB_URL_MISSING"], ["not a url", "TEST_DB_URL_UNPARSEABLE"],
  [pooled.replaceAll(TEST_REF, PROD_REF), "PRODUCTION_REF_REFUSED"], [direct.replaceAll(TEST_REF, PROD_REF), "PRODUCTION_REF_REFUSED"],
  [pooled.replace(`postgres.${TEST_REF}`, "postgres.abcdefghijklmnopqrst"), "TEST_DB_URL_NOT_TEST_PROJECT"],
  [pooled.replace("pooler.supabase.com", "pooler.supabase.com.evil.test"), "TEST_DB_URL_NOT_TEST_PROJECT"],
  [direct.replace(`db.${TEST_REF}.supabase.co`, `db.${TEST_REF}.supabase.co.evil.test`), "TEST_DB_URL_NOT_TEST_PROJECT"],
  [direct.replace("postgres:secret", `postgres.${TEST_REF}:secret`), "TEST_DB_URL_NOT_TEST_PROJECT"],
  [pooled.replace(":5432", ":6543"), "TEST_DB_URL_NOT_SESSION_PORT"], [pooled.replace(":5432", ""), "TEST_DB_URL_NOT_SESSION_PORT"],
  [pooled.replace(/\/postgres$/, "/other"), "TEST_DB_URL_WRONG_DATABASE"], [pooled.replace(":p%40ss", ""), "TEST_DB_URL_NO_PASSWORD"],
  [pooled.replace("postgresql:", "https:"), "TEST_DB_URL_NOT_POSTGRES"],
];
for (const [value, code] of refused) check(`TEST DB URL refused: ${code}`, testDbUrlProblem(value) === code);

// ---------------------------------------------------- SUP-8 / SUP-10 Vercel ---
const vercel = JSON.parse(readFileSync(new URL("../../vercel.json", import.meta.url), "utf8"));
const enabled = vercel.git?.deploymentEnabled ?? {};
check("Dependabot branches never build a Vercel Preview", enabled["dependabot/**"] === false);
check("no rule re-enables a Dependabot branch (a true rule would win)", !Object.entries(enabled).some(([glob, on]) => on === true && /^(\*|\*\*|dependabot)/.test(glob)));
check("main still deploys", enabled.main !== false && enabled["*"] !== false && enabled["**"] !== false);
check("Vercel installs exactly the lockfile, like CI", vercel.installCommand === "npm ci");

const ciVerify = jobBlock(ci, "verify");
check("CI runs this guard", ciVerify.includes("node scripts/test/workflow-supply-chain.test.mjs"));

console.log(`workflow-supply-chain.test: ${passed} checks passed`);
