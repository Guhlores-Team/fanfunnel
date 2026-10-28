import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MANAGEMENT_URL, MANIFEST_SHA256, repairPreflight, REQUEST_TIMEOUT_MS, runCorrection, SOURCE_SHA256, TEST_REF } from "../../../scripts/db/repair-test-crypto-0059.mjs";

async function main() {
  const root = mkdtempSync(join(tmpdir(), "ffcrypto-guard-"));
  const migrations = join(root, "supabase/migrations"); mkdirSync(migrations, { recursive: true });
  const source = readFileSync("supabase/migrations/0059_focus_attempt_ledger.sql");
  writeFileSync(join(migrations, "0059_focus_attempt_ledger.sql"), source);
  const env = { NODE_ENV: "test" as const, GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "pull_request", GITHUB_REPOSITORY: "Guhlores-Team/fanfunnel",
    GITHUB_HEAD_REF: "dashboard-redesign", SUPABASE_TEST_PROJECT_REF: TEST_REF, SUPABASE_ACCESS_TOKEN: "synthetic-local-token-only" };
  let passed = 0;
  const check = (condition: unknown, label: string) => { assert.ok(condition, label); passed++; };
  const record = { namespace: "extensions", history: "0059", namespaceSafe: true, primitiveCount: 3, shadowCount: 0,
    definitions: 15, oldConfigs: 0, targetConfigs: 15 };
  const response = (changes = {}) => new Response(JSON.stringify([{ result: { ...record, ...changes } }]), { status: 201 });
  try {
    check(createHash("sha256").update(source).digest("hex") === SOURCE_SHA256, "exact reviewed source");
    repairPreflight(env, root); passed++;
    check(createHash("sha256").update(readFileSync("scripts/db/crypto-namespace-0059-manifest.json")).digest("hex") === MANIFEST_SHA256, "exact reviewed15function manifest pin");
    for (const changes of [
      { GITHUB_ACTIONS: "false" }, { GITHUB_EVENT_NAME: "push" }, { GITHUB_EVENT_NAME: "pull_request_target" },
      { GITHUB_REPOSITORY: "foreign/repo" }, { GITHUB_HEAD_REF: "main" }, { SUPABASE_TEST_PROJECT_REF: "ttlogfmogcccwiraaoae" },
      { SUPABASE_TEST_PROJECT_REF: "foreign" }, { SUPABASE_ACCESS_TOKEN: "" }, { SUPABASE_ACCESS_TOKEN: "secret with whitespace" },
    ]) {
      let calls = 0;
      await assert.rejects(runCorrection({ env: { ...env, ...changes }, root, fetchImpl: async () => { calls++; return response(); } }), /CRYPTO_REPAIR_REFUSED/);
      check(calls === 0, "invalid source/identity fails before any transport");
    }
    writeFileSync(join(migrations, "0060_fixture.sql"), "-- later integration");
    assert.throws(() => repairPreflight(env, root), /CRYPTO_REPAIR_REFUSED/); passed++;
    rmSync(join(migrations, "0060_fixture.sql"));
    writeFileSync(join(migrations, "0059_focus_attempt_ledger.sql"), Buffer.concat([source, Buffer.from("\n-- changed")]));
    assert.throws(() => repairPreflight(env, root), /CRYPTO_REPAIR_REFUSED/); passed++;
    writeFileSync(join(migrations, "0059_focus_attempt_ledger.sql"), source);
    const calls: { url: unknown; options: RequestInit }[] = [];
    const result = await runCorrection({ env, root, fetchImpl: async (url, options) => {
      calls.push({ url, options: options! });
      return calls.length === 1 ? new Response("[]", { status: 201 }) : response();
    } });
    check(result?.status === "verified" && result.configurationVerified && result.targetConfigFunctions === 15, "green requires actual independent target readback");
    check(calls.length === 2 && calls.every(call => call.url === MANAGEMENT_URL && call.options.method === "POST" && call.options.redirect === "error"), "fixed TEST destination, one mutation, one fresh read");
    const first = JSON.parse(String(calls[0].options.body)); const second = JSON.parse(String(calls[1].options.body));
    check(first.read_only === false && second.read_only === true, "provider read-only fence on readback");
    check(!second.query.includes("alter function ") && !second.query.includes("for update"), "readback has no DDL or catalog row locks");
    check(!first.query.includes(env.SUPABASE_ACCESS_TOKEN), "credential never enters SQL");
    check(first.query.includes("pg_catalog.sha256(pg_catalog.convert_to(f.prosrc,'UTF8'))") && !first.query.includes("digest(f.prosrc"), "definition hashes use core trusted primitives");
    check(!/\b(?:update|insert into|delete from|create function|create table)\b/i.test(first.query), "no function-body replacement, table data/history or catalog UPDATE");
    check(first.query.includes("pg_catalog.pg_advisory_xact_lock") && !first.query.includes("for update"), "coordinated transaction without catalog UPDATE privileges");
    check(first.query.includes("CRYPTO_REPAIR_SHADOW_REFUSED") && first.query.includes("p.proname in ('digest','gen_random_bytes')"), "all unexpected shadow/default/variadic overloads refused");
    check(first.query.indexOf("CRYPTO_REPAIR_DEFINITION_REFUSED") < first.query.indexOf("execute 'alter function '"), "all definition and ACL prechecks precede first ALTER");
    check(first.query.includes("to_jsonb(f)-'proconfig'") && first.query.includes("CRYPTO_REPAIR_METADATA_CHANGED"), "full body/ACL/owner/OID post-preservation");
    const observed = await runCorrection({ env, root, readOnly: true, fetchImpl: async () => response({ oldConfigs: 15, targetConfigs: 0 }) });
    check(observed?.configurationVerified === false && observed.oldConfigFunctions === 15, "readback reports old state honestly");
    for (const changes of [{ namespace: "foreign" }, { namespaceSafe: false }, { primitiveCount: 2 }, { shadowCount: 1 }, { history: "0060" }, { definitions: 14 }, { oldConfigs: -1 }, { oldConfigs: 1 }, { targetConfigs: 16 }]) {
      await assert.rejects(runCorrection({ env, root, readOnly: true, fetchImpl: async () => response(changes) }), /CRYPTO_REPAIR_READBACK_UNAVAILABLE/); passed++;
    }
    for (const fetchImpl of [async () => new Response("private-synthetic-error", { status: 500 }), async () => { throw new Error("private-synthetic-error"); }]) {
      let total = 0;
      await assert.rejects(runCorrection({ env, root, fetchImpl: async () => { total++; return fetchImpl(); } }), error => error instanceof Error && error.message === "CRYPTO_REPAIR_OUTCOME_UNKNOWN_USE_READBACK");
      check(total === 1, "ambiguous mutation has no automatic retry");
    }
    for (const invalid of [new Response("[]", { status: 200 }), new Response("{}", { status: 201 }), new Response('[{"error":"synthetic"}]', { status: 201 })]) {
      await assert.rejects(runCorrection({ env, root, fetchImpl: async () => invalid }), /CRYPTO_REPAIR_OUTCOME_UNKNOWN_USE_READBACK/); passed++;
    }
    let total = 0;
    await assert.rejects(runCorrection({ env, root, fetchImpl: async () => { total++; return total === 1 ? new Response("[]", { status: 201 }) : response({ oldConfigs: 15, targetConfigs: 0 }); } }), /CRYPTO_REPAIR_SUBMITTED_READBACK_UNVERIFIED/);
    check(total === 2, "successful HTTP without target readback is not green and is never retried");
    const workflow = readFileSync(".github/workflows/supabase-migrations.yml", "utf8");
    const block = `      # One-time0059 TEST prerelease correction: retire this invocation with0060.\n      # The helper only changes15 validated function search paths; no data/history.\n      - name: Correct verified0059 TEST crypto search paths\n        env:\n          SUPABASE_TEST_PROJECT_REF: \${{ secrets.SUPABASE_TEST_PROJECT_REF }}\n        run: node scripts/db/repair-test-crypto-0059.mjs\n`;
    // Preserve BOTH active0059 and explicitly retired0060 cases permanently.
    const retired = workflow.includes(block) ? workflow.replace(block, "") : workflow;
    const active = retired.replace("      - name: Confirm TEST migration history\n", block + "      - name: Confirm TEST migration history\n");
    check(active.split(block).length === 2 && !retired.includes("run: node scripts/db/repair-test-crypto-0059.mjs"), "active and retired invocation fixtures remain testable");
    check(active.indexOf("supabase db push --password") < active.indexOf(block) && active.indexOf(block) < active.indexOf("Confirm TEST migration history"), "one-time correction between application and genuine history/type checks");
    check(active.slice(active.indexOf("\n  production:\n")) === retired.slice(retired.indexOf("\n  production:\n")), "Production job unchanged by either operational state");
    check(REQUEST_TIMEOUT_MS === 20_000, "immutable transport deadline");
    const started = Date.now();
    await Promise.all([
      assert.rejects(runCorrection({ env, root, fetchImpl: async () => ({ status: 201, json: () => new Promise(() => {}) }) as Response }), /CRYPTO_REPAIR_OUTCOME_UNKNOWN_USE_READBACK/),
      assert.rejects(runCorrection({ env, root, readOnly: true, fetchImpl: async () => new Promise(() => {}) }), /CRYPTO_REPAIR_READBACK_UNAVAILABLE/),
    ]);
    check(Date.now() - started < REQUEST_TIMEOUT_MS * 2, "outer deadline bounds uncooperative fetch AND response-body reads");
    console.log(`cryptoNamespaceRepair.test: ${passed} checks passed; fixed TEST, strict definitions/ACLs, no DDL retry, independent readback and active/retired workflow states`);
  } finally { rmSync(root, { recursive: true, force: true }); }
}
main().catch(() => { console.error("cryptoNamespaceRepair.test failed; private transport details suppressed"); process.exitCode = 1; });
