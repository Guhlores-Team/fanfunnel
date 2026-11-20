// @ts-check
// Pure tests for scripts/ci/hosted-types.mjs (fake fetch, no network).
import assert from "node:assert/strict";
import { main, tokenShape } from "../ci/hosted-types.mjs";
import { TEST_REF, PROD_REF } from "../ci/supabase-test-db-url.mjs";

let passed = 0;
/** @param {string} name @param {boolean} ok */
const check = (name, ok) => { assert.ok(ok, name); passed += 1; };

const TOKEN = "sbp_" + "a".repeat(40);
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

const types = "export type Json = string\nexport type Database = {}\n";
const cap = {};
const ok = await run({ TEST_PROJECT_REF: TEST_REF, TEST_TYPES_TOKEN: ` ${TOKEN}\n` }, fakeFetch(200, { types }, cap));
check("writes the hosted types and exits 0", ok.code === 0 && ok.out === types);
check("calls the TEST project's public-schema types endpoint", cap.url === `https://api.supabase.com/v1/projects/${TEST_REF}/types/typescript?included_schemas=public`);
check("sends the trimmed token as a bearer token", cap.auth === `Bearer ${TOKEN}`);

const prod = await run({ TEST_PROJECT_REF: PROD_REF, TEST_TYPES_TOKEN: TOKEN }, fakeFetch(200, { types }));
check("refuses any project but TEST", prod.code === 1 && prod.out === "" && prod.log.includes("::error title=TEST types refused::"));
const missing = await run({ TEST_PROJECT_REF: TEST_REF, TEST_TYPES_TOKEN: "" }, fakeFetch(200, { types }));
check("a missing token fails with the setup hint", missing.code === 1 && missing.log.includes("SUPABASE_TEST_ACCESS_TOKEN"));
const denied = await run({ TEST_PROJECT_REF: TEST_REF, TEST_TYPES_TOKEN: TOKEN }, fakeFetch(401, {}));
check("an API refusal fails and names the status and token shape", denied.code === 1 && denied.log.includes("answered 401") && denied.log.includes("length 44"));
check("the token never reaches a log line", !denied.log.includes(TOKEN) && !missing.log.includes(TOKEN));
const empty = await run({ TEST_PROJECT_REF: TEST_REF, TEST_TYPES_TOKEN: TOKEN }, fakeFetch(200, { types: "" }));
check("an answer without types fails closed", empty.code === 1 && empty.out === "");
const thrown = await run({ TEST_PROJECT_REF: TEST_REF, TEST_TYPES_TOKEN: TOKEN }, /** @type {typeof fetch} */ (async () => { throw new Error("offline"); }));
check("a network error fails closed", thrown.code === 1);
check("tokenShape reports surrounding whitespace", tokenShape(" x").includes("surrounding whitespace: true"));

console.log(`hosted-types.test: ${passed} checks passed`);
