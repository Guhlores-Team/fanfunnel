import assert from "node:assert/strict";
import { mock } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// A45: the dashboard links to /agency only when the server says the viewer owns
// an agency, holds a staff seat, or is a creator an agency manages; everyone
// else gets no link (negative). The standing is read on the caller's own
// session (orgs / org_members / own profile, all under RLS), never from user
// or app metadata, and it is never an authorization input. A managed creator's
// /agency explains the agency instead of offering to start one.

const USER = "aaaaaaaa-0000-4000-8000-000000000045";
let configured = true;
let signedIn = true;
let world = { owns: 0, seats: 0, orgId: null as string | null };
const reads: { table: string; filters: [string, unknown][] }[] = [];

function session() {
  const from = (table: string) => {
    const entry = { table, filters: [] as [string, unknown][] };
    reads.push(entry);
    const q = {
      select: () => q,
      eq: (col: string, val: unknown) => { entry.filters.push([col, val]); return q; },
      maybeSingle: () => q,
      then: (res: (v: unknown) => unknown) => {
        const count = table === "orgs" ? world.owns : table === "org_members" ? world.seats : null;
        const data = table === "profiles" ? { org_id: world.orgId } : null;
        return Promise.resolve({ data, count, error: null }).then(res);
      },
    };
    return q;
  };
  return {
    auth: { getUser: async () => ({ data: { user: signedIn ? { id: USER, user_metadata: { role: "admin", agency: true }, app_metadata: { org: "x" } } : null }, error: null }) },
    from,
    rpc: async () => { throw new Error("the agency standing never calls an RPC"); },
  };
}
mock.module("@/lib/supabase/server", {
  namedExports: { isSupabaseConfigured: () => configured, createClient: async () => session(), createServiceClient: () => { throw new Error("never the service role"); } },
});
mock.module("@/lib/data", {
  namedExports: { getAgencyOverview: async () => null },
});

let passed = 0;
const check = (label: string, cond: unknown) => { assert.ok(cond, label); passed++; };

async function main() {
  const { showAgencyLink, getAgencyStanding } = await import("./seatScope");

  world = { owns: 0, seats: 0, orgId: null };
  reads.length = 0;
  check("a plain creator (no agency, no seat) gets no Agency link, whatever their metadata says", (await showAgencyLink()) === false);
  check("…read from orgs, org_members and the caller's own profile, each filtered to the caller", ["orgs", "org_members", "profiles"].every((t) => reads.some((r) => r.table === t && r.filters.some(([, v]) => v === USER))));
  world = { owns: 1, seats: 0, orgId: null };
  check("an agency owner gets the link", (await showAgencyLink()) === true);
  world = { owns: 0, seats: 1, orgId: null };
  check("a staff seat gets the link", (await showAgencyLink()) === true);
  world = { owns: 0, seats: 0, orgId: "f0000000-0000-4000-8000-000000000001" };
  check("a creator an agency manages gets the link", (await showAgencyLink()) === true);
  const standing = await getAgencyStanding();
  check("…and its standing says so (inAgency only)", standing?.inAgency === true && !standing.ownsOrg && !standing.hasSeat);
  check("…with the agency's id from the caller's own profile (to leave it)", standing?.creatorOrgId === "f0000000-0000-4000-8000-000000000001");
  signedIn = false;
  check("signed out: no link and no standing", (await showAgencyLink()) === false && (await getAgencyStanding()) === null);
  signedIn = true;
  configured = false;
  check("demo: the link shows (its /agency explains agencies, nothing is saved)", (await showAgencyLink()) === true);
  configured = true;

  // /api/agency for someone without a console of their own.
  const { GET } = await import("@/app/api/agency/route");
  const req = () => new Request("http://localhost/api/agency");
  world = { owns: 0, seats: 0, orgId: "f0000000-0000-4000-8000-000000000001" };
  const managed = (await (await GET(req())).json()) as { org: unknown; managed?: boolean; orgId?: string; ownerActive?: unknown };
  check("/api/agency: a managed creator gets the managed notice, not the start-an-agency form", managed.org === null && managed.managed === true && managed.orgId === "f0000000-0000-4000-8000-000000000001");
  check("/api/agency: …with the owner's standing when the session may read it (null = unknown), never a guess", managed.ownerActive === null || typeof managed.ownerActive === "boolean");
  world = { owns: 0, seats: 0, orgId: null };
  check("/api/agency: anyone else still gets null (start an agency)", (await (await GET(req())).json()) === null);

  // Wiring: the gate is server-derived and only decides whether the link exists.
  const root = join(import.meta.dirname, "../../..");
  const read = (p: string) => readFileSync(join(root, p), "utf8");
  const page = read("src/app/dashboard/page.tsx");
  check("dashboard page derives showAgency on the server and passes it down", /showAgencyLink\(\)/.test(page) && /showAgency=\{showAgency\}/.test(page));
  const shell = read("src/components/dashboard/DashboardShell.tsx");
  const sheet = read("src/components/dashboard/MoreSheet.tsx");
  check("sidebar and More sheet render the Agency link only in Account and only when showAgency", /g\.title === "Account" && showAgency && \(/.test(shell) && /g\.title === "Account" && showAgency && \(/.test(sheet));
  check("the Agency link is a full page load to /agency", /<a href="\/agency" data-testid="nav-agency"/.test(shell));
  const client = read("src/components/dashboard/DashboardClient.tsx");
  check("both the sidebar and the phone tab bar get the gate", (client.match(/showAgency=\{showAgency\}/g) ?? []).length === 2);
  check("accepting an invite links to /agency", /href="\/agency"/.test(read("src/components/dashboard/InvitesBanner.tsx")) && /setJoined\(/.test(read("src/components/dashboard/InvitesBanner.tsx")));
  const agency = read("src/components/agency/AgencyClient.tsx");
  check("the seat form says staff need an approved account first", /data-testid="seat-onboarding-help"/.test(agency) && /approved creator account first/.test(agency) && /admin approves it/.test(agency));
  check("/agency and the seat workspace use the redesign tokens, not the legacy dark palette", !/zinc-|text-white|bg-white\/|border-white\//.test(agency + read("src/components/agency/SeatWorkspace.tsx") + read("src/app/agency/page.tsx")));

  console.log(`agencyNav.test: ${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
