/**
 * AUTH-SENSITIVE (AGENTS.md rules 2/5/6/7): Terms acceptance records (0055).
 *
 * Creators: profiles.terms_accepted_at / terms_version are written ONLY by the
 * server-only record_terms_acceptance() RPC, called on the service client with
 * the SESSION user's id and the server's LEGAL.version. Fans: fans.acked_terms_version
 * is written only by ackFan for the fan behind the given token.
 *
 * Negative tests here:
 *   - signed out: the routes refuse and nothing is written;
 *   - a creator cannot record acceptance for another creator, nor pick or
 *     backdate the version (body ids/versions/dates are ignored);
 *   - anon / authenticated cannot execute the RPC (migration grants);
 *   - a fan token cannot set another fan's version, and a stale version
 *     re-gates the fan (needs_ack) until they agree again.
 * The runtime DB probe for the same rules lives in scripts/db/schema-drift-check.mjs
 * and scripts/security/rls-runtime-test.mjs.
 */
import assert from "node:assert";
import { mock } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

// --- 1. The migration and both SQL snapshots --------------------------------
const ROOT = join(import.meta.dirname, "../../..");
const SUPA = join(ROOT, "supabase");
const norm = (s: string) =>
  s
    .replace(/--[^\n]*/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

for (const [name, file] of [
  ["migration 0055", join(SUPA, "migrations", "0055_terms_acceptance.sql")],
  ["schema.sql", join(SUPA, "schema.sql")],
  ["migrations_combined.sql", join(SUPA, "migrations_combined.sql")],
] as const) {
  const sql = norm(readFileSync(file, "utf8"));
  check(`${name}: adds profiles.terms_accepted_at`, sql.includes("alter table public.profiles add column if not exists terms_accepted_at timestamptz;"));
  check(`${name}: adds profiles.terms_version`, sql.includes("alter table public.profiles add column if not exists terms_version text;"));
  check(`${name}: adds fans.acked_terms_version`, sql.includes("alter table public.fans add column if not exists acked_terms_version text;"));
  const fn = sql.match(/create or replace function public\.record_terms_acceptance\(p_user uuid, p_version text\)[\s\S]*?as \$\$[\s\S]*?\$\$\s*;/)?.[0];
  check(`${name}: defines record_terms_acceptance`, !!fn);
  check(`${name}: SECURITY DEFINER with a pinned search_path`, /security definer set search_path = public/.test(fn!));
  const body = fn!.slice(fn!.indexOf("$$") + 2, fn!.lastIndexOf("$$"));
  check(`${name}: the time is the database's now(), never an argument`, /terms_accepted_at = now\(\)/.test(body) && !/p_at|p_time|p_date/.test(fn!));
  check(`${name}: rejects a malformed version`, /p_version !~ '\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$'/.test(body));
  check(`${name}: writes only the terms columns`, !/\b(role|features|approval_status|is_active)\b/.test(body));
  check(
    `${name}: revoked from public, anon and authenticated`,
    sql.includes("revoke execute on function public.record_terms_acceptance(uuid, text) from public, anon, authenticated;")
  );
  check(`${name}: granted to service_role only`, sql.includes("grant execute on function public.record_terms_acceptance(uuid, text) to service_role;") && !/grant execute on function public\.record_terms_acceptance\(uuid, text\) to (anon|authenticated|public)/.test(sql));
}
const mig = norm(readFileSync(join(SUPA, "migrations", "0055_terms_acceptance.sql"), "utf8"));
check("0055 adds no policy (profiles_update stays admin-only)", !/create policy|drop policy|alter policy/.test(mig));
check("0055 grants no table privileges", !/grant (select|insert|update|delete|all)/.test(mig));

// --- 2. Routes + data layer against a recording Supabase fake -----------------
type Op = [string, unknown[]];
type Call = { client: "session" | "service"; table: string; ops: Op[] };
const calls: Call[] = [];
const rpcs: { client: string; name: string; args: Record<string, unknown> }[] = [];
let configured = true;
let user: { id: string; email?: string } | null = null;
let profileRow: Record<string, unknown> | null = null;
/** token -> fan id, for the service client's fan_passes lookups. */
const passes: Record<string, string> = {};
let ackRead: { data: unknown; error: { message: string } | null } | undefined;

function builder(client: Call["client"], table: string) {
  const call: Call = { client, table, ops: [] };
  calls.push(call);
  const rows = (): unknown[] => {
    if (table === "profiles") return profileRow ? [profileRow] : [];
    // The token's stored wheel is owned and live; resolver fallback now checks
    // this explicitly instead of trusting a bare stored id.
    if (table === "wheels") return [{ id: "w1", creator_id: "creator-1", archived_at: null, is_active: true, active_from: null, active_until: null, created_at: "2026-01-01T00:00:00Z" }];
    if (table === "fan_passes") {
      const tok = call.ops.find(([op, a]) => op === "eq" && a[0] === "token")?.[1][1] as string | undefined;
      const fanId = tok ? passes[tok] : undefined;
      return fanId ? [{ creator_id: "creator-1", campaign_id: null, wheel_id: "w1", fan_id: fanId }] : [];
    }
    return [];
  };
  const proxy: unknown = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === "then") return (resolve: (v: unknown) => void) => resolve({ data: rows(), error: null });
        if (prop === "maybeSingle" || prop === "single") {
          return () => {
            call.ops.push([prop, []]);
            if (ackRead && table === "fan_passes" && call.ops.some(([op, args]) => op === "select" && String(args[0]).includes("acked_terms_version"))) {
              return Promise.resolve(ackRead);
            }
            return Promise.resolve({ data: rows()[0] ?? null, error: null });
          };
        }
        return (...args: unknown[]) => {
          call.ops.push([prop, args]);
          return proxy;
        };
      },
    }
  );
  return proxy;
}

