// SC-09 / RS-07 / OPS3-12 D9: every environment variable the app reads is
// named in .env.example (the inventory operators copy) and in DEPLOY.md
// section 3 (the table with scopes and warnings). Platform-provided and
// test-harness names are allow-listed below with the reason.
//
//   node scripts/test/env-inventory.test.mjs
//
// Pure: reads src/, .env.example and DEPLOY.md.

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

let passed = 0;
const check = (label, ok) => {
  assert.ok(ok, label);
  passed++;
};
const ROOT = new URL("../../", import.meta.url).pathname;

/** Set by the platform or the test harness, never by an operator. */
export const PLATFORM_NAMES = new Set([
  "NODE_ENV", "NEXT_PHASE", "NEXT_RUNTIME", // Node / Next
  "VERCEL", "VERCEL_ENV", "VERCEL_URL", "VERCEL_GIT_COMMIT_SHA", "VERCEL_PROJECT_PRODUCTION_URL", // Vercel system variables
  "CI", "GITHUB_ACTIONS", // CI runners
  "FANFUNNEL_CI_LOCAL_SERVER", // e2e-supabase-ui.yml: the localhost auth server must not report deployment health
]);

/** @param {string} dir @returns {string[]} */
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx|mjs|js)$/.test(entry)) out.push(p);
  }
  return out;
}

/**
 * Every `process.env.NAME`, `env.NAME` (the conventional alias) and
 * `env["NAME"]` / `env.NAME ?? env.OTHER` read under src/ (production code
 * only). Dynamic lookups (`env[name]` over a list, as the rate-limit store
 * does) are caught by `mentioned` below.
 * @param {string} root
 */
export function envReads(root) {
  /** @type {Map<string, Set<string>>} */
  const byName = new Map();
  for (const file of sources(root)) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/\b(?:process\.env|env)(?:\.|\["|\[')([A-Z][A-Z0-9_]*)\b/g)) {
      const name = m[1];
      if (!byName.has(name)) byName.set(name, new Set());
      byName.get(name).add(file.slice(root.length));
    }
  }
  return byName;
}

/** Production source files under src/. @param {string} root */
function sources(root) {
  return walk(join(root, "src")).filter((f) => !/\.test\.(ts|tsx|mjs)$/.test(f));
}

/** Whether a name is used anywhere in production source under any alias (`e.KV_REST_API_URL`, a string literal). @param {string} root @param {string} name */
export function mentioned(root, name) {
  const re = new RegExp(`\\b${name}\\b`);
  return sources(root).some((f) => re.test(readFileSync(f, "utf8")));
}

/** Names declared in .env.example (`NAME=` at line start). @param {string} text */
export function declaredNames(text) {
  return new Set([...text.matchAll(/^([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]));
}

const reads = envReads(ROOT);
const example = readFileSync(join(ROOT, ".env.example"), "utf8");
const declared = declaredNames(example);
const deploy = readFileSync(join(ROOT, "DEPLOY.md"), "utf8");

check("the app reads a realistic number of variables", reads.size >= 30);
check("the allow-list names only variables the app really reads", [...PLATFORM_NAMES].every((n) => reads.has(n)));
const missing = [...reads.keys()].filter((n) => !PLATFORM_NAMES.has(n) && !declared.has(n)).sort();
assert.deepEqual(missing, [], `read under src/ but absent from .env.example: ${missing.map((n) => `${n} (${[...reads.get(n)].join(", ")})`).join("; ")}`);
passed++;
const stale = [...declared].filter((n) => !reads.has(n) && !mentioned(ROOT, n)).sort();
assert.deepEqual(stale, [], `declared in .env.example but read nowhere under src/: ${stale.join(", ")}`);
passed++;
const undocumented = [...declared].filter((n) => !deploy.includes(`\`${n}\``)).sort();
assert.deepEqual(undocumented, [], `in .env.example but not in DEPLOY.md: ${undocumented.join(", ")}`);
passed++;
for (const n of ["REWARD_ENCRYPTION_KEY_PREVIOUS", "REWARD_ENCRYPTION_KEY_PREVIOUS_VERSION", "ACCOUNT_EMAIL_FROM", "NEXT_PUBLIC_VAPID_PUBLIC_KEY"]) {
  check(`the batch-7 gaps are closed: ${n}`, (reads.has(n) || mentioned(ROOT, n)) && declared.has(n));
}
check("no secret value is committed in .env.example", example.split("\n").every((l) => !/^[A-Z][A-Z0-9_]+=.+/.test(l)));
check("the service key is never a NEXT_PUBLIC_ name", ![...reads.keys()].some((n) => /^NEXT_PUBLIC_.*(SERVICE|SECRET|PRIVATE)/.test(n)));
check("the reader catches aliased env reads", envReads(ROOT).has("ACCOUNT_EMAIL_FROM"));

console.log(`env-inventory.test: ${passed} checks passed`);
