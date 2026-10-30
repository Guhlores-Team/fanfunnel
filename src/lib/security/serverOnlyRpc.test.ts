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
 * a client bound to `createServiceClient()`. The receiver is resolved with the
 * TypeScript AST, scoped to the enclosing function (then outer closures): a
 * local `const/let x = createServiceClient()` or a parameter whose type
 * annotation names `createServiceClient` counts as service; anything else
 * (session client, untyped/other parameter, unresolved) is a failure.
 */
import assert from "node:assert";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const REPO = join(import.meta.dirname, "../../..");
const MIG = join(REPO, "supabase/migrations");

// --- Which RPCs can `authenticated` NOT execute? -----------------------------
const migrationsSql = readdirSync(MIG)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(join(MIG, f), "utf8"))
  .join("\n")
  .replace(/--[^\n]*/g, " ");

const serverOnly = new Set<string>();
const grantRe =
  /\b(grant|revoke)\s+execute\s+on\s+function\s+public\.(\w+)\s*\([^)]*\)\s+(to|from)\s+([^;]+);/gi;
for (const m of migrationsSql.matchAll(grantRe)) {
  if (!/\bauthenticated\b/i.test(m[4])) continue;
  const fn = m[2].toLowerCase();
  if (m[1].toLowerCase() === "revoke") serverOnly.add(fn);
  else serverOnly.delete(fn);
}
assert.ok(serverOnly.has("credit_pass_spins"), "expected credit_pass_spins to be server-only (0027)");

// --- Resolve each rpc() receiver within its enclosing function scope ---------
type Violation = { line: number; fn: string; client: string; why: string };

function isFunctionLike(n: ts.Node): n is ts.SignatureDeclaration & { body?: ts.Node } {
  return (
    ts.isFunctionDeclaration(n) ||
    ts.isFunctionExpression(n) ||
    ts.isArrowFunction(n) ||
    ts.isMethodDeclaration(n) ||
    ts.isConstructorDeclaration(n) ||
    ts.isGetAccessorDeclaration(n) ||
    ts.isSetAccessorDeclaration(n)
  );
}

/** How `name` is bound as seen from `from`: walks enclosing functions outward. */
function resolveBinding(sf: ts.SourceFile, from: ts.Node, name: string): string {
  for (let scope: ts.Node | undefined = from.parent; scope; scope = scope.parent) {
    if (!isFunctionLike(scope) && !ts.isSourceFile(scope)) continue;
    let init: string | null = null;
    const visit = (n: ts.Node) => {
      // Don't look into nested functions: their locals aren't visible here.
      if (n !== scope && isFunctionLike(n)) return;
      if (
        ts.isVariableDeclaration(n) &&
        ts.isIdentifier(n.name) &&
        n.name.text === name &&
        n.getStart(sf) < from.getStart(sf)
      ) {
        init = n.initializer ? n.initializer.getText(sf) : "";
      }
      ts.forEachChild(n, visit);
    };
    ts.forEachChild(scope, visit);
    if (init !== null) return `const ${name} = ${init}`;
    if (isFunctionLike(scope)) {
      const param = scope.parameters.find((p) => ts.isIdentifier(p.name) && p.name.text === name);
      if (param) return `param ${name}: ${param.type ? param.type.getText(sf) : "(untyped)"}`;
    }
  }
  return "unresolved";
}

function findViolations(source: string, fileName: string, rpcs: Set<string>): Violation[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: Violation[] = [];
  const visit = (n: ts.Node) => {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === "rpc" &&
      ts.isIdentifier(n.expression.expression) &&
      n.arguments[0] &&
      ts.isStringLiteralLike(n.arguments[0]) &&
      rpcs.has(n.arguments[0].text.toLowerCase())
    ) {
      const client = n.expression.expression.text;
      const why = resolveBinding(sf, n, client);
      if (!/\bcreateServiceClient\b/.test(why)) {
        const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
        out.push({ line, fn: n.arguments[0].text, client, why });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

function countServerOnlyCalls(source: string, rpcs: Set<string>): number {
  let count = 0;
  for (const m of source.matchAll(/\.rpc\(\s*["'](\w+)["']/g)) if (rpcs.has(m[1].toLowerCase())) count++;
  return count;
}

// --- Self-test: the matcher catches the known false-negative shapes ----------
{
  const rpcs = new Set(["credit_pass_spins"]);
  const fixture = `
    async function spin() {
      const sb = createServiceClient();
      await sb.rpc("credit_pass_spins", {});          // ok: service local
    }
    async function helper(sb: Awaited<ReturnType<typeof createClient>>) {
      await sb.rpc("credit_pass_spins", {});          // BAD: session-typed param
    }
    async function untyped(sb) {
      await sb.rpc("credit_pass_spins", {});          // BAD: untyped param
    }
    async function svcParam(sb: ReturnType<typeof createServiceClient>) {
      await sb.rpc("credit_pass_spins", {});          // ok: service-typed param
    }
    async function session() {
      const sb = await createClient();
      /* const sb = createServiceClient(); */
      // const sb = createServiceClient();
      await sb.rpc("credit_pass_spins", {});          // BAD: comments don't count
    }
    async function closure() {
      const sb = createServiceClient();
      const inner = async () => { await sb.rpc("credit_pass_spins", {}); }; // ok: closure
      await inner();
    }
    async function shadowed() {
      const sb = createServiceClient();
      const inner = async (sb: SessionClient) => { await sb.rpc("credit_pass_spins", {}); }; // BAD
      await inner(sb);
    }
  `;
  const bad = findViolations(fixture, "fixture.ts", rpcs).map((v) => v.line);
  const expectBad = fixture
    .split("\n")
    .map((l, i) => (l.includes("// BAD") ? i + 1 : 0))
    .filter(Boolean);
  assert.deepStrictEqual(bad, expectBad, "self-test: matcher must flag exactly the BAD call sites");
}

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
  if (!src.includes(".rpc(")) continue;
  checked += countServerOnlyCalls(src, serverOnly);
  for (const v of findViolations(src, file, serverOnly)) {
    failures.push(
      `${file.slice(REPO.length + 1)}:${v.line} calls server-only rpc("${v.fn}") on ` +
        `"${v.client}" (${v.why}), not createServiceClient()`
    );
  }
}

for (const f of failures) console.error("  ✗", f);
assert.strictEqual(failures.length, 0, `${failures.length} server-only RPC call(s) on a non-service client`);
assert.ok(checked > 0, "expected at least one server-only RPC call site (claim_spin)");
console.log(`serverOnlyRpc.test: self-test ok; ${checked} server-only RPC call sites use the service client`);
