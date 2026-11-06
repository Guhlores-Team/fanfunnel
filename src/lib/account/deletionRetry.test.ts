import assert from "node:assert";
import { mock } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// A18: a paused account deletion is resumed by the daily maintenance cron with
// exponential backoff, with the actor/action that originally authorized it,
// until DELETION_AUTO_RETRIES; then (and for in-flight jobs that stall) it is
// listed in Admin with a Retry button wired to the storage-retry route.

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

type Call = { owner: string; opts: { wasAdmin: boolean; actorId?: string; action?: string } };
const resumed: Call[] = [];
let outcome: Record<string, unknown> = { ok: true, links: 0, auditRecorded: true };
mock.module("@/lib/account/deleteAccount", {
  namedExports: {
    deleteAccountAndTombstoneLinks: async (_svc: unknown, owner: string, opts: Call["opts"]) => { resumed.push({ owner, opts }); return outcome; },
  },
});

let adminOk = true;
mock.module("@/lib/auth/admin", {
  namedExports: {
    requireAdminRoute: async () => adminOk ? { ok: true, userId: "admin-1" } : { ok: false, response: Response.json({ error: "forbidden" }, { status: 403 }) },
  },
});
let configured = true;
let rows: Record<string, unknown>[] = [];
const filters: { name: string; args: unknown[] }[][] = [];
const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const activeAdminIds = new Set([ADMIN]);
let adminsError = false;
const adminReads: { name: string; args: unknown[] }[][] = [];
function svc() {
  const from = (table: string) => {
    assert.ok(table === "creator_storage_deletions" || table === "profiles", table);
    const ops: { name: string; args: unknown[] }[] = [];
    const chain: Record<string, unknown> = {};
    for (const name of ["select", "eq", "in", "or", "order", "limit"]) chain[name] = (...args: unknown[]) => { ops.push({ name, args }); return chain; };
    chain.then = (res: (v: unknown) => unknown) => {
      if (table === "profiles") {
        adminReads.push(ops);
        const ids = (ops.find((o) => o.name === "in")?.args[1] ?? []) as string[];
        const scoped = ops.some((o) => o.name === "eq" && o.args[0] === "role" && o.args[1] === "admin") && ops.some((o) => o.name === "eq" && o.args[0] === "is_active" && o.args[1] === true);
        return Promise.resolve(adminsError ? { data: null, error: { code: "57014" } } : { data: scoped ? ids.filter((id) => activeAdminIds.has(id)).map((id) => ({ id })) : [], error: null }).then(res);
      }
      filters.push(ops);
      const state = ops.find((o) => o.name === "eq" && o.args[0] === "state")?.args[1];
      return Promise.resolve({ data: state ? rows.filter((r) => r.state === state) : rows, error: null }).then(res);
    };
    return chain;
  };
  return { from };
}
mock.module("@/lib/supabase/server", { namedExports: { isSupabaseConfigured: () => configured, createServiceClient: svc, createClient: async () => svc() } });

const NOW = Date.parse("2026-10-31T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const job = (owner: string, patch: Record<string, unknown>) => ({
  owner_id: owner, state: "paused", was_role: "creator", actor_id: owner, action: "account.self_close",
  attempts: 1, last_error: "storage_cleanup_failed", created_at: ago(3 * 24 * 60 * MIN), updated_at: ago(60 * MIN), ...patch,
});

