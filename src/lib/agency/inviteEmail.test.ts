import assert from "node:assert";
import { mock } from "node:test";

// B2 (batch 6 attack audit): agency invitation e-mails carry the owner's own
// org name, so they go only to an address that already has an active
// FanFunnel account, at most 3 times per address per 24 h across every
// agency. (A role switch sending nothing is checked in onboardingAuthz.test.)

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

const reads: { table: string; ops: [string, unknown[]][] }[] = [];
let accountRow: unknown = { id: "p1" };
const svc = {
  from(table: string) {
    const call = { table, ops: [] as [string, unknown[]][] };
    reads.push(call);
    const proxy: unknown = new Proxy({}, {
      get(_t, prop) {
        if (prop === "then") return (res: (v: unknown) => unknown) => Promise.resolve({ data: accountRow, error: null }).then(res);
        return (...args: unknown[]) => { call.ops.push([String(prop), args]); return proxy; };
      },
    });
    return proxy;
  },
};
mock.module("@/lib/supabase/server", { namedExports: { isSupabaseConfigured: () => true, createClient: async () => svc, createServiceClient: () => svc } });

async function main() {
  const { deliverAgencyInviteEmail, buildAgencyInviteEmail, INVITE_MAIL_PER_DAY } = await import("./inviteEmail");
  const { rateLimit } = await import("@/lib/rateLimit");
  const sent: string[] = [];
  const send = async (to: string) => { sent.push(to); return "sent" as const; };
  const limit = async (key: string, n: number, w: number) => rateLimit(key, n, w);

  // No account: nothing is sent and the cap is not spent.
  let r = await deliverAgencyInviteEmail("stranger@example.com", "Claim your $500 at evil.example", null, { hasAccount: async () => false, limit, send });
  check("an address with no FanFunnel account gets no e-mail", r === "no_account" && sent.length === 0);

  // The real account check: service role, normalized address, active accounts only.
  accountRow = null;
  r = await deliverAgencyInviteEmail("nobody@example.com", "Acme", null, { limit, send });
  const read = reads.at(-1);
  check("the account check reads profiles by the address, active only", !!read && read.table === "profiles"
    && read.ops.some(([o, a]) => o === "eq" && a[0] === "email" && a[1] === "nobody@example.com")
    && read.ops.some(([o, a]) => o === "eq" && a[0] === "is_active" && a[1] === true));
  check("…and a miss sends nothing", r === "no_account" && sent.length === 0);
  accountRow = { id: "p1" };

  // An existing account: mailed, at most 3 a day across every agency.
  const results: string[] = [];
  for (const org of ["Acme", "Beta", "Gamma", "Delta", "Echo"]) {
    results.push(await deliverAgencyInviteEmail("member@example.com", org, "chatter", { limit, send }));
  }
  check(`an existing account gets at most ${INVITE_MAIL_PER_DAY} invite e-mails a day, whichever agency`, INVITE_MAIL_PER_DAY === 3
    && results.filter((x) => x === "sent").length === 3 && results.slice(3).every((x) => x === "capped") && sent.length === 3);
  r = await deliverAgencyInviteEmail("other@example.com", "Acme", null, { limit, send });
  check("the cap is per address", r === "sent");
  check("a failing lookup never throws", (await deliverAgencyInviteEmail("x@example.com", "A", null, { hasAccount: async () => { throw new Error("db"); }, limit, send })) === "failed");

  const mail = buildAgencyInviteEmail("Acme", null, "https://ff.example");
  check("the e-mail no longer tells strangers to sign up", !/New to FanFunnel/.test(mail.text));

  console.log(`inviteEmail.test: ${passed} checks passed`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
