import assert from "node:assert/strict";
import { mock } from "node:test";

// PR-04: "Ask to enable" stores a creator_notices row for the admins' bell
// and e-mails ALERT_EMAIL_TO; before 0073 the row is refused by the kind
// CHECK and the e-mail still goes. A game that is already on is refused; a
// repeat ask within the window is answered as the earlier one; the list is
// empty for a non-admin and leaves out requests whose game is on by now.
let passed = 0;
const check = (label: string, cond: unknown) => { assert.ok(cond, label); passed++; };

let features: Record<string, boolean> = {};
let insertError: { code: string; message: string } | null = null;
let notices: { id: string; creator_id: string; details: { game: string }; created_at: string }[] = [];
let admin = false;
const inserted: unknown[] = [];
const alerts: string[] = [];
const storedIds = new Set<string>();
let serviceCalls = 0;
let allowed: unknown = true;
let signedIn = true;
let permissionError: { code: string } | null = null;
const permissionCalls: { name: string; args: Record<string, unknown> }[] = [];
const svc = {
  from: (table: string) => {
    serviceCalls++;
    const q: Record<string, unknown> = {};
    const chain = () => q;
    Object.assign(q, {
      select: chain, eq: chain, gte: chain, limit: chain, order: chain, in: chain,
      // INSERT … ON CONFLICT (id) DO NOTHING RETURNING id: a second row with the same id returns nothing.
      upsert: (row: { id: string }, options: { onConflict?: string; ignoreDuplicates?: boolean }) => ({
        select: async () => {
          if (insertError) return { data: null, error: insertError };
          assert.equal(options.onConflict, "id");
          assert.equal(options.ignoreDuplicates, true);
          await new Promise((resolve) => setTimeout(resolve, 1)); // both concurrent asks are past the read by now
          if (storedIds.has(row.id)) return { data: [], error: null };
          storedIds.add(row.id);
          inserted.push(row);
          return { data: [{ id: row.id }], error: null };
        },
      }),
      then: (res: (v: unknown) => unknown) => {
        if (table === "creator_notices") return Promise.resolve({ data: notices, error: null }).then(res);
        if (table === "profiles") return Promise.resolve({ data: [{ id: "c1", display_name: "Jamie", features }, { id: "c2", display_name: null, features: { bingo: true } }], error: null }).then(res);
        return Promise.resolve({ data: [], error: null }).then(res);
      },
    });
    return q;
  },
};
const session = {
  auth: { getUser: async () => ({ data: { user: signedIn ? { id: "c1" } : null }, error: null }) },
  rpc: async (name: string, args: Record<string, unknown>) => { permissionCalls.push({ name, args }); return { data: allowed, error: permissionError }; },
  from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { features }, error: null }) }) }) }),
};
mock.module("@/lib/supabase/server", { namedExports: { isSupabaseConfigured: () => true, createClient: async () => session, createServiceClient: () => svc } });
mock.module("@/lib/auth/adminCheck", { namedExports: { isActiveAdmin: async () => admin } });
mock.module("@/lib/afterResponse", { namedExports: { runAfterResponse: (task: () => Promise<unknown>) => { void task(); } } });

