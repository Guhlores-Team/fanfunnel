import assert from "node:assert";
import { mock } from "node:test";
import { FakeTables } from "@/lib/privacy/fakeTables";

// T4: Admin shows the age of each creator's oldest pending prize next to the
// pending count. Read with the admin's own session (RLS redemptions_select is
// is_admin()); only accounts with pending prizes are queried; a failed read
// leaves the age unknown and never breaks the panel.

let passed = 0;
function check(label: string, cond: unknown) {
  assert.ok(cond, label);
  passed++;
}

const tables = new FakeTables({
  redemptions: [
    { id: "r1", creator_id: "a", status: "pending", created_at: "2026-10-01T00:00:00Z" },
    { id: "r2", creator_id: "a", status: "pending", created_at: "2026-09-15T00:00:00Z" },
    { id: "r3", creator_id: "a", status: "fulfilled", created_at: "2026-08-01T00:00:00Z" },
    { id: "r4", creator_id: "b", status: "cancelled", created_at: "2026-08-01T00:00:00Z" },
    { id: "r5", creator_id: "c", status: "pending", created_at: "2026-11-01T00:00:00Z" },
  ],
});
const stat = (id: string, pending: number) => ({ id, email: `${id}@x.test`, display_name: id, role: "creator", is_active: true, features: {}, wheels: 1, fans: 1, spins: 1, pending });
mock.module("@/lib/supabase/server", {
  namedExports: {
    isSupabaseConfigured: () => true,
    createClient: async () => ({
      rpc: async () => ({ data: [stat("a", 2), stat("b", 0), stat("c", 1)], error: null }),
      from: (table: string) => tables.from(table),
    }),
    createServiceClient: () => { throw new Error("the admin panel must not use the service role"); },
  },
});

async function main() {
  const { getAdminOverview } = await import("./admin");
  const view = await getAdminOverview();
  const by = (id: string) => view!.accounts.find((a) => a.id === id)!;
  check("the oldest pending (not delivered) prize is picked", by("a").oldestPendingAt === "2026-09-15T00:00:00Z");
  check("an account with nothing pending is not queried", by("b").oldestPendingAt === undefined);
  check("each account gets its own oldest", by("c").oldestPendingAt === "2026-11-01T00:00:00Z");
  check("one read per account with pending prizes", tables.statements.filter((s) => s.table === "redemptions").length === 2);
  tables.failWhen = () => "read failed";
  const failed = await getAdminOverview();
  check("a failed read leaves the age unknown and keeps the panel", !!failed && failed.accounts.find((a) => a.id === "a")!.oldestPendingAt === null && failed.metrics.pending === 3);
  console.log(`adminOldestPending.test: ${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
