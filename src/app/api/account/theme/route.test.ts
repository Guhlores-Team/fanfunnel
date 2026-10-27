import assert from "node:assert";
import { mock } from "node:test";

// AUTH-SENSITIVE (AGENTS.md rules 5/7): /api/account/theme sets the creator's
// headline font and background through set_creator_theme (migration 0058).
//
// Negative tests: a signed-out caller gets 401 with no read and no RPC; a font
// or background off the allow-list, a url()/CSS value, or a photo background
// without a photo id never reaches the RPC; a body naming another creator or
// another creator's columns changes nothing about the call (the RPC takes the
// theme keys only and writes auth.uid()'s row); the database's refusal of
// another creator's photo surfaces as 400 invalid_photo; a suspended account
// (the RPC updates nothing) gets 403; the route never touches the service
// role. The runtime half (anon refused, A can't write B, A can't use B's photo)
// is in scripts/db/themeProbe.mjs (via schema-drift-check.mjs) and
// scripts/security/rls-runtime-test.mjs.

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

const rpcs: { name: string; args: unknown }[] = [];
const reads: string[] = [];
let user: { id: string } | null = null;
let rpcResult: { data: unknown; error: { message: string } | null } = { data: null, error: null };
let storedTheme: unknown = { font: "syne", background: "noir" };

function builder(table: string) {
  reads.push(table);
  const proxy: unknown = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === "maybeSingle") return async () => ({ data: { theme: storedTheme }, error: null });
        if (prop === "then")
          return (resolve: (v: unknown) => void) => resolve({ data: [], error: null });
        return () => proxy;
      },
    }
  );
  return proxy;
}

const client = {
  auth: { getUser: async () => ({ data: { user }, error: null }) },
  from: (table: string) => builder(table),
  storage: { from: () => ({ getPublicUrl: (p: string) => ({ data: { publicUrl: `https://cdn.test/${p}` } }) }) },
  rpc: async (name: string, args: unknown) => {
    rpcs.push({ name, args });
    return rpcResult;
  },
};

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service";

mock.module("@/lib/supabase/server", {
  namedExports: {
    isSupabaseConfigured: () => true,
    createClient: async () => client,
    createServiceClient: () => {
      throw new Error("the theme route must never use the service role");
    },
  },
});
mock.module("next/cache", { namedExports: { revalidatePath: () => {} } });

async function main() {
  const { GET, PUT } = await import("./route");
  const put = async (body: unknown) => {
    const res = await PUT(
      new Request("http://localhost/api/account/theme", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body),
      })
    );
    return { status: res.status, data: (await res.json()) as Record<string, unknown> };
  };
  const PHOTO = "123e4567-e89b-42d3-a456-426614174000";

  // --- 1. Signed out → 401, nothing read, no RPC ---------------------------------
  user = null;
  {
    const g = await GET();
    check("GET signed out → 401", g.status === 401);
    check("GET signed out → no theme leaked", !("theme" in (await g.json())));
    check("GET signed out → no table read", reads.length === 0);
    for (const body of [{ font: "syne" }, { background: "photo", bgMediaId: PHOTO }]) {
      const p = await put(body);
      check(`PUT ${JSON.stringify(body)} signed out → 401`, p.status === 401 && p.data.error === "unauthorized");
    }
    check("PUT signed out → RPC never called", rpcs.length === 0);
  }

  // --- 2. Signed in -----------------------------------------------------------------
  user = { id: "creator-a" };
  {
    const g = await GET();
    const d = await g.json();
    check("GET → own theme", g.status === 200 && d.theme.font === "syne" && d.theme.background === "noir");
    check("GET → private, no-store", /private/.test(g.headers.get("cache-control") ?? "") && /no-store/.test(g.headers.get("cache-control") ?? ""));
    storedTheme = { font: "<script>", background: "url(x)" };
    const junk = await (await GET()).json();
    check("GET normalises a junk stored theme to the defaults", junk.theme.font === "bricolage" && junk.theme.background === "glow");

    const refused: [unknown, string][] = [
      [{ font: "Comic Sans" }, "invalid_font"],
      [{ font: { family: "x" } }, "invalid_font"],
      [{ background: "url(https://evil.example/x.png)" }, "invalid_background"],
      [{ background: "#fff;} body{display:none" }, "invalid_background"],
      [{ background: "photo" }, "invalid_photo"],
      [{ background: "photo", bgMediaId: "../other-creator/x.webp" }, "invalid_photo"],
    ];
    for (const [body, code] of refused) {
      const p = await put(body);
      check(`PUT ${JSON.stringify(body)} → 400 ${code}`, p.status === 400 && p.data.error === code);
    }
    check("refused themes never reach the RPC", rpcs.length === 0);
    check("malformed JSON → 400", (await put("{nope")).status === 400);
    check("an array body → 400", (await put([1, 2])).status === 400);

    rpcResult = { data: { font: "fraunces", background: "aurora" }, error: null };
    const ok = await put({ font: "fraunces", background: "aurora" });
    check("PUT valid → 200 with the saved theme", ok.status === 200 && (ok.data.theme as Record<string, string>).font === "fraunces");
    check("PUT calls set_creator_theme once", rpcs.length === 1 && rpcs[0].name === "set_creator_theme");
    check("PUT passes only the theme keys", JSON.stringify(rpcs[0].args) === JSON.stringify({ p_theme: { font: "fraunces", background: "aurora" } }));

    // Another creator's id / columns in the body change nothing: there is no target.
    rpcs.length = 0;
    const sneaky = await put({
      font: "syne",
      background: "glow",
      creatorId: "creator-b",
      id: "creator-b",
      p_id: "creator-b",
      theme: { font: "x" },
      role: "admin",
      features: { all: true },
    });
    check("PUT with another creator's id → still only own theme", sneaky.status === 200);
    check("…and the RPC got the theme keys only", JSON.stringify(rpcs[0]?.args) === JSON.stringify({ p_theme: { font: "syne", background: "glow" } }));

    // The database refuses a photo that isn't the caller's own (B's media).
    rpcs.length = 0;
    rpcResult = { data: null, error: { message: "invalid theme photo" } };
    const foreign = await put({ background: "photo", bgMediaId: PHOTO });
    check("another creator's photo → 400 invalid_photo", foreign.status === 400 && foreign.data.error === "invalid_photo");
    check("…after exactly one RPC with that id", JSON.stringify(rpcs[0]?.args) === JSON.stringify({ p_theme: { font: "bricolage", background: "photo", bg_media_id: PHOTO } }));

    // A suspended account: the RPC updates no row and returns null.
    rpcResult = { data: null, error: null };
    const suspended = await put({ font: "syne" });
    check("suspended → 403", suspended.status === 403 && suspended.data.error === "forbidden");

    rpcResult = { data: null, error: { message: "connection reset" } };
    check("a DB failure → 400 db_error (no detail)", (await put({ font: "syne" })).data.error === "db_error");
  }

  console.log(`theme route: ${passed} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