async function main() {
  const { requestGameUnlock, listGameUnlockRequests, buildGameUnlockAlertEmail, sendGameUnlockAlert, unlockRequestId } = await import("./gameUnlock");
  const alert = async (game: string) => { alerts.push(game); };

  check("an unknown game is a bad request", "error" in (await requestGameUnlock("poker", { alert })) && (await requestGameUnlock("poker", { alert }) as { error: string }).error === "bad_request");
  features = { scratch: true };
  check("a game that is already on is refused", (await requestGameUnlock("scratch", { alert }) as { error: string }).error === "already_enabled");
  features = {};
  let r = await requestGameUnlock("bingo", { alert });
  await new Promise((resolve) => setTimeout(resolve, 0));
  check("the session proved can_act_for(self, 'manage') before the service role was touched", permissionCalls.length >= 1 && permissionCalls.every((c) => c.name === "can_act_for" && c.args.target_creator === "c1" && c.args.perm === "manage"));
  check("the request is stored and the admins are alerted", "ok" in r && r.recorded && !r.already && inserted.length === 1 && (inserted[0] as { kind: string; details: { game: string } }).kind === "game_unlock_request" && alerts.join() === "bingo");
  notices = [{ id: "n1", creator_id: "c1", details: { game: "bingo" }, created_at: "2026-11-10T00:00:00Z" }];
  r = await requestGameUnlock("bingo", { alert });
  check("a repeat ask within the window is answered as the earlier one, with no new row or mail", "ok" in r && r.already && inserted.length === 1 && alerts.length === 1);
  notices = [];
  insertError = { code: "23514", message: "new row violates check constraint creator_notices_kind_check" };
  r = await requestGameUnlock("scratch", { alert });
  await new Promise((resolve) => setTimeout(resolve, 0));
  check("a row the database refuses still sends the e-mail and the answer says recorded:false", "ok" in r && !r.recorded && alerts.join() === "bingo,scratch");
  insertError = null;

  // --- only an account in good standing may ask (no service call, no mail) ---
  const refusedCleanly = async (label: string, expected: string) => {
    const servicesBefore = serviceCalls;
    const rowsBefore = inserted.length;
    const alertsBefore = alerts.length;
    const out = await requestGameUnlock("scratch", { alert });
    await new Promise((resolve) => setTimeout(resolve, 0));
    check(`${label}: refused as ${expected}, the service role untouched, nothing stored, nobody e-mailed`,
      "error" in out && out.error === expected && serviceCalls === servicesBefore && inserted.length === rowsBefore && alerts.length === alertsBefore);
  };
  allowed = false;
  await refusedCleanly("a suspended account (can_act_for false)", "forbidden");
  allowed = null;
  await refusedCleanly("an unapproved account (can_act_for null)", "forbidden");
  allowed = "true";
  await refusedCleanly("a truthy answer that is not the literal true", "forbidden");
  allowed = true;
  permissionError = { code: "42501" };
  await refusedCleanly("a permission read that failed", "forbidden");
  permissionError = null;
  signedIn = false;
  const permissionsBefore = permissionCalls.length;
  await refusedCleanly("a signed-out request", "unauthorized");
  check("signed out: not even the permission check runs", permissionCalls.length === permissionsBefore);
  signedIn = true;

  // --- two asks that arrive together store one row and send one mail ---
  {
    storedIds.clear();
    const rowsBefore = inserted.length;
    const alertsBefore = alerts.length;
    const [a, b] = await Promise.all([requestGameUnlock("scratch", { alert }), requestGameUnlock("scratch", { alert })]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    check("concurrent double: one row", inserted.length === rowsBefore + 1);
    check("concurrent double: one e-mail", alerts.length === alertsBefore + 1);
    check("concurrent double: one answer is the new request, the other the earlier one", "ok" in a && "ok" in b && [a.already, b.already].sort().join() === "false,true" && a.recorded && b.recorded);
    const now = Date.UTC(2026, 10, 10);
    check("the row id is stable for a creator, game and window", unlockRequestId("c1", "scratch", now) === unlockRequestId("c1", "scratch", now + 60_000));
    check("…and differs by creator, game and window", new Set([unlockRequestId("c1", "scratch", now), unlockRequestId("c2", "scratch", now), unlockRequestId("c1", "bingo", now), unlockRequestId("c1", "scratch", now + 8 * 86_400_000)]).size === 4);
    check("it is a well-formed UUID", /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(unlockRequestId("c1", "scratch", now)));
  }

  // 0073: one OPEN request per creator and game (unique index). An older
  // request outside the window answers 23505: already asked, nobody mailed.
  {
    const rowsBefore = inserted.length;
    const alertsBefore = alerts.length;
    insertError = { code: "23505", message: 'duplicate key value violates unique constraint "creator_notices_unlock_request_key"' };
    const again = await requestGameUnlock("scratch", { alert });
    await new Promise((resolve) => setTimeout(resolve, 5));
    insertError = null;
    check("an older open request (23505) → already requested", "ok" in again && again.already === true && again.recorded === true);
    check("…with no second row and no second e-mail", inserted.length === rowsBefore && alerts.length === alertsBefore);
  }

  notices = [
    { id: "n2", creator_id: "c1", details: { game: "scratch" }, created_at: "2026-11-10T01:00:00Z" },
    { id: "n3", creator_id: "c1", details: { game: "scratch" }, created_at: "2026-11-09T01:00:00Z" },
    { id: "n4", creator_id: "c2", details: { game: "bingo" }, created_at: "2026-11-08T01:00:00Z" },
    { id: "n5", creator_id: "c1", details: { game: "poker" }, created_at: "2026-11-08T01:00:00Z" },
  ];
  check("a non-admin sees no requests", (await listGameUnlockRequests(session as never, svc as never)).length === 0);
  admin = true;
  const list = await listGameUnlockRequests(session as never, svc as never);
  check("an admin sees one open request per creator and game, named, without games already on or unknown games", list.length === 1 && list[0].creatorName === "Jamie" && list[0].game === "scratch" && list[0].id === "n2");

  const mail = buildGameUnlockAlertEmail("https://ff.example", "scratch");
  check("the e-mail names no creator and links to Admin", /scratch tickets/.test(mail.subject) && !/Jamie|c1/.test(JSON.stringify(mail)) && /section=admin/.test(JSON.stringify(mail)));
  const sent: string[][] = [];
  const outcome = await sendGameUnlockAlert("bingo", { cfg: { apiKey: "k", from: "a@b.c" } as never, to: ["admin@example.com"], send: async (_c, to) => { sent.push(to); return true; }, environment: "production" });
  check("the alert goes to ALERT_EMAIL_TO", outcome === "sent" && sent[0]?.[0] === "admin@example.com");
  check("without a mail key the alert is skipped, never thrown", (await sendGameUnlockAlert("bingo", { cfg: { apiKey: null, from: null } as never, to: ["x@y.z"], environment: "production" })) === "skipped");
  console.log(`gameUnlock: ${passed} checks passed`);
}
main().catch((error) => { console.error(error); process.exit(1); });
