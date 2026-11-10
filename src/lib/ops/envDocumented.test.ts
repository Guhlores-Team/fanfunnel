import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// RS-07: every environment variable the application reads is named in
// .env.example (values empty), so an operator following it never misses one.
// Platform/CI names the code reads but no operator sets are allow-listed.
const PLATFORM = new Set(["NODE_ENV", "NEXT_RUNTIME", "NEXT_PHASE", "CI", "GITHUB_ACTIONS", "GITHUB_SHA", "VERCEL", "VERCEL_ENV", "VERCEL_URL", "VERCEL_GIT_COMMIT_SHA", "VERCEL_PROJECT_PRODUCTION_URL", "VERCEL_DEPLOYMENT_ID", "FANFUNNEL_CI_LOCAL_SERVER", "INTERPLAY_STRICT", "PREVIEW_PERF_URL"]);
// Read by the code, documented by the ci builder's .env.example change (batch 7).
// TODO(b7-merge): remove once that lands; the check below then covers them.
const PENDING_CI_BUILDER = new Set(["ACCOUNT_EMAIL_FROM", "REWARD_ENCRYPTION_KEY_PREVIOUS", "REWARD_ENCRYPTION_KEY_PREVIOUS_VERSION", "NEXT_PUBLIC_VAPID_PUBLIC_KEY"]);

function files(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(p);
  }
  return out;
}

const root = new URL("../../../", import.meta.url);
const read = new Map<string, string[]>();
for (const f of files(join(root.pathname, "src"))) {
  const src = readFileSync(f, "utf8");
  for (const m of src.matchAll(/\b(?:process\.)?env(?:\.([A-Z][A-Z0-9_]{2,})|\[["']([A-Z][A-Z0-9_]{2,})["']\])/g)) {
    const name = m[1] ?? m[2];
    if (!read.has(name)) read.set(name, []);
    read.get(name)!.push(f.slice(root.pathname.length));
  }
}
const example = readFileSync(join(root.pathname, ".env.example"), "utf8");
const documented = new Set([...example.matchAll(/^([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]));

let passed = 0;
const check = (label: string, ok: unknown) => { assert.ok(ok, label); passed++; };
check("the inventory found the code's env reads", read.size > 20 && read.has("SUPABASE_SERVICE_ROLE_KEY") && read.has("HEARTBEAT_URL"));
check(".env.example lists names with empty values only", documented.size > 15 && !/^[A-Z][A-Z0-9_]+=\S/m.test(example));
const missing = [...read.keys()].filter((n) => !documented.has(n) && !PLATFORM.has(n) && !PENDING_CI_BUILDER.has(n)).sort();
check(`every env var the code reads is in .env.example (missing: ${missing.map((n) => `${n} <- ${read.get(n)![0]}`).join(", ") || "none"})`, missing.length === 0);
const landed = [...PENDING_CI_BUILDER].filter((n) => documented.has(n));
if (landed.length) console.log(`envDocumented: now documented, drop from PENDING_CI_BUILDER: ${landed.join(", ")}`);
const stillPending = [...PENDING_CI_BUILDER].filter((n) => !documented.has(n) && read.has(n));
if (stillPending.length) console.log(`envDocumented: TODO pending the ci builder's .env.example lines: ${stillPending.join(", ")}`);
console.log(`envDocumented: ${passed} checks passed`);
