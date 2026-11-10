/**
 * AUTH-SENSITIVE (AGENTS.md rules 3/5/7): batch-6 onboarding surfaces.
 *
 *   POST/PATCH /api/creator-application  (C6, C21)
 *   POST /api/admin/applications          (C7: reject with a reason, approve as undo)
 *   getMyRejectionReason / the admin bell source (C7, C6)
 *   agency invitation e-mail              (C10)
 *
 * Negative tests: a signed-out caller is refused; the applicant's edit is
 * pinned to their OWN, still-PENDING row whatever the body says; a second
 * submit never overwrites; a normal creator cannot decide requests; a reject
 * cannot carry free text or touch an approved account; the reason read is
 * pinned to the session user; an agency e-mail goes out only for a NEW
 * invitation the owner's RPC created.
 */
import assert from "node:assert";
import { mock } from "node:test";

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

const ME = "aaaaaaaa-0000-4000-8000-000000000001";
const OTHER = "bbbbbbbb-0000-4000-8000-000000000002";
type Op = { name: string; args: unknown[] };
type Call = { client: "session" | "service"; table: string; ops: Op[] };
const calls: Call[] = [];
let user: { id: string; email: string } | null = { id: ME, email: "me@example.com" };
let isAdmin = false;
// Per-test answers: (call) => { data, error }.
let answer: (c: Call) => { data: unknown; error: unknown } = () => ({ data: null, error: null });
const after: (() => unknown)[] = [];
/** The caller's own profiles.is_active as the session reads it (undefined = no row). */
let ownActive: unknown = true;
let standingReads = 0;

function builder(client: Call["client"], table: string) {
  const call: Call = { client, table, ops: [] };
  calls.push(call);
  const proxy: unknown = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then") return (res: (v: unknown) => unknown) => {
          // The session's read of its OWN is_active (S3/S5/S6) is not part of
          // the per-test answers, and is taken out of the recorded calls.
          if (client === "session" && table === "profiles" && has(call, "select", "is_active")) {
            standingReads++;
            calls.splice(calls.indexOf(call), 1);
            return Promise.resolve({ data: ownActive === undefined ? null : { is_active: ownActive }, error: null }).then(res);
          }
          return Promise.resolve(answer(call)).then(res);
        };
        return (...args: unknown[]) => {
          call.ops.push({ name: String(prop), args });
          return proxy;
        };
      },
    }
  );
  return proxy;
}
const op = (c: Call, name: string) => c.ops.filter((o) => o.name === name);
const has = (c: Call, name: string, ...args: unknown[]) => op(c, name).some((o) => JSON.stringify(o.args) === JSON.stringify(args));

const session = () => ({
  from: (t: string) => builder("session", t),
  rpc: async (name: string, args: Record<string, unknown>) => {
    if (name === "is_admin") return { data: isAdmin, error: null };
    calls.push({ client: "session", table: `rpc:${name}`, ops: [{ name: "rpc", args: [args] }] });
    return answer({ client: "session", table: `rpc:${name}`, ops: [] });
  },
  auth: {
    getUser: async () => ({ data: { user }, error: null }),
    getSession: async () => ({ data: { session: { access_token: `h.${Buffer.from(JSON.stringify({ aal: "aal2" })).toString("base64url")}.s` } } }),
  },
});
mock.module("@/lib/supabase/server", {
  namedExports: {
    isSupabaseConfigured: () => true,
    createClient: async () => session(),
    createServiceClient: () => ({ from: (t: string) => builder("service", t), rpc: async () => ({ data: "2026-11-01T00:00:00Z", error: null }) }),
  },
});
mock.module("@/lib/afterResponse", { namedExports: { runAfterResponse: (task: () => unknown) => void after.push(task) } });

