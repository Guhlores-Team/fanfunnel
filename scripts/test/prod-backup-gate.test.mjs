// SC-01 / OPS-03 guard: the production migration job refuses `db push`
// without a recent LIVE backup, and the refusal cannot be bypassed by accident.
//
//   node scripts/test/prod-backup-gate.test.mjs
//
// Pure: a fake fetch stands in for the Management API; no secret, no network.

import assert from "node:assert/strict";
import { ACCEPT_NO_BACKUP, MAX_AGE_HOURS, evaluateBackups, main } from "../ci/require-prod-backup.mjs";
import { jobBlock, readWorkflow, stepIf, steps } from "./workflow-text.mjs";

let passed = 0;
const check = (label, ok) => {
  assert.ok(ok, label);
  passed++;
};
const NOW = Date.parse("2026-11-10T12:00:00Z");
const h = (n) => new Date(NOW - n * 3_600_000).toISOString();
const body = (backups, extra = {}) => ({ region: "eu-west-1", walg_enabled: false, pitr_enabled: false, backups, physical_backup_data: {}, ...extra });

// ------------------------------------------------------------- evaluation ---
check("a completed backup from 3 h ago passes", evaluateBackups(body([{ id: 1, is_physical_backup: false, status: "COMPLETED", inserted_at: h(3) }]), NOW).ok);
check(`a completed backup ${MAX_AGE_HOURS - 1} h ago passes`, evaluateBackups(body([{ status: "COMPLETED", inserted_at: h(MAX_AGE_HOURS - 1) }]), NOW).ok);
check(`a completed backup ${MAX_AGE_HOURS + 1} h ago fails`, !evaluateBackups(body([{ status: "COMPLETED", inserted_at: h(MAX_AGE_HOURS + 1) }]), NOW).ok);
check("the newest completed backup counts, whatever the order", evaluateBackups(body([{ status: "COMPLETED", inserted_at: h(100) }, { status: "COMPLETED", inserted_at: h(2) }]), NOW).ok);
check("a pending backup does not count", !evaluateBackups(body([{ status: "PENDING", inserted_at: h(1) }]), NOW).ok);
check("a failed backup does not count", !evaluateBackups(body([{ status: "FAILED", inserted_at: h(1) }]), NOW).ok);
check("status is compared case-insensitively", evaluateBackups(body([{ status: "completed", inserted_at: h(1) }]), NOW).ok);
check("an empty list fails and says so", !evaluateBackups(body([]), NOW).ok && /no backups at all/.test(evaluateBackups(body([]), NOW).line));
check("PITR with a recent physical backup passes", evaluateBackups(body([], { pitr_enabled: true, physical_backup_data: { latest_physical_backup_date_unix: Math.floor((NOW - 3_600_000) / 1000) } }), NOW).ok);
check("PITR with an old physical backup fails", !evaluateBackups(body([], { pitr_enabled: true, physical_backup_data: { latest_physical_backup_date_unix: Math.floor((NOW - 50 * 3_600_000) / 1000) } }), NOW).ok);
check("pitr_enabled false ignores physical data", !evaluateBackups(body([], { pitr_enabled: false, physical_backup_data: { latest_physical_backup_date_unix: Math.floor(NOW / 1000) } }), NOW).ok);
check("a backup dated far in the future fails (clock or data error)", !evaluateBackups(body([{ status: "COMPLETED", inserted_at: h(-100) }]), NOW).ok);
for (const [label, v] of [["null", null], ["array", []], ["string", "ok"], ["unparseable dates", body([{ status: "COMPLETED", inserted_at: "lorem" }])], ["no backups key", { pitr_enabled: false }]]) {
  check(`fails closed on ${label}`, !evaluateBackups(v, NOW).ok);
}

