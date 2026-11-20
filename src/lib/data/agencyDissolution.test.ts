import assert from "node:assert";
import { mock } from "node:test";

// AUTH-SENSITIVE (S1): "your agency was dissolved" notices and the
// org.dissolve activity entry are written with the service role. They must
// describe something that happened: written only after the deletion is
// accepted, once per person and once per agency however often the close is
// retried, and never when an admin's dissolve fails.

let passed = 0;
const check = (label: string, cond: unknown) => {
  assert.ok(cond, label);
  passed++;
};

const OWNER = "11111111-1111-4111-8111-111111111111";
const SEAT = "22222222-2222-4222-8222-222222222222";
const MANAGED = "33333333-3333-4333-8333-333333333333";
const ORG = "44444444-4444-4444-8444-444444444444";
const ADMIN = "55555555-5555-4555-8555-555555555555";

type Row = Record<string, unknown>;
const tables: Record<string, Row[]> = {};
let orgDeleteFails = false;
let isAdmin = true;

/** A service client with the one behaviour that matters here: a primary key keeps one row. */
function service() {
  return {
    from(table: string) {
      const rows = (tables[table] ??= []);
      const filters: [string, unknown][] = [];
      let op: "select" | "delete" = "select";
      const run = () => {
        const hit = (r: Row) => filters.every(([k, v]) => r[k] === v);
        if (op === "delete") {
          if (table === "orgs" && orgDeleteFails) return { data: null, error: { code: "XX000", message: "boom" } };
          tables[table] = rows.filter((r) => !hit(r));
          return { data: null, error: null };
        }
        return { data: rows.filter(hit), error: null };
      };
      const q = {
        select: () => q,
        eq: (k: string, v: unknown) => (filters.push([k, v]), q),
        limit: () => q,
        delete: () => ((op = "delete"), q),
        maybeSingle: async () => ({ data: (run().data as Row[] | null)?.[0] ?? null, error: null }),
        insert: async (row: Row) => (rows.push({ ...row }), { data: null, error: null }),
        upsert: (list: Row[], options: { onConflict?: string; ignoreDuplicates?: boolean }) => ({
          select: async () => {
            assert.equal(options.onConflict, "id");
            assert.equal(options.ignoreDuplicates, true);
            const fresh = list.filter((r) => !rows.some((x) => x.id === r.id));
            rows.push(...fresh.map((r) => ({ ...r })));
            return { data: fresh.map((r) => ({ id: r.id })), error: null };
          },
        }),
        then: (resolve: (v: unknown) => void) => resolve(run()),
      };
      return q;
    },
  };
}

mock.module("@/lib/supabase/server", {
  namedExports: {
    isSupabaseConfigured: () => true,
    createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: ADMIN } } }) } }),
    createServiceClient: () => service(),
  },
});
mock.module("@/lib/auth/adminCheck", { namedExports: { isActiveAdmin: async () => isAdmin } });

const seed = () => {
  tables.orgs = [{ id: ORG, name: "Northside", owner_id: OWNER }];
  tables.org_members = [{ id: "m-owner", org_id: ORG, profile_id: OWNER }, { id: "m-seat", org_id: ORG, profile_id: SEAT }];
  tables.profiles = [{ id: OWNER, org_id: ORG }, { id: SEAT, org_id: null }, { id: MANAGED, org_id: ORG }];
  tables.creator_notices = [];
  tables.admin_audit_log = [];
};
const dissolveEntries = () => (tables.admin_audit_log ?? []).filter((r) => r.action === "org.dissolve");

async function main() {
  const { agencyImpactForOwner, recordAgencyDissolved, dissolvedNoticeId, adminAgencyAction } = await import("./agencyAdmin");
  type Svc = Parameters<typeof agencyImpactForOwner>[0];
  const svc = service() as unknown as Svc;

  seed();
  const impact = await agencyImpactForOwner(svc, OWNER);
  check("the impact names the seat and the managed creator, never the owner", !!impact && impact.seats === 1 && impact.creators === 1 && impact.memberIds[0] === SEAT && impact.creatorIds[0] === MANAGED);
  check("reading the impact writes nothing", tables.creator_notices.length === 0 && tables.admin_audit_log.length === 0);
  check("an account that owns no agency has no impact", (await agencyImpactForOwner(svc, SEAT)) === null);

  await recordAgencyDissolved(svc, null, OWNER, "self_close");
  check("no agency → nothing announced", tables.creator_notices.length === 0 && tables.admin_audit_log.length === 0);

  await recordAgencyDissolved(svc, impact, OWNER, "self_close");
  check("accepted close → one notice each for the seat and the managed creator", tables.creator_notices.length === 2 && tables.creator_notices.every((n) => n.kind === "agency_dissolved"));
  check("the notice keys are derived from the agency and the person", tables.creator_notices.some((n) => n.id === dissolvedNoticeId(ORG, SEAT) && n.creator_id === SEAT) && tables.creator_notices.some((n) => n.id === dissolvedNoticeId(ORG, MANAGED) && n.creator_id === MANAGED));
  check("one org.dissolve entry counting who was told", dissolveEntries().length === 1 && (dissolveEntries()[0].details as { notified?: number }).notified === 2);

  // The close answered "pending" and is retried until it finishes.
  await recordAgencyDissolved(svc, impact, OWNER, "self_close");
  await recordAgencyDissolved(svc, impact, OWNER, "self_close");
  check("a retried close leaves still one notice per person", tables.creator_notices.length === 2);
  check("…and still one activity entry", dissolveEntries().length === 1);

  check("the key is a stable UUID, different per person and per agency", /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(dissolvedNoticeId(ORG, SEAT)) && dissolvedNoticeId(ORG, SEAT) === dissolvedNoticeId(ORG, SEAT) && dissolvedNoticeId(ORG, SEAT) !== dissolvedNoticeId(ORG, MANAGED) && dissolvedNoticeId(ORG, SEAT) !== dissolvedNoticeId(OWNER, SEAT));

  // Admin dissolve: nobody is told when the delete fails.
  seed();
  orgDeleteFails = true;
  let outcome = await adminAgencyAction({ action: "dissolve", orgId: ORG, confirmName: "northside" });
  check("a failed admin dissolve → db_error", "error" in outcome && outcome.error === "db_error");
  check("…and no notice for an agency that still exists", tables.creator_notices.length === 0 && tables.orgs.length === 1);
  orgDeleteFails = false;
  outcome = await adminAgencyAction({ action: "dissolve", orgId: ORG, confirmName: "wrong name" });
  check("a wrong confirmation name tells nobody", "error" in outcome && outcome.error === "name_mismatch" && tables.creator_notices.length === 0);
  isAdmin = false;
  outcome = await adminAgencyAction({ action: "dissolve", orgId: ORG, confirmName: "Northside" });
  check("a non-admin is refused before anything is read or written", "error" in outcome && outcome.error === "unauthorized" && tables.creator_notices.length === 0 && tables.orgs.length === 1);
  isAdmin = true;
  outcome = await adminAgencyAction({ action: "dissolve", orgId: ORG, confirmName: "Northside" });
  check("an admin dissolve that succeeds tells the seat and the managed creator", "ok" in outcome && tables.orgs.length === 0 && tables.creator_notices.length === 2);
  check("…and hands back the org.dissolve entry for the route to write", "ok" in outcome && outcome.audit.action === "org.dissolve" && outcome.audit.targetId === ORG && (outcome.audit.details as { notified?: number }).notified === 2);

  console.log(`agency dissolution: ${passed} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
