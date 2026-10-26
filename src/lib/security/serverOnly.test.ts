/**
 * AGENTS.md rule 3: the service-role key must never reach the browser. The
 * module that exposes it (`src/lib/supabase/server.ts`) carries
 * `import "server-only"`, so a client-bundle import fails `next build`. This
 * static test locks that in CI without a build:
 *  1. the guard import is the first statement of server.ts and the package is
 *     a declared dependency;
 *  2. no `"use client"` module reaches server.ts through its import graph
 *     (transitively), so the guard can't be dodged by an intermediate file;
 *  3. the scanner itself catches a violation (it isn't vacuous);
 *  4. nothing run under tsx imports server.ts: `server-only` throws outside a
 *     React Server environment, so unit tests must not pull it in.
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

const SRC = join(import.meta.dirname, "../..");
const ROOT = join(SRC, "..");
const SERVER_MODULE = join(SRC, "lib/supabase/server.ts");
const SELF = join(SRC, "lib/security/serverOnly.test.ts");

let failures = 0;
const fail = (msg: string) => {
  failures++;
  console.error("  ✗", msg);
};
const ok = (msg: string) => console.log("  ✓", msg);

const CODE_EXT = /\.(ts|tsx|js|jsx|mjs)$/;

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (CODE_EXT.test(e)) out.push(p);
  }
  return out;
}

/** Strip comments so commented-out imports/directives don't count. */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

function isUseClient(code: string): boolean {
  return /^\s*["']use client["']/.test(stripComments(code));
}

function importSpecifiers(code: string): string[] {
  const out: string[] = [];
  const re = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']([^"']+)["']/g;
  for (const m of stripComments(code).matchAll(re)) out.push(m[1]);
  return out;
}

function resolveSpec(spec: string, from: string, exists: (p: string) => boolean): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(from), spec);
  else return null; // bare package
  const candidates = [
    base,
    ...[".ts", ".tsx", ".js", ".jsx", ".mjs"].map((x) => base + x),
    ...["index.ts", "index.tsx", "index.js"].map((x) => join(base, x)),
  ];
  for (const cand of candidates) {
    if (CODE_EXT.test(cand) && exists(cand)) return cand;
  }
  return null;
}

/** Import chains from `entry` that reach `target` (transitive). */
function chainsReaching(
  entry: string,
  read: (p: string) => string,
  exists: (p: string) => boolean,
  target: string,
): string[][] {
  const found: string[][] = [];
  const seen = new Set<string>([entry]);
  const stack: string[][] = [[entry]];
  while (stack.length) {
    const chain = stack.pop()!;
    const file = chain[chain.length - 1];
    for (const spec of importSpecifiers(read(file))) {
      const r = resolveSpec(spec, file, exists);
      if (!r || seen.has(r)) continue;
      if (r === target) {
        found.push([...chain, r]);
        continue;
      }
      seen.add(r);
      stack.push([...chain, r]);
    }
  }
  return found;
}

const rel = (p: string) => p.slice(SRC.length + 1);
const read = (p: string) => readFileSync(p, "utf8");
const files = walk(SRC);

// --- 1. Guard line + dependency ---------------------------------------------
{
  const code = stripComments(read(SERVER_MODULE)).trimStart();
  if (/^import\s+["']server-only["']\s*;?/.test(code)) ok('server.ts starts with import "server-only"');
  else fail('src/lib/supabase/server.ts must begin with import "server-only"');

  const pkg = JSON.parse(read(join(ROOT, "package.json")));
  if (pkg.dependencies?.["server-only"]) ok("server-only is a declared dependency");
  else fail("server-only must be in package.json dependencies");
}

// --- 2. No "use client" module reaches server.ts ----------------------------
{
  const clientFiles = files.filter((f) => isUseClient(read(f)));
  if (clientFiles.length === 0) fail("expected to find some use-client modules (scanner broken?)");
  const bad = clientFiles.flatMap((f) => chainsReaching(f, read, existsSync, SERVER_MODULE));
  if (bad.length === 0) ok(`${clientFiles.length} "use client" modules cannot reach lib/supabase/server (transitive)`);
  else for (const chain of bad) fail(`client module reaches server.ts: ${chain.map(rel).join(" -> ")}`);
}

// --- 3. The scanner catches a violation (direct and transitive) -------------
{
  const fake = new Map<string, string>([
    [join(SRC, "c/Client.tsx"), '"use client";\nimport { x } from "../h/helper";'],
    [join(SRC, "h/helper.ts"), 'import { createServiceClient } from "@/lib/supabase/server";'],
    [join(SRC, "c/Direct.tsx"), "'use client'\nimport '@/lib/supabase/server'"],
    [join(SRC, "c/Server.tsx"), 'import { x } from "../h/helper";'],
    [join(SRC, "c/Commented.tsx"), '"use client";\n// import "@/lib/supabase/server";'],
    [SERVER_MODULE, ""],
  ]);
  const get = (p: string) => fake.get(p) ?? "";
  const has = (p: string) => fake.has(p);
  const flagged = [...fake.keys()]
    .filter((f) => isUseClient(get(f)))
    .filter((f) => chainsReaching(f, get, has, SERVER_MODULE).length > 0)
    .map(rel)
    .sort();
  if (flagged.join() === "c/Client.tsx,c/Direct.tsx") ok("scanner flags direct + transitive client imports only");
  else fail(`scanner self-test wrong, flagged: ${JSON.stringify(flagged)}`);
}

// --- 4. Nothing run under tsx imports server.ts -----------------------------
{
  const offenders = files
    .filter((f) => f.endsWith(".test.ts") && f !== SELF)
    .filter((f) => chainsReaching(f, read, existsSync, SERVER_MODULE).length > 0)
    .map(rel);
  if (offenders.length === 0) ok("no unit test imports lib/supabase/server (server-only would throw under tsx)");
  else for (const o of offenders) fail(`unit test reaches server.ts; server-only would throw under tsx: ${o}`);
}

if (failures > 0) {
  console.error(`\n${failures} server-only check(s) failed`);
  process.exit(1);
}
console.log("\nserver-only guard checks passed");
