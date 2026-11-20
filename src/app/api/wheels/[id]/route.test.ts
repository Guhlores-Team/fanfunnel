import assert from "node:assert/strict";
import { mock } from "node:test";
import { FakeSupabase, type Row } from "@/lib/data/fakeSupabase";

// PATCH /api/wheels/[id] on the Supabase path. `archived: true` archives
// through archiveWheel, the same call and authorization as DELETE (no
// ?hard=1): a creator-scoped read, then archive_wheel, which itself requires
// can_act_for(creator, 'edit_wheel') or is_admin(). `archived: false` needs the
// same edit_wheel. A field PATCH would ignore, or an empty body, is a 400 and
// never a 200 for a no-op. Negative cases: signed out, another creator's game,
// a staff seat (its own user id, no edit_wheel for the owner), and the owner
// whose edit_wheel is gone (can_act_for also requires an active profile).

const OWNER = "a0000000-0000-4000-8000-000000000001";
const OTHER = "b0000000-0000-4000-8000-000000000002";
const SEAT = "c0000000-0000-4000-8000-000000000003";
const db = new FakeSupabase(OWNER);
let caller: string | null = OWNER;
let revalidations = 0;

// archive_wheel (0065), as schema.sql defines it: refused as not_found unless
// the caller may edit_wheel for the game's creator; archived_at is kept when
// already set, and the game stops being active.
db.rpcHandlers.archive_wheel = (args) => {
  const wheel = db.rows("wheels").find((w) => w.id === (args as Row).p_wheel);
  if (!wheel || db.permissions[String(wheel.creator_id)] !== true) return "not_found";
  wheel.archived_at ??= new Date().toISOString();
  wheel.is_active = false;
  return "ok";
};

mock.module("@/lib/supabase/server", { namedExports: {
  isSupabaseConfigured: () => true,
  createClient: async () => ({ ...db.client(), auth: { getUser: async () => ({ data: { user: caller ? { id: caller, user_metadata: { role: "admin" } } : null }, error: null }) } }),
  createServiceClient: () => { throw new Error("archive/restore must not use the service role"); },
} });
mock.module("@/lib/api/publicPage", { namedExports: { revalidateMyPublicPage: async () => { revalidations++; } } });

let checks = 0;
const check = (label: string, condition: unknown) => { assert.ok(condition, label); checks++; };

