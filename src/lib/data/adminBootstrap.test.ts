// A17: claimAdmin is one atomic service RPC (bootstrap_first_admin, 0065). The
// route-side gates (allow-list, MFA step-up) run first; the RPC's answer is the
// only authority for "no admin exists yet", and any error fails closed. The
// database race itself is proven in scripts/db/hardeningProbe.mjs.
import assert from "node:assert/strict";
import { mock } from "node:test";
let checks = 0;
const check = (value: unknown, label: string) => { assert.ok(value, label); checks++; };
let outcome: { data: unknown; error: unknown } = { data: "ok", error: null };
const calls: { name: string; args: Record<string, unknown> }[] = [];
const audits: unknown[] = [];
let email = "Owner@Example.test";
const session = { auth: { getUser: async () => ({ data: { user: { id: "owner-id", email } } }) } };
mock.module("@/lib/supabase/server", { namedExports: {
  isSupabaseConfigured: () => true,
  createClient: async () => session,
  createServiceClient: () => ({
    rpc: async (name: string, args: Record<string, unknown>) => { calls.push({ name, args }); return outcome; },
    from: () => { throw Error("claimAdmin must not read or write profiles directly"); },
  }),
} });
mock.module("@/lib/auth/stepUp", { namedExports: { creatorMfaStepUpResponse: async () => null } });
mock.module("./audit", { namedExports: { recordAudit: async (entry: unknown) => { audits.push(entry); } } });

async function main() {
  process.env.ADMIN_EMAILS = "owner@example.test";
  const { claimAdmin } = await import("./admin");
  check("ok" in await claimAdmin(), "a winning claim succeeds");
  check(calls.length === 1 && calls[0].name === "bootstrap_first_admin" && calls[0].args.p_user === "owner-id" && calls[0].args.p_email === "owner@example.test", "one atomic RPC with the verified user id and its allow-listed email");
  check(audits.length === 1, "the success is audited once");
  for (const [answer, expected] of [["already_bootstrapped", "already_bootstrapped"], ["email_unconfirmed", "email_unconfirmed"], ["not_found", "db_error"], [null, "db_error"], ["surprise", "db_error"]] as const) {
    outcome = { data: answer, error: null };
    const result = await claimAdmin();
    check("error" in result && result.error === expected, `RPC answer ${String(answer)} maps to ${expected}`);
  }
  outcome = { data: null, error: { code: "57014", message: "statement timeout" } };
  const failed = await claimAdmin();
  check("error" in failed && failed.error === "db_error", "an RPC error fails closed (never treated as zero admins)");
  check(audits.length === 1, "no refusal or failure writes a bootstrap audit");
  email = "someone@example.test";
  const before = calls.length;
  const refused = await claimAdmin();
  check("error" in refused && refused.error === "not_allowed" && calls.length === before, "an address off the allow-list never reaches the RPC");
  console.log(`adminBootstrap.test: ${checks} checks passed`);
}
main().catch((error) => { console.error(error); process.exit(1); });
