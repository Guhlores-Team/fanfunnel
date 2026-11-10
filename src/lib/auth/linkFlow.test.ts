import assert from "node:assert";
import { mock } from "node:test";
import { startFakeAuthServer } from "../../../scripts/test/fake-auth-server.mjs";

// Review A1, end to end on this side of the wire: the app's REAL routes
// (POST /auth/confirm/verify, POST /api/account/password/reset), the REAL
// @supabase/ssr + auth-js clients and the real cookie handling, against an
// in-memory Auth server (scripts/test/fake-auth-server.mjs) that issues an
// `otp` session for a verified e-mail link.
//
// What this proves: with an otp-shaped session the whole chain works: the
// Continue POST stores the session in cookies, the reset route reads that
// session's signed-shape `amr` from those cookies, a reset and an invitation
// can set a password without the current one, and every other session cannot.
// What it cannot prove: that the hosted Auth server really records `otp` for
// a token_hash link. scripts/security/link-session-runtime-test.mjs asserts
// that against the TEST project.

let passed = 0;
function check(label: string, cond: unknown) {
  assert.ok(cond, label);
  passed++;
}

const jar = new Map<string, string>();
const cookieStore = {
  getAll: () => [...jar].map(([name, value]) => ({ name, value })),
  set: (name: string, value: string, options?: { maxAge?: number }) => {
    if (!value || options?.maxAge === 0) jar.delete(name);
    else jar.set(name, value);
  },
};
mock.module("next/headers", { namedExports: { cookies: async () => cookieStore, headers: async () => new Headers() } });

