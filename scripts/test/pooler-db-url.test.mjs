// @ts-check
// Pure tests for scripts/ci/pooler-db-url.mjs (fake fetch, no network).
import assert from "node:assert/strict";
import { main, buildPoolerUrl } from "../ci/pooler-db-url.mjs";
import { testDbUrlProblem, TEST_REF, PROD_REF } from "../ci/supabase-test-db-url.mjs";

let passed = 0;
/** @param {string} name @param {boolean} ok */
const check = (name, ok) => { assert.ok(ok, name); passed += 1; };

const TOKEN = "sbp_" + "b".repeat(40);
const PW = "p@ss:w/rd#1";
const entry = (ref, extra = {}) => ({ database_type: "PRIMARY", db_user: `postgres.${ref}`, db_host: "aws-1-us-east-2.pooler.supabase.com", db_port: 6543, db_name: "postgres", pool_mode: "transaction", ...extra });
/** @param {number} status @param {unknown} body @param {{ url?: string, auth?: string }} [cap] */
const fakeFetch = (status, body, cap) => /** @type {typeof fetch} */ (async (url, init) => {
  if (cap) { cap.url = String(url); cap.auth = /** @type {Record<string, string>} */ (init?.headers ?? {}).Authorization; }
  return /** @type {Response} */ ({ ok: status >= 200 && status < 300, status, json: async () => body });
});
const run = async (env, f) => {
  const out = [], log = [];
  const code = await main(env, f, { out: (s) => out.push(s), log: (s) => log.push(s) });
  return { code, out: out.join(""), log: log.join("\n") };
};

const cap = {};
const ok = await run({ POOLER_REF: PROD_REF, POOLER_TOKEN: `${TOKEN}\n`, POOLER_DB_PASSWORD: PW }, fakeFetch(200, [entry("readreplicaxxxxxxxxx", { database_type: "READ_REPLICA" }), entry(PROD_REF)], cap));
check("builds the session-pooler URL on port 5432", ok.code === 0 && ok.out === `postgresql://postgres.${PROD_REF}:${encodeURIComponent(PW)}@aws-1-us-east-2.pooler.supabase.com:5432/postgres`);
check("percent-encodes the password so the URL round-trips", decodeURIComponent(new URL(ok.out).password) === PW);
check("asks the project's pooler config with the trimmed token", cap.url === `https://api.supabase.com/v1/projects/${PROD_REF}/config/database/pooler` && cap.auth === `Bearer ${TOKEN}`);
const test = await run({ POOLER_REF: TEST_REF, POOLER_TOKEN: TOKEN, POOLER_DB_PASSWORD: "abc123" }, fakeFetch(200, [entry(TEST_REF, { db_host: "aws-1-us-west-2.pooler.supabase.com" })]));
check("a TEST URL built this way passes the TEST URL guard", test.code === 0 && testDbUrlProblem(test.out) === null);
const fromCs = buildPoolerUrl([{ connection_string: `postgres://postgres.${PROD_REF}:[YOUR-PASSWORD]@aws-0-us-east-2.pooler.supabase.com:6543/postgres` }], PROD_REF, "x");
check("falls back to the connection string when host or user is absent", "url" in fromCs && fromCs.url.includes("@aws-0-us-east-2.pooler.supabase.com:5432/postgres"));

const refusals = [
  ["another project's user", [entry(TEST_REF)]],
  ["a non-pooler host", [entry(PROD_REF, { db_host: "evil.example.com" })]],
  ["a look-alike host", [entry(PROD_REF, { db_host: "aws-1-us-east-2.pooler.supabase.com.evil.test" })]],
  ["another database", [entry(PROD_REF, { db_name: "other" })]],
  ["an empty list", []],
];
for (const [label, body] of refusals) {
  const r = await run({ POOLER_REF: PROD_REF, POOLER_TOKEN: TOKEN, POOLER_DB_PASSWORD: PW }, fakeFetch(200, body));
  check(`refuses ${label}`, r.code === 1 && r.out === "" && r.log.startsWith("::error title=Database URL not built::"));
}
const denied = await run({ POOLER_REF: PROD_REF, POOLER_TOKEN: TOKEN, POOLER_DB_PASSWORD: PW }, fakeFetch(403, {}));
check("an API refusal names the status", denied.code === 1 && denied.log.includes("answered 403"));
check("neither the token nor the password reaches a log line", !denied.log.includes(TOKEN) && !denied.log.includes(PW));
for (const [label, env] of [["a malformed ref", { POOLER_REF: "x", POOLER_TOKEN: TOKEN, POOLER_DB_PASSWORD: PW }], ["a missing token", { POOLER_REF: PROD_REF, POOLER_TOKEN: "", POOLER_DB_PASSWORD: PW }], ["a missing password", { POOLER_REF: PROD_REF, POOLER_TOKEN: TOKEN, POOLER_DB_PASSWORD: "" }]]) {
  const r = await run(env, fakeFetch(200, [entry(PROD_REF)]));
  check(`refuses ${label} before calling the API`, r.code === 1 && r.out === "");
}
const thrown = await run({ POOLER_REF: PROD_REF, POOLER_TOKEN: TOKEN, POOLER_DB_PASSWORD: PW }, /** @type {typeof fetch} */ (async () => { throw new Error("offline"); }));
check("a network error fails closed", thrown.code === 1 && thrown.out === "");

console.log(`pooler-db-url.test: ${passed} checks passed`);
