import assert from "node:assert/strict";
import { mock } from "node:test";

// DB-04 / OPS-06: the accounts behind declined requests the cleanup removed
// are deleted through the durable deletion job, and only while the profile is
// still a declined creator applicant.
let passed = 0;
const check = (label: string, ok: unknown) => { assert.ok(ok, label); passed++; };

const A = "11111111-1111-4111-8111-111111111111", B = "22222222-2222-4222-8222-222222222222", C = "33333333-3333-4333-8333-333333333333";
const D = "44444444-4444-4444-8444-444444444444", E = "55555555-5555-4555-8555-555555555555", F = "66666666-6666-4666-8666-666666666666";
const calls: { id: string; options: Record<string, unknown> }[] = [];
let outcomes: Record<string, unknown> = {};
mock.module("./deleteAccount", { namedExports: { deleteAccountAndTombstoneLinks: async (_svc: unknown, id: string, options: Record<string, unknown>) => {
  calls.push({ id, options });
  const o = outcomes[id];
  if (o === "throw") throw new Error("boom");
  return o ?? { ok: true, links: 0, auditRecorded: true };
} } });

let profiles: { id: string; role: string; approval_status: string }[] = [];
let readError = false;
let asked: string[] = [];
let seatHolders: string[] = [];
let orgOwners: string[] = [];
let tieError = false;
const svc = { from: (table: string) => ({ select: () => ({ in: async (_col: string, ids: string[]) => {
  if (table === "org_members") return tieError ? { data: null, error: { message: "down" } } : { data: seatHolders.filter((id) => ids.includes(id)).map((profile_id) => ({ profile_id })), error: null };
  if (table === "orgs") return { data: orgOwners.filter((id) => ids.includes(id)).map((owner_id) => ({ owner_id })), error: null };
  assert.equal(table, "profiles"); asked = ids;
  return readError ? { data: null, error: { message: "down" } } : { data: profiles.filter((p) => ids.includes(p.id)), error: null };
} }) }) } as never;

async function main() {
  const { deleteDeclinedApplicants, DECLINED_APPLICANT_BATCH } = await import("./declinedApplicants");
  const rejected = (id: string) => ({ id, role: "creator", approval_status: "rejected" });

  for (const raw of [undefined, null, [], "x", {}]) {
    const r = await deleteDeclinedApplicants(svc, raw);
    check(`nothing due for ${JSON.stringify(raw)}: no read, no deletion`, r.due === 0 && r.failed === 0 && calls.length === 0);
  }

  profiles = [rejected(A), rejected(B), { id: C, role: "creator", approval_status: "approved" }, { id: D, role: "admin", approval_status: "rejected" }, rejected(E), rejected(F)];
  outcomes = { [B]: { pending: true, reason: "batch_remaining", reviewRequired: false }, [E]: { error: "suspended" }, [F]: "throw" };
  const r = await deleteDeclinedApplicants(svc, [A, B, C, D, E, F, A, "not-a-uuid", "99999999-9999-4999-8999-999999999999"]);
  check("a declined applicant's account is deleted through the shared deletion job", r.completed === 1 && calls.some((c) => c.id === A));
  check("…as a self-close for that account (the SQL begin accepts no other system actor)", calls.every((c) => c.options.action === "account.self_close" && c.options.actorId === c.id && c.options.wasAdmin === false));
  check("a deletion left to the storage/retry steps is pending, not failed", r.pending === 1);
  check("NEGATIVE: an applicant approved since is never deleted by age", !calls.some((c) => c.id === C));
  check("NEGATIVE: an admin is never deleted by age", !calls.some((c) => c.id === D));
  check("a profile that is already gone is left alone", !calls.some((c) => c.id.startsWith("9999")));
  check("kept counts the approved, the admin and the missing one", r.kept === 3);
  check("a suspended account (SQL refuses a self-close) and a thrown deletion are failures for an admin", r.failed === 2 && r.due === 7);
  check("duplicates are deleted once and malformed ids never reach the database", calls.filter((c) => c.id === A).length === 1 && !asked.includes("not-a-uuid"));

  calls.length = 0; readError = true;
  const down = await deleteDeclinedApplicants(svc, [A, B]);
  check("an unreadable profile table fails closed: nothing deleted, both reported", down.failed === 2 && calls.length === 0);
  readError = false;

  calls.length = 0; outcomes = {}; profiles = [rejected(A), rejected(B), rejected(C)]; seatHolders = [A]; orgOwners = [B];
  const tiedRun = await deleteDeclinedApplicants(svc, [A, B, C]);
  check("NEGATIVE: a declined applicant who holds an agency seat is never deleted by age", !calls.some((c) => c.id === A));
  check("NEGATIVE: a declined applicant who owns an agency is never deleted by age", !calls.some((c) => c.id === B));
  check("…while the plain applicant in the same run still is", tiedRun.completed === 1 && tiedRun.kept === 2 && calls.length === 1 && calls[0].id === C);
  calls.length = 0; tieError = true;
  const blind = await deleteDeclinedApplicants(svc, [C]);
  check("unreadable agency ties fail closed: nothing deleted, reported for an admin", blind.failed === 1 && calls.length === 0);
  tieError = false; seatHolders = []; orgOwners = [];

  calls.length = 0; outcomes = {};
  const many = Array.from({ length: DECLINED_APPLICANT_BATCH + 3 }, (_, i) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, "0")}`);
  profiles = many.map(rejected);
  const capped = await deleteDeclinedApplicants(svc, many);
  check("a run deletes at most one batch and reports the rest instead of dropping them", calls.length === DECLINED_APPLICANT_BATCH && capped.completed === DECLINED_APPLICANT_BATCH && capped.failed === 3);

  const src = (await import("node:fs")).readFileSync(new URL("./declinedApplicants.ts", import.meta.url), "utf8");
  check("the decision reads profiles only (server-controlled), never auth metadata", /from\("profiles"\)/.test(src) && !/user_metadata|app_metadata/.test(src));
  console.log(`declined applicants: ${passed} checks passed`);
}
main().catch((e) => { console.error(e); process.exit(1); });
