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

  db.beforeStatement = (stmt: Statement) =>
    stmt.table === "campaigns" && stmt.op === "delete" ? { message: 'relation "campaigns" is locked', code: "55P03" } : undefined;
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
  check("the code is a bare lowercase_snake token (no table name, no colon)", CODE.test(code) && !code.includes("campaigns"));
  check("the table name is logged for operators instead", JSON.stringify(logged).includes('"table":"campaigns"'));
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

  console.log(`clearMyData.test: ${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