const O = "https://app.example";
const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
const amrOfJar = async () => {
  const { createClient } = await import("@/lib/supabase/server");
  const { amrFromAccessToken } = await import("./assurance");
  const { data } = await (await createClient()).auth.getSession();
  const token = data.session?.access_token;
  const sub = token ? (JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")) as { sub?: string }).sub : null;
  return { amr: amrFromAccessToken(token), userId: sub ?? null };
};

async function main() {
  const fake = await startFakeAuthServer();
  process.env.NEXT_PUBLIC_SUPABASE_URL = fake.url;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = fake.anonKey;
  process.env.SUPABASE_SERVICE_ROLE_KEY = fake.serviceKey;
  delete process.env.NEXT_PUBLIC_SITE_URL;

  const verifyRoute = await import("@/app/auth/confirm/verify/route");
  const resetRoute = await import("@/app/api/account/password/reset/route");
  const { createClient } = await import("@/lib/supabase/server");

  const tap = async (fields: Record<string, string>, headers: Record<string, string> = { "sec-fetch-site": "same-origin", origin: O }) => {
    const cookie = cookieHeader();
    const res = await verifyRoute.POST(
      new Request(`${O}/auth/confirm/verify`, {
        method: "POST",
        body: new URLSearchParams(fields),
        headers: { "content-type": "application/x-www-form-urlencoded", host: "app.example", ...(cookie ? { cookie } : {}), ...headers },
      })
    );
    return { status: res.status, location: res.headers.get("location") };
  };
  const reset = async (body: unknown) => {
    const res = await resetRoute.POST(new Request(`${O}/api/account/password/reset`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }));
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const signIn = async (email: string, password: string) => {
    const sb = await createClient();
    return sb.auth.signInWithPassword({ email, password });
  };

  // --- A reset link, on a browser with no session ---------------------------
  const alice = fake.addUser({ email: "alice@example.com", password: "OldPassw0rd" });
  let link = fake.issueLink(alice.id, "recovery");
  let r = await tap({ token_hash: link, type: "recovery", next: "/reset-password" });
  check("Continue on a reset link → 303 to /reset-password", r.status === 303 && r.location === `${O}/reset-password`);
  check("…the link is spent and the session is in the cookies", fake.linkUsed(link) && [...jar.keys()].some((k) => /^sb-.*-auth-token/.test(k)));
  const session = await amrOfJar();
  check("…it is alice's session, opened by method otp", session.userId === alice.id && session.amr.length === 1 && session.amr[0].method === "otp" && session.amr[0].timestamp > 0);
  let p = await reset({});
  check("A1: the new-password screen's probe says nothing more is needed (no current password)", p.status === 200 && p.body.requires === "none" && p.body.byLink === true && p.body.email === "alice@example.com");
  check("…and the probe changed nothing", alice.password === "OldPassw0rd");
  p = await reset({ newPassword: "NewPassw0rd1" });
  check("A1: the forgotten password is replaced without the old one", p.status === 200 && p.body.ok === true && alice.password === "NewPassw0rd1");
  check("…this session stays signed in", fake.liveSessionsOf(alice.id).length === 1 && (await amrOfJar()).userId === alice.id);

  // --- The same link again: double tap, or Back then Continue (A5) ----------
  r = await tap({ token_hash: link, type: "recovery", next: "/reset-password" });
  check("A5: a second tap with the session already set → /reset-password, not /login", r.status === 303 && r.location === `${O}/reset-password`);
  p = await reset({});
  check("…where the link's own session may still set the password", p.status === 200 && p.body.byLink === true);

  // --- An ordinary password sign-in must give the current password ----------
  jar.clear();
  const signed = await signIn("alice@example.com", "NewPassw0rd1");
  check("a password sign-in through the real client stores a session", !signed.error && (await amrOfJar()).amr[0]?.method === "password");
  p = await reset({});
  check("a password session: the probe asks for the current password", p.status === 403 && p.body.error === "current_password_required");
  p = await reset({ newPassword: "Another1Passw0rd" });
  check("…a new password alone is refused, nothing changes", p.status === 403 && alice.password === "NewPassw0rd1");
  p = await reset({ newPassword: "Another1Passw0rd", currentPassword: "wrong-password1" });
  check("…a wrong current password is refused", p.status === 403 && p.body.error === "wrong_password" && alice.password === "NewPassw0rd1");
  p = await reset({ newPassword: "Another1Passw0rd", currentPassword: "NewPassw0rd1" });
  check("…the right current password sets it", p.status === 200 && alice.password === "Another1Passw0rd");

  // --- An invitation: the invited creator never had a password --------------
  jar.clear();
  const invited = fake.addUser({ email: "invited@example.com", password: null, confirmed: false });
  link = fake.issueLink(invited.id, "invite");
  r = await tap({ token_hash: link, type: "invite" });
  check("Continue on an invitation → /set-password", r.status === 303 && r.location === `${O}/set-password`);
  p = await reset({});
  check("A1: the invited creator may set a first password", p.status === 200 && p.body.requires === "none" && p.body.email === "invited@example.com");
  p = await reset({ newPassword: "First1Password" });
  check("…and does", p.status === 200 && invited.password === "First1Password");

  // --- A link for another account while signed in (A4) ----------------------
  // The browser is signed in as `invited`; alice opens her reset link here.
  const before = fake.liveSessionsOf(invited.id).length;
  link = fake.issueLink(alice.id, "recovery");
  r = await tap({ token_hash: link, type: "recovery", next: "/reset-password" });
  check("A4: a link for another account lands with the switched flag", r.status === 303 && r.location === `${O}/reset-password?switched=1`);
  check("A4: the cookies now hold the link's account", (await amrOfJar()).userId === alice.id);
  check("A4: the previous account's session is ended at the Auth server, not just dropped", before === 1 && fake.liveSessionsOf(invited.id).length === 0);
  p = await reset({});
  check("A4: the screen is told whose session this is, from the session", p.status === 200 && p.body.email === "alice@example.com");

  // --- Sessions that must NOT skip the current password ---------------------
  const putSession = async (s: { access_token: string; refresh_token: string }) => {
    jar.clear();
    const sb = await createClient();
    const { error } = await sb.auth.setSession({ access_token: s.access_token, refresh_token: s.refresh_token });
    assert.ok(!error, `setSession: ${error?.message}`);
  };
  await putSession(fake.openSession(alice.id, "otp", 61 * 60 * 1000));
  p = await reset({});
  check("a link session older than one hour needs the current password", p.status === 403 && p.body.error === "current_password_required");
  await putSession(fake.openSession(alice.id, "otp", 59 * 60 * 1000));
  p = await reset({});
  check("59 minutes old: still allowed", p.status === 200 && p.body.byLink === true);
  for (const method of ["recovery", "invite", "magiclink"]) {
    await putSession(fake.openSession(alice.id, method, 60_000));
    p = await reset({});
    check(`a legacy ${method} session (PKCE exchange) is allowed too`, p.status === 200 && p.body.byLink === true);
  }
  for (const method of ["password", "totp", "oauth", "email/signup", "token_refresh"]) {
    await putSession(fake.openSession(alice.id, method, 60_000));
    p = await reset({ newPassword: "Sneaky1Password" });
    check(`a ${method} session cannot set a password without the current one`, p.status === 403 && p.body.error === "current_password_required" && alice.password === "Another1Passw0rd");
  }

  // --- Two-factor accounts are asked for the code first ---------------------
  jar.clear();
  const carol = fake.addUser({ email: "carol@example.com", password: "Carol1Password", verifiedFactor: true });
  link = fake.issueLink(carol.id, "recovery");
  r = await tap({ token_hash: link, type: "recovery", next: "/reset-password" });
  check("a two-factor account's reset link still signs in (aal1)", r.location === `${O}/reset-password`);
  p = await reset({});
  check("…but the probe asks for the second factor before anything else", p.status === 403 && p.body.error === "mfa_required" && p.body.step === "challenge");
  p = await reset({ newPassword: "Carol2Password" });
  check("…and a new password is refused until then", p.status === 403 && p.body.error === "mfa_required" && carol.password === "Carol1Password");
  const stepped = fake.stepUp(fake.liveSessionsOf(carol.id)[0].id);
  assert.ok(stepped);
  await putSession(stepped);
  p = await reset({});
  check("after the code (aal2, amr totp + otp) the link session may set it", p.status === 200 && p.body.byLink === true);
  p = await reset({ newPassword: "Carol2Password" });
  check("…and does", p.status === 200 && carol.password === "Carol2Password");
  // A two-factor account that signed in with its password and code is NOT a link session.
  jar.clear();
  await signIn("carol@example.com", "Carol2Password");
  const again = fake.stepUp(fake.liveSessionsOf(carol.id).at(-1)!.id);
  assert.ok(again);
  await putSession(again);
  p = await reset({ newPassword: "Carol3Password" });
  check("password + code (aal2) still needs the current password", p.status === 403 && p.body.error === "current_password_required" && carol.password === "Carol2Password");

  // --- A2: nothing but our own Continue page spends a link ------------------
  jar.clear();
  link = fake.issueLink(alice.id, "recovery");
  const verifies = fake.count("POST", "/verify");
  for (const [label, headers] of [
    ["a cross-site form", { "sec-fetch-site": "cross-site", origin: "https://evil.example" }],
    ["a foreign Origin", { origin: "https://evil.example" }],
    ["no Origin and no Sec-Fetch-Site", {}],
  ] as const) {
    r = await tap({ token_hash: link, type: "recovery", next: "/reset-password" }, headers);
    check(`A2: ${label} → back to the Continue page`, r.status === 303 && r.location === `${O}/auth/confirm?token_hash=${link}&type=recovery&next=%2Freset-password&retry=origin`);
    check(`A2: ${label} → the Auth server is never called, the link is unspent, no cookie is set`, fake.count("POST", "/verify") === verifies && !fake.linkUsed(link) && jar.size === 0);
  }

  // --- A3: a failure that decided nothing leaves the link usable ------------
  for (const status of [429, 500, 503]) {
    fake.forceNext("POST /verify", status, { code: status, error_code: status === 429 ? "over_request_rate_limit" : "unexpected_failure", msg: "forced" });
    r = await tap({ token_hash: link, type: "recovery", next: "/reset-password" });
    check(`A3: a ${status} from the Auth server → back to the Continue page, 'still good'`, r.location === `${O}/auth/confirm?token_hash=${link}&type=recovery&next=%2Freset-password&retry=busy` && !fake.linkUsed(link) && jar.size === 0);
  }
  r = await tap({ token_hash: link, type: "recovery", next: "/reset-password" });
  check("A3: …and the same link then works", r.location === `${O}/reset-password` && fake.linkUsed(link));
  jar.clear();
  r = await tap({ token_hash: link, type: "recovery", next: "/reset-password" });
  check("a spent link with no session → the sign-in page says used or expired", r.location === `${O}/login?error=auth_link&type=recovery&reason=expired`);
  const banned = fake.addUser({ email: "banned@example.com", password: "Banned1Password", banned: true });
  link = fake.issueLink(banned.id, "recovery");
  r = await tap({ token_hash: link, type: "recovery", next: "/reset-password" });
  check("A3: a blocked account → its own reason, no session", r.location === `${O}/login?error=auth_link&type=recovery&reason=banned` && jar.size === 0);

  await fake.close();
  console.log(`linkFlow.test: ${passed} checks passed`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