const sessionClient = {
  auth: { getUser: async () => ({ data: { user }, error: null }) },
  from: (t: string) => builder("session", t),
  rpc: async (name: string, args: Record<string, unknown>) => {
    rpcs.push({ client: "session", name, args });
    return { data: null, error: { message: "permission denied for function " + name } };
  },
};
const serviceClient = {
  from: (t: string) => builder("service", t),
  rpc: async (name: string, args: Record<string, unknown>) => {
    rpcs.push({ client: "service", name, args });
    return { data: "2026-10-27T12:00:00.000Z", error: null };
  },
};

mock.module("@/lib/supabase/server", {
  namedExports: {
    isSupabaseConfigured: () => configured,
    createClient: async () => sessionClient,
    createServiceClient: () => serviceClient,
  },
});

async function main() {
  const { LEGAL } = await import("@/lib/legal");
  const terms = await import("@/app/api/account/terms/route");
  const application = await import("@/app/api/creator-application/route");
  const ack = await import("@/app/api/fans/ack/route");
  const mockLayer = await import("@/lib/data/mock");
  const { getFanPass, spin } = await import("@/lib/data");

  const post = (route: { POST: (r: Request) => Promise<Response> }, body: unknown, ip = "10.0.0.1") =>
    route
      .POST(
        new Request("http://x/api", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-real-ip": ip },
          body: JSON.stringify(body),
        })
      )
      .then(async (r) => ({ status: r.status, data: (await r.json()) as Record<string, unknown> }));
  const reset = () => {
    calls.length = 0;
    rpcs.length = 0;
  };

  // Signed out: 401 on read and write, nothing recorded.
  configured = true;
  user = null;
  reset();
  {
    const g = await terms.GET();
    check("GET terms signed out → 401", g.status === 401);
    const p = await post(terms, { accept: true }, "10.0.0.2");
    check("POST terms signed out → 401", p.status === 401);
    const a = await post(application, { displayName: "X", acceptTerms: true }, "10.0.0.3");
    check("POST application signed out → 401", a.status === 401);
    check("signed out → no RPC at all", rpcs.length === 0);
  }

  // Signed in as creator-1.
  user = { id: "creator-1", email: "c1@example.test" };

  // Agreement must be a literal true.
  for (const body of [{}, { accept: "true" }, { accept: 1 }, { accept: false }]) {
    reset();
    const p = await post(terms, body, "10.0.0.4");
    check(`POST terms ${JSON.stringify(body)} → 400 terms_required`, p.status === 400 && p.data.error === "terms_required");
    check(`POST terms ${JSON.stringify(body)} → nothing recorded`, rpcs.length === 0);
  }

  // A creator cannot record acceptance for someone else, or choose the version/time.
  reset();
  {
    const p = await post(
      terms,
      { accept: true, userId: "creator-2", p_user: "creator-2", version: "2099-01-01", acceptedAt: "2000-01-01T00:00:00Z" },
      "10.0.0.5"
    );
    check("POST terms signed in → 200", p.status === 200);
    check("exactly one RPC", rpcs.length === 1);
    check("the RPC is record_terms_acceptance on the SERVICE client", rpcs[0]?.name === "record_terms_acceptance" && rpcs[0]?.client === "service");
    check("…for the SESSION user, not the id in the body", rpcs[0]?.args.p_user === "creator-1");
    check("…with the server's LEGAL.version, not the body's", rpcs[0]?.args.p_version === LEGAL.version);
    check("…and no client-supplied time", !("p_at" in (rpcs[0]?.args ?? {})));
    check("the response reports the current version", p.data.version === LEGAL.version && p.data.needsAcceptance === false);
    check("no direct profiles write", !calls.some((c) => c.ops.some(([op]) => ["update", "upsert", "insert"].includes(op))));
  }

  // GET reads the caller's own row and flags a stale version.
  reset();
  profileRow = { terms_version: "2020-01-01", terms_accepted_at: "2020-01-01T00:00:00Z" };
  {
    const g = await terms.GET();
    const d = (await g.json()) as Record<string, unknown>;
    check("GET stale version → needsAcceptance", g.status === 200 && d.needsAcceptance === true && d.current === LEGAL.version);
    check(
      "GET reads only the caller's profile, on the session client",
      calls.length === 1 && calls[0].client === "session" && calls[0].table === "profiles" &&
        calls[0].ops.some(([op, a]) => op === "eq" && a[0] === "id" && a[1] === "creator-1")
    );
  }
  profileRow = { terms_version: LEGAL.version, terms_accepted_at: "2026-10-27T00:00:00Z" };
  {
    const d = (await (await terms.GET()).json()) as Record<string, unknown>;
    check("GET current version → no prompt", d.needsAcceptance === false);
  }
  profileRow = null;

  // The access-request form requires the clickwrap, then records it server-side.
  reset();
  {
    const a = await post(application, { displayName: "Ava", socials: "x.com/ava", audienceSize: "5k" }, "10.0.0.6");
    check("application without acceptTerms → 400 terms_required", a.status === 400 && a.data.error === "terms_required");
    check("application without acceptTerms → nothing written", rpcs.length === 0 && calls.length === 0);
    const b = await post(application, { displayName: "Ava", socials: "x.com/ava", audienceSize: "5k", acceptTerms: "yes" }, "10.0.0.6");
    check("application with a non-boolean acceptTerms → 400", b.status === 400 && rpcs.length === 0);
    reset();
    const c = await post(application, { displayName: "Ava", socials: "x.com/ava", audienceSize: "5k", acceptTerms: true, userId: "creator-2" }, "10.0.0.6");
    check("application with acceptTerms → 200", c.status === 200);
    check("application records acceptance for the session user", rpcs.length === 1 && rpcs[0].args.p_user === "creator-1" && rpcs[0].args.p_version === LEGAL.version);
  }

  // Fan ack (Supabase path): only the fan behind the token, version from the server.
  reset();
  passes["tok-a"] = "fan-a";
  passes["tok-b"] = "fan-b";
  {
    const r = await post(ack, { token: "tok-a", version: "2099-01-01", fanId: "fan-b" }, "10.0.0.7");
    check("fan ack → 200", r.status === 200);
    const updates = calls.filter((c) => c.table === "fans" && c.ops.some(([op]) => op === "update"));
    check("one fans update", updates.length === 1 && updates[0].client === "service");
    const payload = updates[0].ops.find(([op]) => op === "update")![1][0] as Record<string, unknown>;
    check("the update stamps LEGAL.version, not the body's", payload.acked_terms_version === LEGAL.version);
    check("the update is scoped to the token's fan only", updates[0].ops.some(([op, a]) => op === "eq" && a[0] === "id" && a[1] === "fan-a") &&
      !updates[0].ops.some(([, a]) => a.includes("fan-b")));
    reset();
    const bad = await post(ack, { token: "tok-unknown" }, "10.0.0.8");
    check("unknown token → 404 and no write", bad.status === 404 && !calls.some((c) => c.ops.some(([op]) => op === "update")));
  }

  // A failed consent read must not turn into permission to spend a spin.
  for (const [label, response, expected] of [
    ["unreadable consent", { data: null, error: { message: "consent read unavailable" } }, "db_error"],
    ["missing link", { data: null, error: null }, "not_found"],
    ["stale consent", { data: { fan_id: "fan-a", fan: { acked_at: "2026-01-01T00:00:00Z", acked_terms_version: "2000-01-01" } }, error: null }, "needs_ack"],
  ] as const) {
    reset();
    ackRead = response;
    const result = await spin("tok-a", "consent-test");
    check(`Supabase: ${label} is refused`, "error" in result && result.error === expected);
    check(`Supabase: ${label} never claims or refunds a spin`, rpcs.length === 0);
  }
  ackRead = undefined;

  // --- 3. Demo path parity ------------------------------------------------------
  configured = false;
  {
    const g = (await (await terms.GET()).json()) as Record<string, unknown>;
    check("demo: starts accepted at the current version", g.version === LEGAL.version && g.needsAcceptance === false);
    const p = await post(terms, { accept: true }, "10.0.0.9");
    check("demo: POST accept → 200 at the current version", p.status === 200 && p.data.version === LEGAL.version);

    const a = mockLayer.mockCreatePass("Terms Fan A", 2);
    const b = mockLayer.mockCreatePass("Terms Fan B", 2);
    const r = await post(ack, { token: a.token }, "10.0.0.10");
    check("demo: fan A acks", r.status === 200);
    const passA = await getFanPass(a.token);
    const passB = await getFanPass(b.token);
    check("demo: fan A no longer needs the gate", passA?.needsAck === false);
    check("demo: fan B's gate is untouched by A's token", passB?.needsAck === true);
    const spunB = await spin(b.token, "seed");
    check("demo: fan B still can't spin (needs_ack)", "error" in spunB && spunB.error === "needs_ack");

    // A stale version (Terms changed since) re-gates the fan until they agree again.
    const store = (globalThis as unknown as { __ffStore: { fans: Map<string, { name: string; ackedTermsVersion: string | null }> | { name: string; ackedTermsVersion: string | null }[] } }).__ffStore;
    const fans = Array.isArray(store.fans) ? store.fans : [...store.fans.values()];
    const fanA = fans.find((f) => f.name === "Terms Fan A");
    check("demo: found fan A in the store", !!fanA);
    fanA!.ackedTermsVersion = "2000-01-01";
    check("demo: stale version → gate shows again", (await getFanPass(a.token))?.needsAck === true);
    const spunA = await spin(a.token, "seed");
    check("demo: stale version → spin refused with needs_ack", "error" in spunA && spunA.error === "needs_ack");
    await post(ack, { token: a.token }, "10.0.0.11");
    check("demo: agreeing again clears the gate", (await getFanPass(a.token))?.needsAck === false);
  }

  console.log(`termsAcceptance: ${passed} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
