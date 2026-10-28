import assert from "node:assert";
import { aalFromAccessToken, getSessionAssurance, hasVerifiedFactor, mfaStep } from "./assurance";
import { safeNext } from "./safeNext";

// Two-factor state helpers + the open-redirect guard used after sign-in/2FA.

let passed = 0;
const check = (label: string, cond: unknown) => {
  assert.ok(cond, label);
  passed++;
};

const tok = (claims: unknown) => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;

async function main() {
  // aal claim
  check("aal2 token", aalFromAccessToken(tok({ aal: "aal2" })) === "aal2");
  check("aal1 token", aalFromAccessToken(tok({ aal: "aal1" })) === "aal1");
  check("unknown aal → null (never treated as aal2)", aalFromAccessToken(tok({ aal: "aal3" })) === null);
  check("missing aal → null", aalFromAccessToken(tok({ sub: "x" })) === null);
  check("garbage → null", aalFromAccessToken("not.a-jwt!.x") === null && aalFromAccessToken("nodots") === null);
  check("empty → null", aalFromAccessToken(undefined) === null && aalFromAccessToken("") === null);
  check("base64url chars decode", aalFromAccessToken(tok({ aal: "aal2", pad: "??>>~~" })) === "aal2");

  // verified factor
  check("verified factor counts", hasVerifiedFactor({ factors: [{ status: "unverified" }, { status: "verified" }] }));
  check("unverified only does not", !hasVerifiedFactor({ factors: [{ status: "unverified" }] }));
  check("no user / no factors", !hasVerifiedFactor(null) && !hasVerifiedFactor({ factors: null }));

  // what the session still needs
  check("aal2 → ok even when required", mfaStep({ aal: "aal2", hasVerifiedFactor: true }, true) === "ok");
  check("factor on aal1 → challenge", mfaStep({ aal: "aal1", hasVerifiedFactor: true }, false) === "challenge");
  check("required, no factor → enrol", mfaStep({ aal: "aal1", hasVerifiedFactor: false }, true) === "enrol");
  check("optional, no factor → ok", mfaStep({ aal: "aal1", hasVerifiedFactor: false }, false) === "ok");
  check("unknown aal with factor → challenge", mfaStep({ aal: null, hasVerifiedFactor: true }, false) === "challenge");

  // getSessionAssurance asks getUser FIRST and reads aal from that session
  const calls: string[] = [];
  const sb = (user: unknown, aal: string) => ({
    auth: {
      getUser: async () => (calls.push("getUser"), { data: { user } }),
      getSession: async () => (calls.push("getSession"), { data: { session: { access_token: tok({ aal }) } } }),
    },
  });
  const a = await getSessionAssurance(sb({ id: "u1", email: "a@b.c", factors: [{ status: "verified" }] }, "aal2") as never);
  check("signed in: id + aal2 + factor", a.userId === "u1" && a.assurance.aal === "aal2" && a.assurance.hasVerifiedFactor);
  check("getUser before getSession", calls.join() === "getUser,getSession");
  calls.length = 0;
  const none = await getSessionAssurance(sb(null, "aal2") as never);
  check("signed out: no aal, session never read", none.userId === null && none.assurance.aal === null && calls.join() === "getUser");

  // safeNext: only same-site paths
  check("plain path kept", safeNext("/admin") === "/admin");
  check("path with query kept", safeNext("/dashboard?section=settings") === "/dashboard?section=settings");
  for (const bad of ["https://evil.example", "//evil.example", "/\\evil.example", "evil", "", "/a\nb", "javascript:alert(1)", 42, null]) {
    check(`refused ${JSON.stringify(bad)}`, safeNext(bad) === "/dashboard");
  }
  check("custom fallback", safeNext("//x", "/admin") === "/admin");
  check("overlong refused", safeNext(`/${"a".repeat(600)}`) === "/dashboard");

  console.log(`assurance + safeNext: ${passed} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
