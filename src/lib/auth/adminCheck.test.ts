// Negative tests for the shared admin predicate (AGENTS.md rule 2 / rule 7):
// a profile with role=admin but is_active=false must be refused, is_admin() is
// authoritative when it answers, and nothing is ever decided from metadata.
import assert from "node:assert/strict";
import { checkAdmin, isActiveAdmin, type AdminCheckClient } from "./adminCheck";

type Result = { data: unknown; error: unknown };

function fake(opts: {
  user: { id: string } | null;
  rpc?: Result;
  profile?: Result;
}) {
  const calls: string[] = [];
  // Only the three members checkAdmin() touches; cast once to the real client slice.
  const fakeClient = {
    auth: {
      async getUser() {
        calls.push("getUser");
        return { data: { user: opts.user } };
      },
    },
    rpc(fn: string) {
      calls.push(`rpc:${fn}`);
      return Promise.resolve(opts.rpc ?? { data: null, error: { message: "rpc unavailable" } });
    },
    from(table: string) {
      return {
        select(columns: string) {
          return {
            eq(column: string, value: string) {
              return {
                maybeSingle() {
                  calls.push(`${table}.select(${columns}).eq(${column},${value})`);
                  return Promise.resolve(opts.profile ?? { data: null, error: null });
                },
              };
            },
          };
        },
      };
    },
  };
  const client = fakeClient as unknown as AdminCheckClient;
  return { client, calls };
}

const RPC_DOWN: Result = { data: null, error: { message: "permission denied for function is_admin" } };
let passed = 0;

async function run() {
  // Anonymous: refused before any database access.
  {
    const { client, calls } = fake({ user: null });
    assert.deepEqual(await checkAdmin(client), { status: "anonymous" });
    assert.deepEqual(calls, ["getUser"]);
    passed++;
  }

  // is_admin() says yes → admin, and the profiles row is never consulted.
  {
    const { client, calls } = fake({ user: { id: "u1" }, rpc: { data: true, error: null } });
    assert.deepEqual(await checkAdmin(client), { status: "admin", userId: "u1" });
    assert.deepEqual(calls, ["getUser", "rpc:is_admin"]);
    passed++;
  }

  // is_admin() says no → refused even if a row read WOULD have said admin+active.
  // The SECURITY DEFINER function is the contract; nothing overrides it.
  {
    const { client, calls } = fake({
      user: { id: "u1" },
      rpc: { data: false, error: null },
      profile: { data: { role: "admin", is_active: true }, error: null },
    });
    assert.deepEqual(await checkAdmin(client), { status: "not_admin", userId: "u1" });
    assert.deepEqual(calls, ["getUser", "rpc:is_admin"]);
    passed++;
  }

  // THE negative test: RPC unavailable, row says role=admin but is_active=false
  // (a suspended admin) → refused.
  {
    const { client, calls } = fake({
      user: { id: "u1" },
      rpc: RPC_DOWN,
      profile: { data: { role: "admin", is_active: false }, error: null },
    });
    assert.deepEqual(await checkAdmin(client), { status: "not_admin", userId: "u1" });
    assert.equal(await isActiveAdmin(client), false);
    // The fallback must read is_active (a role-only read is the bug HARD-5 fixes)
    // and must scope the read to the caller's own row.
    assert.ok(calls.includes("profiles.select(role, is_active).eq(id,u1)"), calls.join(" | "));
    passed++;
  }

  // Fallback, active admin → admin.
  {
    const { client } = fake({
      user: { id: "u2" },
      rpc: RPC_DOWN,
      profile: { data: { role: "admin", is_active: true }, error: null },
    });
    assert.deepEqual(await checkAdmin(client), { status: "admin", userId: "u2" });
    assert.equal(await isActiveAdmin(client), true);
    passed++;
  }

  // Fallback: active creator is not an admin; is_active alone never grants.
  {
    const { client } = fake({
      user: { id: "u3" },
      rpc: RPC_DOWN,
      profile: { data: { role: "creator", is_active: true }, error: null },
    });
    assert.equal(await isActiveAdmin(client), false);
    passed++;
  }

  // Fallback: ambiguity fails closed — no row, a row with is_active missing,
  // is_active as a truthy non-boolean, or a read error.
  for (const profile of [
    { data: null, error: null },
    { data: { role: "admin" }, error: null },
    { data: { role: "admin", is_active: "true" }, error: null },
    { data: { role: "admin", is_active: true }, error: { message: "boom" } },
  ] as Result[]) {
    const { client } = fake({ user: { id: "u4" }, rpc: RPC_DOWN, profile });
    assert.equal(await isActiveAdmin(client), false, JSON.stringify(profile));
    passed++;
  }

  // A non-boolean RPC answer (e.g. null) counts as "unavailable", not as "yes".
  {
    const { client, calls } = fake({
      user: { id: "u5" },
      rpc: { data: null, error: null },
      profile: { data: { role: "admin", is_active: false }, error: null },
    });
    assert.equal(await isActiveAdmin(client), false);
    assert.equal(calls.length, 3, "fell back to the row read");
    passed++;
  }
}

run()
  .then(() => console.log(`adminCheck.test: ${passed} checks passed`))
  .catch((err) => {
    console.error("  ✗", err instanceof Error ? err.message : err);
    process.exit(1);
  });
