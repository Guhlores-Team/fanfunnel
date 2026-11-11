import assert from "node:assert";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

// A22: every route handler under src/app/api is throttled or guarded before it
// does any work. A handler passes when its own body (or a module-local helper it
// calls) invokes one of
//   limiter  limitRoute / limitSharedRead / rateLimitOr429 / rateLimitShared / withFanToken
//   guard    requireAdminRoute (active admin + aal2) / cronAuthorized (secret)
// and the call comes before the handler's first data-layer call. Anything else
// must be listed in ALLOWLIST with the reason it needs neither; a stale entry
// fails too, so the list can only shrink deliberately.

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

const ROOT = join(import.meta.dirname, "../../..");
const API = join(ROOT, "src/app/api");
function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (e === "route.ts") out.push(p);
  }
  return out;
}

/** route (relative to src/app/api) + method → why it needs no limiter or guard. */
const ALLOWLIST: Record<string, string> = {
  "debug/age-fan/route.ts POST":
    "Debug-demo fixture: returns a static 404 unless NEXT_PUBLIC_ENABLE_DEBUG=1 AND Supabase is unconfigured (checked first, no I/O); the in-memory demo has no shared state to protect.",
};

const LIMITER = /\b(limitRoute|limitSharedRead|rateLimitOr429|rateLimitShared|withFanToken)\s*[(<]/;
const GUARD = /\b(requireAdminRoute|cronAuthorized)\s*\(/;
const PROTECTS = new RegExp(`${LIMITER.source}|${GUARD.source}`);
const METHOD = /export\s+(?:async\s+function\s+|function\s+|const\s+)(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g;
// Data work the guard has to precede: a call into the data layer (anything
// imported from @/lib/data*), a table read/write, or an RPC. Authentication
// itself (createClient, auth.getUser, the current_user_active probe) may come
// first, because a per-user limiter needs the signed-in id as its key.
const AUTH_RPC = /^(current_user_active)$/;
// Pure helpers that live under @/lib/data but do no I/O (input checks, env reads).
// isPlausibleToken: the privacy routes test the token's shape before the
// creator-session guard, which answers ahead of the fan's limiters (ATK-01).
const PURE = new Set(["isUuid", "getPushConfig", "isPlausibleToken"]);
function dataCall(src: string): RegExp {
  const names = [...src.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']@\/lib\/data(?:\/[^"']*)?["']/g)]
    .flatMap((m) => m[1].split(",").map((n) => n.trim().replace(/^type\s+/, "").split(/\s+as\s+/).pop()!.trim()))
    .filter((n) => /^[a-z]\w*$/.test(n) && !PURE.has(n));
  const fns = names.length ? `\\b(?:${names.join("|")})\\s*\\(|` : "";
  return new RegExp(`${fns}\\.from\\(\\s*["']|\\.rpc\\(\\s*["'](?!${AUTH_RPC.source.slice(1, -1)}["'])`);
}
/** Handlers whose data call legitimately precedes the limiter, with the reason. */
const ORDER_EXCEPTIONS: Record<string, string> = {
  "account/export/route.ts GET":
    "Demo-mode branch only (Supabase unconfigured): returns the in-memory export; with Supabase the per-user limiter runs right after authentication, before the export.",
};

const files = walk(API).sort();
check("scanned every route file", files.length > 100);

const missing: string[] = [];
const late: string[] = [];
const seen = new Set<string>();
const scopes = new Map<string, string>();
let handlers = 0;
for (const file of files) {
  const rel = relative(API, file).split(sep).join("/");
  const src = readFileSync(file, "utf8");
  // Module-local helpers that themselves throttle/guard (e.g. a shared `guard(req)`).
  const helpers = [...src.matchAll(/(?:async\s+)?function\s+([A-Za-z_]\w*)\s*\([^)]*\)[^{]*\{([\s\S]*?)\n\}/g)]
    .filter((m) => !/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(m[1]) && PROTECTS.test(m[2]))
    .map((m) => m[1]);
  const helperCall = helpers.length ? new RegExp(`\\b(${helpers.join("|")})\\s*\\(`) : null;
  const marks = [...src.matchAll(METHOD)];
  for (let i = 0; i < marks.length; i++) {
    const m = marks[i];
    const body = src.slice(m.index, i + 1 < marks.length ? marks[i + 1].index : src.length);
    const key = `${rel} ${m[1]}`;
    handlers++;
    seen.add(key);
    for (const s of body.matchAll(/limitRoute\(\s*\w+\s*,\s*"([^"]+)"/g)) {
      const prior = scopes.get(s[1]);
      if (prior && prior !== key) missing.push(`${key}: limiter scope "${s[1]}" is already used by ${prior}`);
      scopes.set(s[1], key);
    }
    const guard = body.search(PROTECTS);
    const viaHelper = helperCall ? body.search(helperCall) : -1;
    const at = [guard, viaHelper].filter((n) => n >= 0).sort((a, b) => a - b)[0] ?? -1;
    if (at < 0) {
      if (!ALLOWLIST[key]) missing.push(key);
      continue;
    }
    if (ALLOWLIST[key]) missing.push(`${key}: is protected now; drop its ALLOWLIST entry`);
    const dataAt = body.search(dataCall(src));
    if (dataAt >= 0 && dataAt < at && !ORDER_EXCEPTIONS[key]) late.push(key);
  }
}
for (const m of missing) console.error("  ✗ unthrottled route handler:", m);
check(`every route handler is rate-limited or guarded (${handlers} handlers)`, missing.length === 0);
for (const l of late) console.error("  ✗ limiter/guard runs after a data call:", l);
check("the limiter or guard runs before the handler's first data-layer call", late.length === 0);
for (const [key, why] of Object.entries(ORDER_EXCEPTIONS)) {
  check(`order exception still names a real handler: ${key}`, seen.has(key));
  check(`order exception is justified: ${key}`, why.trim().length > 40);
}
for (const [key, why] of Object.entries(ALLOWLIST)) {
  check(`allowlist entry still names a real handler: ${key}`, seen.has(key));
  check(`allowlist entry is justified: ${key}`, why.trim().length > 40);
}

// The audit's named examples, pinned explicitly.
const read = (p: string) => readFileSync(join(API, p), "utf8");
for (const p of ["messages/auto-intro/route.ts", "messages/auto-outro/route.ts"]) {
  check(`${p} is token-gated through withFanToken (limiter + token checks)`, /withFanToken\s*</.test(read(p)) || /withFanToken\s*\(/.test(read(p)));
}
for (const p of ["public/wheel/[creatorId]/route.ts", "share-cards/[shareId]/route.ts"]) {
  check(`${p} uses the public tier`, /limitRoute\(\s*req\s*,\s*"[^"]+"\s*,\s*"public"\s*\)/.test(read(p)));
}
check(
  "the public wheel teaser is cached at the edge for 60s",
  /s-maxage=60/.test(read("public/wheel/[creatorId]/route.ts")),
);

// The helper keys on the shared client-IP derivation and a per-route scope.
const limitSrc = readFileSync(join(ROOT, "src/lib/api/limit.ts"), "utf8");
check("limitRoute keys on route scope + clientIp()", /`route:\$\{scope\}:\$\{clientIp\(req\)\}`/.test(limitSrc));
check("limitRoute goes through the shared (Upstash-capable) limiter", /export (?:async )?function limitRoute[\s\S]*rateLimitOr429\(/.test(limitSrc));

// Runtime: the tier really throttles, per scope and per client.
async function runtime() {
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  const { limitRoute, ROUTE_TIERS } = await import("@/lib/api/limit");
  const from = (ip: string) => new Request("http://localhost/api/x", { headers: { "x-real-ip": ip } });
  const n = ROUTE_TIERS.costly.limit;
  for (let i = 0; i < n; i++) assert.equal(await limitRoute(from("198.51.100.7"), "test:costly", "costly"), null);
  const over = await limitRoute(from("198.51.100.7"), "test:costly", "costly");
  check(`the ${n + 1}th call in the window is refused with 429`, over?.status === 429);
  check("the 429 says when to retry", Number(over?.headers.get("Retry-After")) > 0);
  check("the 429 body is the shared rate_limited code", (await over!.json()).error === "rate_limited");
  check("another client is not affected", (await limitRoute(from("198.51.100.8"), "test:costly", "costly")) === null);
  check("another route scope is not affected", (await limitRoute(from("198.51.100.7"), "test:other", "costly")) === null);
  check("tiers are ordered: costly < public < account", ROUTE_TIERS.costly.limit < ROUTE_TIERS.public.limit && ROUTE_TIERS.public.limit < ROUTE_TIERS.account.limit);

  // Negative: a caller cannot mint a fresh bucket by spoofing headers. Behind
  // the edge (x-real-ip pinned) every client-sent forwarding header is ignored;
  // without it, only the right-most x-forwarded-for hop (the one the nearest
  // proxy appended) counts, so rotating the left-most entries changes nothing.
  const spoof = (h: Record<string, string>) => new Request("http://localhost/api/x", { headers: h });
  for (let i = 0; i < n; i++) assert.equal(await limitRoute(spoof({ "x-real-ip": "203.0.113.9" }), "test:spoof-edge", "costly"), null);
  let rotated = 0;
  for (let i = 0; i < 5; i++) {
    const r = await limitRoute(spoof({
      "x-real-ip": "203.0.113.9",
      "x-forwarded-for": `10.9.${i}.1, 198.18.0.${i}`,
      "x-vercel-forwarded-for": `198.18.1.${i}`,
      "cf-connecting-ip": `198.18.2.${i}`,
      "true-client-ip": `198.18.3.${i}`,
      forwarded: `for=198.18.4.${i}`,
    }), "test:spoof-edge", "costly");
    if (r?.status === 429) rotated++;
  }
  check("behind the edge, rotating XFF / x-vercel-forwarded-for / cf-connecting-ip / true-client-ip / forwarded never escapes the limit", rotated === 5);
  for (let i = 0; i < n; i++) assert.equal(await limitRoute(spoof({ "x-forwarded-for": `10.0.0.${i}, 192.0.2.44` }), "test:spoof-xff", "costly"), null);
  let leftRotated = 0;
  for (let i = 0; i < 5; i++) {
    const r = await limitRoute(spoof({ "x-forwarded-for": `172.16.${i}.${i}, 10.1.1.${i}, 192.0.2.44`, "cf-connecting-ip": `198.18.5.${i}` }), "test:spoof-xff", "costly");
    if (r?.status === 429) leftRotated++;
  }
  check("without x-real-ip, prepending spoofed XFF hops or cf-connecting-ip never escapes the limit", leftRotated === 5);
}

runtime().then(() => console.log(`routeLimits.test: ${passed} checks passed`), (err) => {
  console.error(err);
  process.exit(1);
});