// ------------------------------------------------------------------- main ---
const TOKEN = "sbp_" + "a".repeat(40);
const REF = "ttlogfmogcccwiraaoae";
const fakeFetch = (status, json, capture = {}) => async (url, init) => {
  capture.url = url;
  capture.init = init;
  return { ok: status >= 200 && status < 300, status, json: async () => json };
};
const logs = [];
const origLog = console.log;
console.log = (...a) => logs.push(a.join(" "));
const cap = {};
const okCode = await main({ SUPABASE_ACCESS_TOKEN: TOKEN, PROD_PROJECT_REF: REF }, fakeFetch(200, body([{ status: "COMPLETED", inserted_at: new Date(Date.now() - 3_600_000).toISOString() }]), cap));
check("main exits 0 on a recent backup", okCode === 0);
check("main GETs the LIVE project's backup list with a bearer token and no redirects", cap.url === `https://api.supabase.com/v1/projects/${REF}/database/backups` && cap.init.method === "GET" && cap.init.headers.Authorization === `Bearer ${TOKEN}` && cap.init.redirect === "error");
check("main exits 1 with an ::error on an empty list", (await main({ SUPABASE_ACCESS_TOKEN: TOKEN, PROD_PROJECT_REF: REF }, fakeFetch(200, body([])))) === 1 && logs.some((l) => l.startsWith("::error title=PRODUCTION backup not verified::")));
check("main exits 1 on an API error", (await main({ SUPABASE_ACCESS_TOKEN: TOKEN, PROD_PROJECT_REF: REF }, fakeFetch(403, {}))) === 1);
check("main exits 1 when fetch throws", (await main({ SUPABASE_ACCESS_TOKEN: TOKEN, PROD_PROJECT_REF: REF }, async () => { throw new Error("boom"); })) === 1);
check("main exits 1 on a missing token", (await main({ SUPABASE_ACCESS_TOKEN: "", PROD_PROJECT_REF: REF }, fakeFetch(200, body([])))) === 1);
check("main exits 1 on a bad ref", (await main({ SUPABASE_ACCESS_TOKEN: TOKEN, PROD_PROJECT_REF: "nope" }, fakeFetch(200, body([])))) === 1);
logs.length = 0;
check("the explicit policy variable turns the refusal into a ::warning", (await main({ SUPABASE_ACCESS_TOKEN: TOKEN, PROD_PROJECT_REF: REF, PROD_BACKUP_POLICY: ACCEPT_NO_BACKUP }, fakeFetch(200, body([])))) === 0 && logs.some((l) => l.startsWith("::warning title=PRODUCTION migrations without a verified backup::")));
check("any other policy value still refuses", (await main({ SUPABASE_ACCESS_TOKEN: TOKEN, PROD_PROJECT_REF: REF, PROD_BACKUP_POLICY: "yes" }, fakeFetch(200, body([])))) === 1);
check("the token never reaches a log line", logs.every((l) => !l.includes(TOKEN)));
console.log = origLog;

// ------------------------------------------------------------- the workflow ---
const wf = readWorkflow("supabase-migrations.yml");
const prod = jobBlock(wf, "production");
const list = steps(prod);
const gate = list.findIndex((s) => s.includes("node scripts/ci/require-prod-backup.mjs"));
const push = list.findIndex((s) => s.includes("supabase db push"));
check("the production job checks the LIVE backup before it pushes", gate >= 0 && push > gate);
check("the backup check is unconditional and fails closed", stepIf(list[gate]) === "" && list[gate].includes("set -euo pipefail") && !/continue-on-error/.test(prod));
check("the override is a repository variable, never a secret or an input", list[gate].includes("PROD_BACKUP_POLICY: ${{ vars.PROD_BACKUP_POLICY }}") && !/PROD_BACKUP_POLICY: \$\{\{ (secrets|inputs)\./.test(wf));
check("the check uses the same token and ref as the push, through env only", list[gate].includes("SUPABASE_ACCESS_TOKEN: ${{ secrets.SUPABASE_ACCESS_TOKEN }}") && list[gate].includes("PROD_PROJECT_REF: ${{ secrets.SUPABASE_PROD_PROJECT_REF }}") && !/\$\{\{\s*secrets\./.test(list[gate].slice(list[gate].indexOf("run:"))));
const goLive = (await import("node:fs")).readFileSync(new URL("../../docs/GO_LIVE.md", import.meta.url), "utf8");
const section5 = goLive.slice(goLive.indexOf("## 5."), goLive.indexOf("## 6."));
check("GO_LIVE section 5 documents the backup gate and its override", section5.includes("PROD_BACKUP_POLICY") && section5.includes(ACCEPT_NO_BACKUP));
check("CI runs this guard", jobBlock(readWorkflow("ci.yml"), "verify").includes("node scripts/test/prod-backup-gate.test.mjs"));

console.log(`prod-backup-gate.test: ${passed} checks passed`);
