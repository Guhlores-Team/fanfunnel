import assert from "node:assert";
import { mock } from "node:test";

// The demo-only "age a fan" route (RM-5 e2e support) must be unreachable
// wherever real data exists: with Supabase configured it is a 404 that never
// touches a client, and without a debug build it is a 404 too.

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

let configured = true;
let touched = 0;
mock.module("@/lib/supabase/server", {
  namedExports: {
    isSupabaseConfigured: () => configured,
    createClient: async () => {
      touched++;
      throw new Error("the age-fan route must never open a Supabase client");
    },
    createServiceClient: () => {
      touched++;
      throw new Error("the age-fan route must never use the service role");
    },
  },
});

async function main() {
  const { POST } = await import("./route");
  const m = await import("@/lib/data/mock");
  const post = async (body: unknown) => {
    const res = await POST(
      new Request("http://localhost/api/debug/age-fan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    return res.status;
  };
  const demoPassCount = () => m.mockListFans().find((f) => f.fanId === "demo-fan")?.passes.length;

  // Supabase configured (production, every Preview): 404 even in a debug build.
  process.env.NEXT_PUBLIC_ENABLE_DEBUG = "1";
  configured = true;
  check("supabase + debug → 404", (await post({ fanId: "demo-fan", days: 20 })) === 404);

  // Demo, but not a debug build: 404.
  configured = false;
  delete process.env.NEXT_PUBLIC_ENABLE_DEBUG;
  check("demo without debug build → 404", (await post({ fanId: "demo-fan", days: 20 })) === 404);
  check("…and no Supabase client was opened", touched === 0);

  // Demo debug build: works, validates.
  process.env.NEXT_PUBLIC_ENABLE_DEBUG = "1";
  check("demo debug: bad days → 400", (await post({ fanId: "demo-fan", days: 0 })) === 400);
  check("demo debug: fractional days → 400", (await post({ fanId: "demo-fan", days: 1.5 })) === 400);
  check("demo debug: unknown fan → 404", (await post({ fanId: "nope", days: 20 })) === 404);
  check("demo debug: the demo fan → 200", (await post({ fanId: "demo-fan", days: 20 })) === 200);
  check("demo fan still listed", demoPassCount() === 1);
  check("no Supabase client was ever opened", touched === 0);
  delete process.env.NEXT_PUBLIC_ENABLE_DEBUG;

  console.log(`debug/age-fan route: ${passed} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
