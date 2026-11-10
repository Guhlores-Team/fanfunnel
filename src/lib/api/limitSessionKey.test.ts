import assert from "node:assert/strict";
import { limitRoute, sessionKey } from "./limit";

// N-E: the account tier budgets a signed-in call per session, not per address.
let passed = 0;
const check = (label: string, ok: unknown) => { assert.ok(ok, label); passed++; };

async function main() {
  delete process.env.NEXT_PUBLIC_SUPABASE_URL; // demo: no 401 fast path, so the limiter alone is observed
  const req = (cookie: string | null, ip = "10.0.0.1") => new Request("http://x/api/me", { headers: { "x-real-ip": ip, ...(cookie ? { cookie } : {}) } });
  const a = "sb-abcdefgh-auth-token=A.eyJ.sig", b = "sb-abcdefgh-auth-token=B.eyJ.sig";
  check("a session cookie yields a pseudonymous key (never the cookie)", /^[A-Za-z0-9_-]{32}$/.test(sessionKey(req(a))!) && !sessionKey(req(a))!.includes("eyJ"));
  check("chunked cookies key on the first chunk", sessionKey(req("sb-abcdefgh-auth-token.0=A.eyJ.sig; sb-abcdefgh-auth-token.1=rest")) === sessionKey(req("sb-abcdefgh-auth-token.0=A.eyJ.sig")));
  check("no cookie → no session key", sessionKey(req(null)) === null && sessionKey(req("theme=dark")) === null);
  let aLimited = 0, bLimited = 0;
  for (let i = 0; i < 320; i++) { if (await limitRoute(req(a), "key-test:A")) aLimited++; }
  for (let i = 0; i < 10; i++) { if (await limitRoute(req(b), "key-test:A")) bLimited++; }
  check("one session over its budget does not spend its neighbour's (same address)", aLimited === 20 && bLimited === 0);
  let noCookie = 0;
  for (let i = 0; i < 10; i++) { if (await limitRoute(req(null), "key-test:A")) noCookie++; }
  check("cookieless calls keep their own per-address window", noCookie === 0);
  let pub = 0;
  for (let i = 0; i < 125; i++) { if (await limitRoute(req(a, "10.0.0.2"), "key-test:P", "public")) pub++; }
  check("the public tier stays per address even with a cookie", pub === 5);
  console.log(`limit session key: ${passed} checks passed`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
