/**
 * Server-only RPC call-site guard. Runs in CI (no DB needed).
 *
 * Some SECURITY DEFINER functions are revoked from `authenticated` and granted
 * only to `service_role` (e.g. 0027 locked `claim_spin` / `credit_pass_spins`).
 * Calling one through the creator's session client (`createClient()`, anon key +
 * cookies = the `authenticated` role) fails with "permission denied" at runtime.
 * Callers that ignore the RPC error then fail SILENTLY: the referral credit in
 * `createPass` marked the referral credited while no bonus spins landed anywhere.
 *
 * This test derives the server-only set from the migrations (last grant/revoke
 * wins) and asserts every literal `x.rpc("name")` call to one of them is made on
 * a client bound to `createServiceClient()`.
 */
import assert from "node:assert";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dirname, "../../..");
const MIG = join(REPO, "supabase/migrations");

// --- Which RPCs can `authenticated` NOT execute? -----------------------------
const migrationsSql = readdirSync(MIG)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(join(MIG, f), "utf8"))
  .join("\n")
  .replace(/--[^\n]*/g, " ");

const serverOnly = new Map<string, boolean>();
const grantRe =
  /\b(grant|revoke)\s+execute\s+on\s+function\s+public\.(\w+)\s*\([^)]*\)\s+(to|from)\s+([^;]+);/gi;
for (const m of migrationsSql.matchAll(grantRe)) {
  const roles = m[4].toLowerCase();
  if (!/\bauthenticated\b/.test(roles)) continue;
  serverOnly.set(m[2].toLowerCase(), m[1].toLowerCase() === "revoke");
}
const serverOnlyNames = [...serverOnly].filter(([, v]) => v).map(([k]) => k);
assert.ok(
  serverOnlyNames.includes("credit_pass_spins"),
  "expected credit_pass_spins to be server-only (0027)"
);

// --- Every call site of a server-only RPC must use the service client --------
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (/\.tsx?$/.test(entry) && !entry.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

let checked = 0;
const failures: string[] = [];
for (const file of sourceFiles(join(REPO, "src"))) {
  const src = readFileSync(file, "utf8");
  for (const m of src.matchAll(/(\w+)\s*\.rpc\(\s*["'](\w+)["']/g)) {
    const [, client, fn] = m;
    if (!serverOnly.get(fn.toLowerCase())) continue;
    checked++;
    // Nearest preceding binding of the receiver decides which client it is.
    const before = src.slice(0, m.index);
    const decls = [
      ...before.matchAll(new RegExp(`\\b(?:const|let)\\s+${client}\\s*=([^;\\n]*)`, "g")),
    ];
    const init = decls.at(-1)?.[1] ?? "";
    if (!/\bcreateServiceClient\s*\(/.test(init)) {
      const line = before.split("\n").length;
      failures.push(
        `${file.slice(REPO.length + 1)}:${line} calls server-only rpc("${fn}") on ` +
          `"${client}" (${init.trim() || "unknown binding"}), not createServiceClient()`
      );
    }
  }
}

for (const f of failures) console.error("  ✗", f);
assert.strictEqual(failures.length, 0, `${failures.length} server-only RPC call(s) on a session client`);
assert.ok(checked > 0, "expected at least one server-only RPC call site (claim_spin)");
console.log(`serverOnlyRpc.test: ${checked} server-only RPC call sites use the service client`);