async function main() {
  const m = await import("./deletionRetry");

  // --- backoff ------------------------------------------------------------------
  check("first retry waits 15 minutes", m.deletionRetryDelayMs(1) === 15 * MIN);
  check("the wait doubles per attempt", m.deletionRetryDelayMs(2) === 30 * MIN && m.deletionRetryDelayMs(4) === 120 * MIN);
  check("the wait is capped at 24 hours", m.deletionRetryDelayMs(30) === 24 * 60 * MIN && m.deletionRetryDelayMs(1000) === 24 * 60 * MIN);
  check("a job never claimed waits the base delay", m.deletionRetryDelayMs(0) === 15 * MIN);
  check("next retry = paused-at + delay", m.nextDeletionRetryAt({ state: "paused", attempts: 2, updated_at: ago(0) }) === new Date(NOW + 30 * MIN).toISOString());
  check("no automatic retry once the budget is used", m.nextDeletionRetryAt({ state: "paused", attempts: m.DELETION_AUTO_RETRIES, updated_at: ago(0) }) === null);
  check("only paused jobs have an automatic retry time", m.nextDeletionRetryAt({ state: "pending", attempts: 1, updated_at: ago(0) }) === null);

  // --- the cron resume ----------------------------------------------------------
  const service = svc() as never;
  rows = [
    job("11111111-1111-4111-8111-111111111111", { attempts: 1, updated_at: ago(20 * MIN) }), // due (15 min)
    job("22222222-2222-4222-8222-222222222222", { attempts: 3, updated_at: ago(30 * MIN) }), // waiting (60 min)
    job("33333333-3333-4333-8333-333333333333", { attempts: m.DELETION_AUTO_RETRIES, updated_at: ago(48 * 60 * MIN) }), // needs admin
    job("44444444-4444-4444-8444-444444444444", { was_role: "admin", actor_id: ADMIN, action: "account.delete", attempts: 2, updated_at: ago(31 * MIN) }), // due (30 min)
    job("55555555-5555-4555-8555-555555555555", { state: "pending", updated_at: ago(5 * 60 * MIN) }), // not paused: never resumed here
  ];
  let stats = await m.retryPausedDeletions(service, NOW);
  check("only paused jobs are read", filters.at(-1)!.some((o) => o.name === "eq" && o.args[0] === "state" && o.args[1] === "paused"));
  check("due jobs are resumed, waiting and exhausted ones are not", resumed.map((r) => r.owner).join() === "11111111-1111-4111-8111-111111111111,44444444-4444-4444-8444-444444444444");
  check("a self-close resumes as its owner", resumed[0].opts.action === "account.self_close" && resumed[0].opts.actorId === "11111111-1111-4111-8111-111111111111" && resumed[0].opts.wasAdmin === false);
  check("an admin delete resumes with the admin who authorized it (SQL re-checks they are still an active admin)",
    resumed[1].opts.action === "account.delete" && resumed[1].opts.actorId === "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" && resumed[1].opts.wasAdmin === true);
  check("stats: 2 due, 2 completed, 1 waiting, 1 needs an admin", stats.due === 2 && stats.completed === 2 && stats.waiting === 1 && stats.needsAdmin === 1 && stats.failed === 0);

  check("the admin is checked against profiles (role admin, active), never metadata", adminReads.at(-1)!.some((o) => o.name === "in" && (o.args[1] as string[]).join() === ADMIN));

  // --- refusals no backoff can fix wait for an admin, not a daily 503 ---------------
  const DEMOTED = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const adminJob = (owner: string, actor: string | null) => job(owner, { was_role: "admin", actor_id: actor, action: "account.delete", attempts: 1, updated_at: ago(20 * MIN) });
  resumed.length = 0;
  rows = [adminJob("66666666-6666-4666-8666-666666666666", DEMOTED), adminJob("77777777-7777-4777-8777-777777777777", null),
    adminJob("88888888-8888-4888-8888-888888888888", "88888888-8888-4888-8888-888888888888"), adminJob("99999999-9999-4999-8999-999999999999", ADMIN)];
  stats = await m.retryPausedDeletions(service, NOW);
  check("an admin delete whose admin is no longer an active admin is not resumed", !resumed.some((r) => r.owner.startsWith("6666")));
  check("…nor one with no actor, or with the owner as its own admin actor", !resumed.some((r) => r.owner.startsWith("7777") || r.owner.startsWith("8888")));
  check("…each waits for an admin instead of failing every run", stats.needsAdmin === 3 && stats.failed === 0);
  check("a job whose admin is still active resumes alongside them", resumed.map((r) => r.owner).join() === "99999999-9999-4999-8999-999999999999" && stats.completed === 1);

  resumed.length = 0;
  adminsError = true;
  rows = [adminJob("99999999-9999-4999-8999-999999999999", ADMIN), job("11111111-1111-4111-8111-111111111111", { attempts: 1, updated_at: ago(20 * MIN) })];
  stats = await m.retryPausedDeletions(service, NOW);
  check("an unreadable admin list resumes nothing on an admin's authority and is counted failed", !resumed.some((r) => r.owner.startsWith("9999")) && stats.failed === 1);
  check("…while a self-close still resumes", resumed.map((r) => r.owner).join() === "11111111-1111-4111-8111-111111111111");
  adminsError = false;

  for (const refusal of ["forbidden", "last_admin", "not_found"]) {
    outcome = { error: refusal };
    rows = [job("11111111-1111-4111-8111-111111111111", { attempts: 1, updated_at: ago(20 * MIN) })];
    stats = await m.retryPausedDeletions(service, NOW);
    check(`a resume the SQL refuses (${refusal}) stays paused and waits for an admin, not counted failed`, stats.needsAdmin === 1 && stats.failed === 0 && stats.completed === 0);
  }
  for (const failure of ["db_error", "delete_failed", "storage_cleanup_failed"]) {
    outcome = { error: failure };
    stats = await m.retryPausedDeletions(service, NOW);
    check(`a resume that fails (${failure}) is counted failed and stays paused`, stats.failed === 1 && stats.completed === 0 && stats.needsAdmin === 0);
  }
  outcome = { pending: true, reason: "batch_remaining", reviewRequired: false };
  stats = await m.retryPausedDeletions(service, NOW);
  check("a resume that needs more runs is counted pending", stats.pending === 1);

  resumed.length = 0;
  outcome = { ok: true, links: 0, auditRecorded: true };
  rows = Array.from({ length: m.DELETION_RETRY_BATCH + 3 }, (_, i) => job(`${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`, { attempts: 1, updated_at: ago(60 * MIN) }));
  stats = await m.retryPausedDeletions(service, NOW);
  check("one run resumes at most DELETION_RETRY_BATCH jobs", resumed.length === m.DELETION_RETRY_BATCH && stats.due === m.DELETION_RETRY_BATCH + 3);

  // --- the Admin list -----------------------------------------------------------
  rows = [job("11111111-1111-4111-8111-111111111111", { attempts: 2, updated_at: ago(10 * MIN) })];
  const list = await m.listStuckDeletions(service, NOW);
  const or = filters.at(-1)!.find((o) => o.name === "or")?.args[0] as string;
  check("the list covers paused jobs and stale in-flight jobs only", or === `state.eq.paused,and(state.in.(pending,auth_deleting,auth_deleted),updated_at.lt.${new Date(NOW - m.DELETION_STALE_MS).toISOString()})`);
  check("each item carries state, last error, attempts, age and next retry", !!list && list[0].id === "11111111-1111-4111-8111-111111111111" && list[0].state === "paused" &&
    list[0].lastError === "storage_cleanup_failed" && list[0].attempts === 2 && list[0].nextRetryAt === new Date(NOW - 10 * MIN + 30 * MIN).toISOString());
  check("the list carries no account contents (ids and job state only)", Object.keys(list![0]).sort().join() === "attempts,id,lastError,nextRetryAt,startedAt,state,updatedAt");
  rows = [
    job("66666666-6666-4666-8666-666666666666", { was_role: "admin", actor_id: DEMOTED, action: "account.delete", attempts: 1, updated_at: ago(10 * MIN) }),
    job("99999999-9999-4999-8999-999999999999", { was_role: "admin", actor_id: ADMIN, action: "account.delete", attempts: 1, updated_at: ago(10 * MIN) }),
  ];
  const listed = await m.listStuckDeletions(service, NOW);
  check("Admin shows no automatic retry for a deletion whose admin was demoted", listed![0].nextRetryAt === null);
  check("…but keeps the retry time for one whose admin is still active", listed![1].nextRetryAt === new Date(NOW - 10 * MIN + 15 * MIN).toISOString());

  // --- the Admin route ----------------------------------------------------------
  rows = [job("11111111-1111-4111-8111-111111111111", { attempts: 2, updated_at: ago(10 * MIN) })];
  const { GET } = await import("@/app/api/admin/account/deletions/route");
  adminOk = false;
  let res = await GET();
  check("a non-admin is refused before anything is read", res.status === 403);
  adminOk = true;
  res = await GET();
  const body = await res.json() as { deletions: unknown[]; autoRetries: number };
  check("an admin gets the list, never cached", res.status === 200 && body.deletions.length === 1 && /no-store/.test(res.headers.get("cache-control") ?? ""));
  configured = false;
  res = await GET();
  check("demo mode answers an empty list", (await res.json()).deletions.length === 0);
  configured = true;

  // --- wiring -------------------------------------------------------------------
  const root = join(import.meta.dirname, "../../..");
  const card = readFileSync(join(root, "src/components/admin/StuckDeletions.tsx"), "utf8");
  const admin = readFileSync(join(root, "src/components/admin/AdminClient.tsx"), "utf8");
  const cron = readFileSync(join(root, "src/app/api/cron/retention/route.ts"), "utf8");
  check("Admin renders the stuck-deletions card", /<StuckDeletions \/>/.test(admin));
  check("the card lists from the admin route and retries through storage-retry with the id", /fetch\("\/api\/admin\/account\/deletions"/.test(card) && /fetch\("\/api\/admin\/account\/storage-retry"[\s\S]*JSON\.stringify\(\{ id: target \}\)/.test(card));
  check("the cron resumes paused deletions after authorizing the request", cron.indexOf("retryPausedDeletions(svc)") > cron.indexOf("cronAuthorized("));

  console.log(`deletionRetry.test: ${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
