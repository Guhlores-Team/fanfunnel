import assert from "node:assert";
import { mock } from "node:test";
import { randomBytes } from "node:crypto";

// C4 (batch 6 attack audit): the win card's claim code was the end of the
// public share id. It is now a keyed HMAC of the share id: a different share
// id gives a different code, and the share id alone (without the server key)
// does not give the code.

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

let configured = true;
mock.module("@/lib/supabase/server", { namedExports: { isSupabaseConfigured: () => configured } });

async function main() {
  const k1 = randomBytes(32).toString("base64");
  const k2 = randomBytes(32).toString("base64");
  process.env.REWARD_CODE_FINGERPRINT_KEY = k1;
  const m = await import("./claimCode");

  const a = m.claimCodeFor("Ab3dEf9hJk2m")!;
  const b = m.claimCodeFor("Ab3dEf9hJk2n")!;
  check("a code is 6 Crockford base32 characters", /^[0-9A-HJKMNP-TV-Z]{6}$/.test(a));
  check("changing the share id changes the code", a !== b);
  check("the code is not the end of the share id", a !== "Ab3dEf9hJk2m".slice(-6).toUpperCase());
  check("the same share id gives the same code", m.claimCodeFor("Ab3dEf9hJk2m") === a);
  process.env.REWARD_CODE_FINGERPRINT_KEY = k2;
  check("under another key the code differs: the share id alone does not give it", m.claimCodeFor("Ab3dEf9hJk2m") !== a);
  process.env.REWARD_CODE_FINGERPRINT_KEY = k1;
  const raw = Buffer.from(k1, "base64");
  check("…and it is not a plain HMAC of the share id under the fingerprint key (a derived key)", m.claimCodeWith(raw, "Ab3dEf9hJk2m") !== a);

  check("the creator's check accepts the code", m.verifyClaimCode("Ab3dEf9hJk2m", a));
  check("…in lower case, with spaces or a dash", m.verifyClaimCode("Ab3dEf9hJk2m", ` ${a.slice(0, 3).toLowerCase()}-${a.slice(3)} `));
  check("…and refuses another win's code", !m.verifyClaimCode("Ab3dEf9hJk2m", b));
  check("…and refuses junk", !m.verifyClaimCode("Ab3dEf9hJk2m", "") && !m.verifyClaimCode("Ab3dEf9hJk2m", 42) && !m.verifyClaimCode("Ab3dEf9hJk2m", a + "X"));

  const res = m.withClaimCode({ prizeIndex: 1, shareId: "Ab3dEf9hJk2m" }) as { claimCode?: string };
  check("the spin response carries the code for the winner", res.claimCode === a);
  check("a result without a share id is left alone", !("claimCode" in (m.withClaimCode({ error: "no_spins" }) as object)));

  // No key: a real project shows no code (never a guessable one); the demo uses its fixed key.
  delete process.env.REWARD_CODE_FINGERPRINT_KEY;
  delete process.env.REWARD_ENCRYPTION_KEY;
  check("no key on a real project → no code and no match", m.claimCodeFor("Ab3dEf9hJk2m") === null && !m.verifyClaimCode("Ab3dEf9hJk2m", a));
  configured = false;
  const demo = m.claimCodeFor("Ab3dEf9hJk2m");
  check("demo mode still shows a code", !!demo && demo !== a && m.claimCodeFor("Ab3dEf9hJk2n") !== demo);

  console.log(`claimCode.test: ${passed} checks passed`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
