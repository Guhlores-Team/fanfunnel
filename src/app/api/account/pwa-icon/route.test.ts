import assert from "node:assert";
import { mock } from "node:test";

// AUTH-SENSITIVE (AGENTS.md rules 5/7): /api/account/pwa-icon sets the creator's
// home-screen icon choice (RM-4, D8) through set_pwa_icon_mode (migration 0046).
//
// Negative tests: a signed-out caller gets 401 with no read and no RPC; an
// invalid mode never reaches the RPC; a body naming another creator changes
// nothing about the call (the RPC takes the mode only and writes auth.uid()'s
// row); the route never touches the service role. The runtime half (anon is
// refused by Postgres, creator A's call leaves B's row alone) is in
// scripts/db/schema-drift-check.mjs, e2e/supabase.mjs and
// scripts/security/rls-runtime-test.mjs.

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

const rpcs: { name: string; args: unknown }[] = [];
const reads: string[] = [];
let configured = true;
let user: { id: string } | null = null;
let profileRow: Record<string, unknown> | null = { pwa_icon_mode: "avatar" };

function builder(table: string) {
  reads.push(table);
  const proxy: unknown = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === "maybeSingle") return async () => ({ data: profileRow, error: null });
        if (prop === "then") return undefined;
        return () => proxy;
      },
    }
  );
  return proxy;
}

const client = {
  auth: { getUser: async () => ({ data: { user }, error: null }) },
  from: (table: string) => builder(table),
  rpc: async (name: string, args: unknown) => {
    rpcs.push({ name, args });
    return { data: null, error: null };
  },
};

mock.module("@/lib/supabase/server", {
  namedExports: {
    isSupabaseConfigured: () => configured,
    createClient: async () => client,
    createServiceClient: () => {
      throw new Error("the pwa-icon route must never use the service role");
    },
  },
});

async function main() {
  const { GET, PUT } = await import("./route");
  const put = async (body: unknown) => {
    const res = await PUT(
      new Request("http://localhost/api/account/pwa-icon", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body),
      })
    );
    return { status: res.status, data: (await res.json()) as Record<string, unknown> };
  };

  // --- 1. Signed out (anon) → 401, nothing read, no RPC ----------------------
  user = null;
  {
    const g = await GET();
    check("GET signed out → 401", g.status === 401);
    check("GET signed out → no mode leaked", !("mode" in (await g.json())));
    check("GET signed out → no table read", reads.length === 0);
    for (const body of [{ mode: "avatar" }, { mode: "neutral" }, { mode: "bogus" }]) {
      const p = await put(body);
      check(`PUT ${JSON.stringify(body)} signed out → 401`, p.status === 401 && p.data.error === "unauthorized");
    }
    check("PUT signed out → RPC never called", rpcs.length === 0);
  }

  // --- 2. Signed in --------------------------------------------------------------
  user = { id: "creator-a" };
  {
    const g = await GET();
    const d = await g.json();
    check("GET signed in → 200 with own mode", g.status === 200 && d.mode === "avatar");
    check("GET → private, no-store", /private/.test(g.headers.get("cache-control") ?? "") && /no-store/.test(g.headers.get("cache-control") ?? ""));
    profileRow = { pwa_icon_mode: "something-else" };
    check("GET normalises an unknown stored value to neutral", (await (await GET()).json()).mode === "neutral");
    profileRow = null;
    check("GET with no row → neutral default", (await (await GET()).json()).mode === "neutral");

    for (const bad of [{ mode: "selfie" }, { mode: "" }, { mode: null }, {}, { mode: ["avatar"] }]) {
      const p = await put(bad);
      check(`PUT ${JSON.stringify(bad)} → 400 invalid_mode`, p.status === 400 && p.data.error === "invalid_mode");
    }
    check("invalid modes never reach the RPC", rpcs.length === 0);
    const malformed = await put("{not json");
    check("PUT malformed JSON → 400", malformed.status === 400);

    const ok = await put({ mode: "avatar" });
    check("PUT avatar → 200", ok.status === 200 && ok.data.ok === true && ok.data.mode === "avatar");
    check("PUT calls set_pwa_icon_mode once", rpcs.length === 1 && rpcs[0].name === "set_pwa_icon_mode");
    check("PUT passes only the mode", JSON.stringify(rpcs[0].args) === JSON.stringify({ p_mode: "avatar" }));

    // Another creator's id in the body changes nothing: there is no target.
    rpcs.length = 0;
    const sneaky = await put({ mode: "neutral", creatorId: "creator-b", userId: "creator-b", id: "creator-b", p_id: "creator-b" });
    check("PUT with another creator's id → still only own row", sneaky.status === 200);
    check("…and the RPC got the mode only", JSON.stringify(rpcs[0]?.args) === JSON.stringify({ p_mode: "neutral" }));
  }

  // --- 3. Demo mode: works without Supabase, same validation -----------------
  configured = false;
  user = null;
  {
    rpcs.length = 0;
    check("demo PUT avatar → 200", (await put({ mode: "avatar" })).status === 200);
    check("demo GET reflects it", (await (await GET()).json()).mode === "avatar");
    check("demo PUT bogus → 400", (await put({ mode: "bogus" })).status === 400);
    check("demo never calls the RPC", rpcs.length === 0);
    await put({ mode: "neutral" });
  }

  console.log(`pwa-icon route: ${passed} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
