/**
 * Static guard: `src/lib/api/clientIp.ts` is the ONLY module allowed to derive a
 * client IP from request headers. Two helpers with different precedence already
 * diverged once (one trusted the client-controlled left-most x-forwarded-for
 * entry first, letting a caller rotate rate-limit buckets). Any new IP parsing
 * must go through `clientIp()` so the spoof-resistant order lives in one place.
 */
import assert from "node:assert";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const SRC = join(import.meta.dirname, "../..");
const ALLOWED = join(SRC, "lib", "api", "clientIp.ts");

// Headers that carry a client address. Reading any of them outside the helper
// is a second, unreviewed precedence order.
const IP_HEADER = /x-forwarded-for|x-real-ip|x-vercel-forwarded-for|cf-connecting-ip|true-client-ip|x-client-ip/i;
// A second helper by the same name would also reintroduce the split.
const CLIENT_IP_DEF = /\b(function\s+clientIp\b|(const|let|var)\s+clientIp\s*=)/;
// Every caller imports the one helper, never a re-export from elsewhere.
const CLIENT_IP_IMPORT = /import\s*\{[^}]*\bclientIp\b[^}]*\}\s*from\s*["']([^"']+)["']/g;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx|js|jsx|mjs)$/.test(entry) && !/\.test\.ts$/.test(entry)) out.push(p);
  }
  return out;
}

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

const files = walk(SRC);
check("scanned a non-trivial number of source files", files.length > 50);
check("the helper exists", files.includes(ALLOWED));

const offenders: string[] = [];
const extraDefs: string[] = [];
const badImports: string[] = [];
let importers = 0;
for (const f of files) {
  // latin1 keeps byte offsets stable for files that contain NUL bytes.
  const text = readFileSync(f, "latin1");
  const rel = relative(SRC, f).split(sep).join("/");
  if (f === ALLOWED) continue;
  text.split("\n").forEach((line, i) => {
    if (IP_HEADER.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
  });
  if (CLIENT_IP_DEF.test(text)) extraDefs.push(rel);
  for (const m of text.matchAll(CLIENT_IP_IMPORT)) {
    importers++;
    if (m[1] !== "@/lib/api/clientIp") badImports.push(`${rel} imports clientIp from ${m[1]}`);
  }
}

assert.deepStrictEqual(
  offenders,
  [],
  "only src/lib/api/clientIp.ts may read client-IP headers; use clientIp() instead:\n" +
    offenders.join("\n"),
);
passed++;
assert.deepStrictEqual(extraDefs, [], "a second clientIp() is defined in: " + extraDefs.join(", "));
passed++;
assert.deepStrictEqual(badImports, [], badImports.join("\n"));
passed++;
// Sanity: the rate-limited routes really do import the helper (guards against
// the import regex silently matching nothing).
check("rate-limited routes import clientIp", importers >= 9);

console.log(`clientIpSingleSource.test: ${passed} checks passed`);
