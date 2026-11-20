// 0065 (A44): archive/delete go through archive_wheel / delete_wheel. A lock
// wait that gave up there (the lifecycle lock blocks only after 20 NOWAIT
// tries, so a deadlock victim, lock/statement timeout or serialization
// failure is possible under constant play) changed nothing and is reported as
// the retryable game_busy (409), never as a generic db_error.
import assert from "node:assert/strict";
import { mock } from "node:test";
let checks = 0;
const check = (value: unknown, label: string) => { assert.ok(value, label); checks++; };
const CREATOR = "10000000-0000-4000-8000-000000000001", GAME = "50000000-0000-4000-8000-000000000005";
let answer: { data: unknown; error: unknown } = { data: "ok", error: null };
const calls: string[] = [];
const chain = () => {
  const q = { select: () => q, eq: () => q, is: () => q, order: () => q, limit: () => q, update: () => q, maybeSingle: async () => ({ data: { id: GAME, is_active: false }, error: null }) };
  return q;
};
mock.module("@/lib/supabase/server", { namedExports: {
  isSupabaseConfigured: () => true,
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: CREATOR } }, error: null }) },
    from: chain,
    rpc: async (name: string) => { calls.push(name); return answer; },
  }),
  createServiceClient: () => { throw new Error("archive/delete must not use the service role"); },
} });

async function main() {
  const { archiveWheel, deleteWheel } = await import("./wheels");
  const { statusForError } = await import("@/lib/api/handler");
  const { gameRefusalMessage } = await import("@/components/dashboard/gameEditor");
  check("ok" in await archiveWheel(GAME) && calls.at(-1) === "archive_wheel", "archive goes through archive_wheel");
  check("ok" in await deleteWheel(GAME) && calls.at(-1) === "delete_wheel", "delete goes through delete_wheel");
  for (const code of ["40P01", "55P03", "57014", "40001"]) {
    answer = { data: null, error: { code, message: "lock wait gave up" } };
    const archived = await archiveWheel(GAME), deleted = await deleteWheel(GAME);
    check("error" in archived && archived.error === "game_busy" && "error" in deleted && deleted.error === "game_busy", `${code} is the retryable game_busy`);
  }
  check(statusForError("game_busy") === 409 && /try again/i.test(gameRefusalMessage("game_busy") ?? ""), "game_busy is a 409 with a try-again message");
  answer = { data: null, error: { code: "XX000", message: "boom" } };
  const broken = await archiveWheel(GAME);
  check("error" in broken && broken.error === "db_error", "any other failure stays db_error");
  answer = { data: "has_history", error: null };
  const kept = await deleteWheel(GAME);
  check("error" in kept && kept.error === "has_history" && statusForError("has_history") === 409 && /Archive it instead/.test(gameRefusalMessage("has_history") ?? ""), "a game with plays or stored links is kept, with the archive hint");
  answer = { data: "not_found", error: null };
  const foreign = await archiveWheel(GAME);
  check("error" in foreign && foreign.error === "not_found", "the RPC's not_found (another creator's game) is not_found");
  console.log(`wheelLifecycle.test: ${checks} checks passed`);
}
main().catch((error) => { console.error(error); process.exit(1); });