async function main() {
  const { PATCH, DELETE } = await import("./route");
  const at = (id: unknown) => ({ params: Promise.resolve({ id: String(id) }) });
  const patch = (id: unknown, body: unknown) => PATCH(new Request(`http://localhost/api/wheels/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), at(id));
  const del = (id: unknown) => DELETE(new Request(`http://localhost/api/wheels/${id}`, { method: "DELETE" }), at(id));
  const error = async (res: Response) => ((await res.json()) as { error?: string }).error;
  const archiveCalls = () => db.rpcCalls.filter((c) => c.name === "archive_wheel").length;

  const live = db.seed("wheels", { creator_id: OWNER, is_active: true, created_at: "2026-01-01T00:00:00Z" });
  const spare = db.seed("wheels", { creator_id: OWNER, created_at: "2026-01-02T00:00:00Z" });
  const foreign = db.seed("wheels", { creator_id: OTHER, is_active: true });
  db.permissions[OWNER] = true;
  db.permissions[OTHER] = false;

  // Refused shapes change nothing and never reach the data layer.
  for (const [label, body, code] of [
    ["empty body", {}, "nothing_to_change"],
    ["a field PATCH would ignore", { title: "Renamed" }, "unsupported_field"],
    ["a known field next to an ignored one", { isActive: true, gameKind: "scratch" }, "unsupported_field"],
    ["archive mixed with activation", { archived: true, isActive: true }, "conflicting_fields"],
    ["archive mixed with a schedule", { archived: true, activeFrom: null }, "conflicting_fields"],
    ["isActive: false (no such operation)", { isActive: false }, "bad_request"],
    ["a non-boolean archived", { archived: "yes" }, "bad_request"],
    ["a non-date schedule", { activeFrom: 5 }, "bad_request"],
  ] as const) {
    const res = await patch(spare.id, body);
    check(`${label}: 400 ${code}`, res.status === 400 && (await error(res)) === code);
  }
  check("refused shapes archive, activate and revalidate nothing", archiveCalls() === 0 && spare.archived_at === null && live.is_active === true && revalidations === 0);

  // Signed out.
  caller = null;
  check("signed out: archive is 401", (await patch(spare.id, { archived: true })).status === 401);
  caller = OWNER;
  check("signed out: nothing archived", spare.archived_at === null && archiveCalls() === 0);

  // Another creator's game: the creator-scoped read finds nothing.
  let res = await patch(foreign.id, { archived: true });
  check("another creator's game: archive is 404", res.status === 404 && (await error(res)) === "not_found");
  foreign.archived_at = "2026-02-01T00:00:00Z";
  check("another creator's game: restore is 404", (await patch(foreign.id, { archived: false })).status === 404);
  check("another creator's game stays as it was", foreign.archived_at === "2026-02-01T00:00:00Z" && foreign.is_active === true && archiveCalls() === 0);
  foreign.archived_at = null;

  // A staff seat calling with the owner's game id: it has no edit_wheel for
  // the owner, and this route only ever acts on the caller's own games.
  caller = SEAT;
  db.permissions[OWNER] = false;
  check("a seat without edit_wheel: archive is 404", (await patch(spare.id, { archived: true })).status === 404);
  check("a seat without edit_wheel: DELETE archive is 404 too", (await del(spare.id)).status === 404);
  spare.archived_at = "2026-02-01T00:00:00Z";
  check("a seat without edit_wheel: restore is refused", !(await patch(spare.id, { archived: false })).ok);
  check("a seat changed nothing", spare.archived_at === "2026-02-01T00:00:00Z" && archiveCalls() === 0 && revalidations === 0);
  spare.archived_at = null;
  caller = OWNER;

  // The owner whose edit_wheel is gone (e.g. a deactivated profile):
  // archive_wheel refuses, and restore is checked the same way.
  res = await patch(spare.id, { archived: true });
  check("owner without edit_wheel: archive refused as not_found", res.status === 404 && spare.archived_at === null);
  spare.archived_at = "2026-02-01T00:00:00Z";
  res = await patch(spare.id, { archived: false });
  check("owner without edit_wheel: restore is 403 forbidden", res.status === 403 && (await error(res)) === "forbidden" && spare.archived_at === "2026-02-01T00:00:00Z");
  check("refused calls never revalidate", revalidations === 0);
  spare.archived_at = null;
  db.permissions[OWNER] = true;

  // The owner with edit_wheel: archive via PATCH really archives.
  res = await patch(spare.id, { archived: true });
  check("owner: PATCH archived:true is 200", res.status === 200);
  check("owner: the game is archived through archive_wheel", typeof spare.archived_at === "string" && db.rpcCalls.at(-1)?.name === "archive_wheel" && db.rpcCalls.at(-1)?.args.p_wheel === spare.id);
  check("owner: one revalidation", revalidations === 1);
  res = await patch(spare.id, { archived: false });
  check("owner: PATCH archived:false restores", res.status === 200 && spare.archived_at === null && revalidations === 2);
  const restoreAuth = db.rpcCalls.filter((c) => c.name === "can_act_for").at(-1);
  check("restore authorizes edit_wheel for the caller's own id", restoreAuth?.args.target_creator === OWNER && restoreAuth?.args.perm === "edit_wheel");

  // PATCH and DELETE archive the same way: archiving the live game promotes
  // the oldest ready survivor either way.
  res = await patch(live.id, { archived: true });
  check("archiving the live game via PATCH promotes the survivor", res.status === 200 && typeof live.archived_at === "string" && live.is_active === false && spare.is_active === true);
  check("PATCH archive on an archived game stays archived (as DELETE)", (await patch(live.id, { archived: true })).status === 200 && typeof live.archived_at === "string");
  check("restoring the original game", (await patch(live.id, { archived: false })).status === 200 && live.archived_at === null);
  res = await del(spare.id);
  check("DELETE archive of the same game is identical", res.status === 200 && typeof spare.archived_at === "string" && spare.is_active === false && live.is_active === true);
  check("the foreign game was never touched", foreign.archived_at === null && foreign.is_active === true);

  console.log(`wheels/[id] route.test: ${checks} checks passed`);
}

main().catch((err) => { console.error(err); process.exit(1); });
