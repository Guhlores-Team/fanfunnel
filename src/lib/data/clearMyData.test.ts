import assert from "node:assert";
import { mock } from "node:test";
import { FakeSupabase, type Statement } from "./fakeSupabase";

// Error convention (src/lib/data/shared.ts): a failed mutation reports a bare
// lowercase_snake code, never a raw message or operator detail. clearMyData
// used to return `db_error:<table>`, the one code in the data layer with a
// colon — it leaked which table failed to the /api/account/reset client and
// fell outside statusForError's known set. These checks pin the normal shape.

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

const CREATOR = "creator-1";
const db = new FakeSupabase(CREATOR);
// clearMyData deletes from tables the ledger fake doesn't model by default.
for (const t of ["dm_templates", "prize_templates", "wheel_templates", "happy_hours", "webhooks", "autopilot_dismissals"]) {
  db.tables[t] = [];
}
const rpcCalls: string[] = [];
for (const fn of ["set_onboarding_dismissed", "set_leaderboard_enabled", "set_chat_settings"]) {
  db.rpcHandlers[fn] = () => {
    rpcCalls.push(fn);
    return null;
  };
}
// 0071: sessions can no longer DELETE campaigns or games; the reset is the
// service-only reset_creator_content, bound to an edit_wheel actor context the
// creator minted for itself. The fake models its effect on the two tables.
const CONTEXT = "c0c0c0c0-0000-4000-8000-000000000001";
const contexts: unknown[] = [];
db.rpcHandlers.issue_creator_actor_context = (args) => {
  contexts.push(args);
  return CONTEXT;
};
const resets: Record<string, unknown>[] = [];
db.rpcHandlers.reset_creator_content = (args) => {
  const a = args as Record<string, unknown>;
  resets.push(a);
  if (a.p_context !== CONTEXT || a.p_actor !== a.p_creator) return "forbidden";
  for (const t of ["campaigns", "wheels"]) db.tables[t] = db.rows(t).filter((r) => r.creator_id !== a.p_creator);
  return "ok";
};

mock.module("@/lib/supabase/server", {
  namedExports: {
    isSupabaseConfigured: () => true,
    createClient: async () => db.client(),
    createServiceClient: () => db.client(),
  },
});

const CODE = /^[a-z][a-z0-9_]*$/;

async function main() {
  const { clearMyData } = await import("./index");

  // --- a delete that fails -> bare "db_error", nothing else wiped afterwards --
  db.seed("fans", { creator_id: CREATOR, display_name: "Keep" });
  db.seed("wheels", { creator_id: CREATOR, is_active: true });
  db.seed("campaigns", { creator_id: CREATOR, name: "Launch" });
  db.seed("webhooks", { creator_id: CREATOR, url: "https://example.com/hook" });

  db.seed("campaign_packs", { creator_id: CREATOR, label: "Pack" });
  db.beforeStatement = (stmt: Statement) =>
    stmt.table === "campaign_packs" && stmt.op === "delete" ? { message: 'relation "campaign_packs" is locked', code: "55P03" } : undefined;
  const logged: unknown[] = [];
  const origError = console.error;
  console.error = (...args: unknown[]) => void logged.push(args);
  let failed: Awaited<ReturnType<typeof clearMyData>>;
  try {
    failed = await clearMyData();
  } finally {
    console.error = origError;
  }
  check("a failed delete reports an error", "error" in failed);
  const code = "error" in failed ? failed.error : "";
  check("the code is exactly db_error", code === "db_error");
  check("the code is a bare lowercase_snake token (no table name, no colon)", CODE.test(code) && !code.includes("campaign_packs"));
  check("the table name is logged for operators instead", JSON.stringify(logged).includes('"table":"campaign_packs"'));
  check("the failure stopped the wipe: later tables are untouched", db.rows("webhooks").length === 1);
  check("the failure stopped the wipe: no pref reset ran", rpcCalls.length === 0);

  // --- the happy path is unchanged -------------------------------------------
  db.beforeStatement = null;
  const ok = await clearMyData();
  check("a clean wipe returns { ok: true }", "ok" in ok && ok.ok === true);
  for (const t of ["fans", "wheels", "campaigns", "webhooks"]) {
    check(`${t} rows are gone`, db.rows(t).length === 0);
  }
  check("the three pref resets ran", rpcCalls.length === 3);
  check("campaigns and games go through reset_creator_content, never a session DELETE",
    db.statements.every((s) => !((s.table === "campaigns" || s.table === "wheels") && s.op === "delete")) && resets.length === 2);
  check("the reset names the caller as both creator and actor, with the context it minted for itself",
    resets.every((r) => r.p_creator === CREATOR && r.p_actor === CREATOR && r.p_context === CONTEXT)
      && contexts.every((c) => JSON.stringify(c) === JSON.stringify({ p_creator: CREATOR, p_permission: "edit_wheel" })));
  const order = db.rpcCalls.map((c) => c.name).filter((n) => n === "reset_creator_content");
  check("fans are deleted before the reset", order.length === 2 && db.statements.some((s) => s.table === "fans" && s.op === "delete"));

  // --- a refused reset stops the wipe before the standalone tables ------------
  db.seed("wheels", { creator_id: CREATOR, is_active: true });
  db.seed("webhooks", { creator_id: CREATOR, url: "https://example.com/again" });
  db.rpcHandlers.reset_creator_content = () => "forbidden";
  console.error = () => {};
  let refused: Awaited<ReturnType<typeof clearMyData>>;
  try { refused = await clearMyData(); } finally { console.error = origError; }
  check("a refused reset reports db_error", "error" in refused && refused.error === "db_error");
  check("…and leaves the game and the later tables alone", db.rows("wheels").length === 1 && db.rows("webhooks").length === 1);

  console.log(`clearMyData.test: ${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