async function main() {
  const app = await import("@/app/api/creator-application/route");
  const decide = await import("@/app/api/admin/applications/route");
  const data = await import("@/lib/data");
  const req = (method: string, body: unknown, ip = "10.1.0.1") =>
    new Request("http://x/api", { method, headers: { "Content-Type": "application/json", "x-real-ip": ip }, body: JSON.stringify(body) });
  const json = async (r: Response) => ({ status: r.status, data: (await r.json()) as Record<string, unknown> });
  const reset = () => {
    calls.length = 0;
    after.length = 0;
  };

  // --- C6/C21: first submit inserts and tells the admins; a second never overwrites
  reset();
  answer = () => ({ data: null, error: null });
  let r = await json(await app.POST(req("POST", { displayName: "Bella", socials: "x", audienceSize: "5k", acceptTerms: true })));
  const insert = calls.find((c) => c.table === "creator_applications");
  check("submit → 200", r.status === 200);
  check("submit inserts (never upserts) the session user's row", !!insert && op(insert, "insert").length === 1 && op(insert, "upsert").length === 0 && (op(insert, "insert")[0].args[0] as { profile_id: string }).profile_id === ME);
  check("a new request schedules one admin notice (C6)", after.length === 1);
  reset();
  answer = (c) => (c.table === "creator_applications" ? { data: null, error: { code: "23505", message: "duplicate" } } : { data: null, error: null });
  r = await json(await app.POST(req("POST", { displayName: "Bella", socials: "x", audienceSize: "5k", acceptTerms: true }, "10.1.0.2")));
  check("a second submit → 409 already_submitted, nothing overwritten", r.status === 409 && r.data.error === "already_submitted");
  check("…and no second admin notice", after.length === 0);

  // --- C21: PATCH edits only the caller's own pending row
  reset();
  answer = (c) => (c.client === "service" ? { data: { id: "app-1" }, error: null } : { data: null, error: null });
  r = await json(await app.PATCH(req("PATCH", { displayName: "Bella B", profileId: OTHER, status: "approved", socials: "y" }, "10.1.0.3")));
  const upd = calls.find((c) => c.client === "service" && c.table === "creator_applications");
  check("edit → 200", r.status === 200);
  check("edit is pinned to the session user, not the body's profileId", !!upd && has(upd, "eq", "profile_id", ME) && !JSON.stringify(upd.ops).includes(OTHER));
  check("edit only touches a still-pending row", !!upd && has(upd, "eq", "status", "pending"));
  check("edit never writes status, profile_id or email", !!upd && !/status|profile_id|email/.test(JSON.stringify(op(upd, "update")[0].args[0])));
  reset();
  answer = () => ({ data: null, error: null });
  r = await json(await app.PATCH(req("PATCH", { displayName: "X" }, "10.1.0.4")));
  check("no pending row of mine → 404, nothing changed", r.status === 404);

  // --- S3/S5: a SUSPENDED account sends and edits nothing, and no admin is e-mailed
  for (const [label, value, status] of [["suspended", false, 403], ["no readable profile", undefined, 400], ["a non-boolean is_active", "true", 400]] as const) {
    ownActive = value;
    reset();
    answer = (c) => (c.client === "service" ? { data: { id: "app-1" }, error: null } : { data: null, error: null });
    r = await json(await app.POST(req("POST", { displayName: "Bella", socials: "x", audienceSize: "5k", acceptTerms: true }, "10.1.1.1")));
    check(`${label}: submit → ${status}`, r.status === status && (status !== 403 || r.data.error === "forbidden"));
    check(`${label}: submit writes no request, uses no service role, schedules no admin notice`, calls.length === 0 && after.length === 0);
    reset();
    r = await json(await app.PATCH(req("PATCH", { displayName: "Bella B", socials: "y" }, "10.1.1.2")));
    check(`${label}: edit → ${status}`, r.status === status && (status !== 403 || r.data.error === "forbidden"));
    check(`${label}: edit touches no table and schedules no admin notice`, calls.length === 0 && after.length === 0);
  }
  check("the standing was read from the session's own profile row", standingReads > 0);
  ownActive = true;

  user = null;
  reset();
  r = await json(await app.PATCH(req("PATCH", { displayName: "X" }, "10.1.0.5")));
  check("signed out edit → 401 and the service role is never used", r.status === 401 && !calls.some((c) => c.client === "service"));
  r = await json(await app.POST(req("POST", { displayName: "X", acceptTerms: true }, "10.1.0.6")));
  check("signed out submit → 401", r.status === 401);

  // --- C7: only an active admin decides; reasons are fixed codes
  user = { id: ME, email: "me@example.com" };
  isAdmin = false;
  reset();
  r = await json(await decide.POST(req("POST", { profileId: OTHER, decision: "rejected" })));
  check("a normal creator cannot reject → 403", r.status === 403 && !calls.some((c) => c.table === "profiles" || c.table === "creator_applications"));
  r = await json(await decide.POST(req("POST", { profileId: ME, decision: "approved" })));
  check("…nor approve themselves → 403", r.status === 403 && !calls.some((c) => c.table === "profiles"));
  isAdmin = true;
  reset();
  r = await json(await decide.POST(req("POST", { profileId: OTHER, decision: "rejected", reason: "You are not a fit, Bella (bella@x.com)" })));
  check("free-text reason → 400 invalid_reason, nothing decided", r.status === 400 && r.data.error === "invalid_reason" && calls.length === 0);
  r = await json(await decide.POST(req("POST", { profileId: OTHER, decision: "approved", reason: "unverified" })));
  check("a reason on an approve → 400", r.status === 400 && calls.length === 0);
  reset();
  answer = (c) => (c.table === "profiles" ? { data: { id: OTHER }, error: null } : { data: null, error: null });
  r = await json(await decide.POST(req("POST", { profileId: OTHER, decision: "rejected", reason: "unverified" })));
  const prof = calls.find((c) => c.table === "profiles");
  const audit = calls.find((c) => c.table === "admin_audit_log");
  check("reject → 200", r.status === 200);
  check("reject never touches an approved account", !!prof && has(prof, "neq", "approval_status", "approved"));
  check("the reason code is logged with the reject", !!audit && JSON.stringify(op(audit, "insert")[0].args[0]).includes('"reason":"unverified"'));
  reset();
  answer = () => ({ data: null, error: null });
  r = await json(await decide.POST(req("POST", { profileId: OTHER, decision: "rejected" })));
  check("rejecting an already-approved account → 409, application untouched", r.status === 409 && r.data.error === "already_approved" && !calls.some((c) => c.table === "creator_applications"));

  // --- C7: the applicant's reason read is pinned to the session user
  reset();
  answer = (c) => (c.table === "admin_audit_log" ? { data: { details: { reason: "incomplete" } }, error: null } : { data: null, error: null });
  const reason = await data.getMyRejectionReason();
  const read = calls.find((c) => c.table === "admin_audit_log");
  check("reason read returns the code", reason === "incomplete");
  check("…for the session user's own rejects only", !!read && has(read, "eq", "target_id", ME) && has(read, "eq", "action", "account.reject"));
  user = null;
  reset();
  check("signed out → no reason and no service read", (await data.getMyRejectionReason()) === null && !calls.some((c) => c.client === "service"));
  user = { id: ME, email: "me@example.com" };

  // --- C10: an agency e-mail only for a NEW pending invitation
  const ORG = "cccccccc-0000-4000-8000-000000000003";
  let pending: string | null = null;
  let rpcAnswer = "ok";
  let createsInvite = true;
  answer = (c) => {
    if (c.table === "org_invites") return { data: pending ? { id: pending } : null, error: null };
    if (c.table === "orgs") return { data: { name: "Acme <b>" }, error: null };
    if (c.table.startsWith("rpc:")) {
      if (createsInvite && rpcAnswer === "ok") pending = `inv-${Math.random()}`;
      return { data: rpcAnswer, error: null };
    }
    return { data: null, error: null };
  };
  reset();
  let res = await data.inviteOrgCreator(ORG, " New@Example.com ");
  check("a new invitation → ok and one e-mail queued", "ok" in res && after.length === 1);
  const inviteRead = calls.find((c) => c.table === "org_invites");
  check("the invitation is looked up by the normalized address on the owner's session", !!inviteRead && inviteRead.client === "session" && has(inviteRead, "eq", "email", "new@example.com"));
  reset();
  createsInvite = false;
  res = await data.inviteOrgCreator(ORG, "new@example.com");
  check("a repeat for a still-pending invitation sends nothing", "ok" in res && after.length === 0);
  // B2: a role switch replaces the pending invitation (new id); that must not
  // mail the same person again.
  reset();
  createsInvite = true;
  res = await data.addOrgMember(ORG, "new@example.com", "manager");
  check("a role switch on a still-pending invitation sends nothing (B2)", "ok" in res && after.length === 0);
  check("…the earlier invite is only counted while unexpired", calls.some((c) => c.table === "org_invites" && op(c, "gt").some((o) => o.args[0] === "expires_at")));
  reset();
  createsInvite = true;
  rpcAnswer = "not_owner";
  res = await data.addOrgMember(ORG, "staff@example.com", "chatter");
  check("a refused invite (not the owner) sends nothing", "error" in res && res.error === "not_owner" && after.length === 0);

  // --- C6: the bell's request source reads pending requests of OTHER accounts
  const { buildNotificationFeed } = await import("@/lib/data/notificationFeed");
  const feed = buildNotificationFeed(
    { pendingWins: [], unreadMessages: [], lowStock: [], outOfSpins: [], applications: [{ id: "a1", name: "Bella", at: "2026-11-01T10:00:00Z" }] },
    null,
    { newSpin: false, lowBalance: false, messages: false }
  );
  check("an access request shows in the bell with every toggle off", feed.items.length === 1 && feed.items[0].kind === "application");
  check("…and opens Admin", feed.items[0].target.section === "admin");

  console.log(`onboardingAuthz.test: ${passed} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
