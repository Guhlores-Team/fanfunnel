import assert from "node:assert";
import { scrub, scrubRoute, truncate } from "./scrub";

// Error monitoring stores and e-mails what users' browsers and our servers
// throw. Nothing that identifies a fan or grants access may survive redaction:
// fan link tokens, auth tokens, e-mails, passwords, query strings.

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

const FAN_TOKEN = "0123456789abcdef0123456789abcdef";
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
const UUID = "3f2b9c1e-7a4d-4e2f-9b1a-2c3d4e5f6a7b";

const leaks = (s: string | undefined) =>
  [FAN_TOKEN, "eyJhbGci", "hunter2", "fan@example.com", "sk_live_abc", "s3cr3t", UUID, "10.1.2.3", "?ref=", "abcDEF123"].filter(
    (needle) => s?.includes(needle),
  );

// --- each class of secret -----------------------------------------------------
{
  const s = scrub(`fetch failed for https://fanfunnel.app/spin/${FAN_TOKEN}?ref=tiktok`);
  check("fan /spin/<token> link is redacted", !s.includes(FAN_TOKEN) && s.includes("/spin/[redacted]"));
  check("URL query string is redacted", !s.includes("?ref=") && s.includes("?[redacted]"));
}
check("a bare 32-hex fan token is redacted", !scrub(`invalid token ${FAN_TOKEN} for pass`).includes(FAN_TOKEN));
check("e-mail addresses are redacted", scrub("No account for fan@example.com") === "No account for [email]");
check("Bearer tokens are redacted", scrub("Authorization: Bearer abcDEF123.xyz") === "Authorization: Bearer [redacted]");
check("a JWT anywhere is redacted", !scrub(`session ${JWT} expired`).includes("eyJhbGci"));
check(
  'JSON "password" values are redacted',
  !scrub('body {"email":"a@b.co","password":"hunter2"}').includes("hunter2"),
);
check("password=… params are redacted", scrub("login password=hunter2&x=1").includes("password=[redacted]"));
check("api keys are redacted", !scrub("RESEND_API_KEY: sk_live_abc").includes("sk_live_abc"));
check("*_secret fields are redacted", !scrub("client_secret=s3cr3t").includes("s3cr3t"));
check("access_token in a fragment is redacted", !scrub("#access_token=abcDEF123&type=recovery").includes("abcDEF123"));
check(
  "Supabase auth cookies are redacted",
  !scrub("cookie sb-abcd-auth-token.0=base64-abcDEF123; path=/").includes("abcDEF123"),
);
check("UUIDs (fan / creator ids) are redacted", !scrub(`fan ${UUID} not found`).includes(UUID));
check("IPv4 addresses are redacted", !scrub("connect ECONNREFUSED 10.1.2.3:5432").includes("10.1.2.3"));

// --- what must survive (so errors stay useful) -------------------------------
check("an ordinary message is untouched", scrub("Cannot read properties of undefined (reading 'map')") === "Cannot read properties of undefined (reading 'map')");
{
  const stack = "TypeError: x is not a function\n    at render (https://fanfunnel.app/_next/static/chunks/app-1a2b3c4d.js:1:2345)";
  check("stack frames keep file + line", scrub(stack).includes("app-1a2b3c4d.js:1:2345"));
}
check("Node error codes survive", scrub("fetch failed code: ECONNRESET").includes("ECONNRESET"));
check("npm scopes are not mistaken for e-mails", scrub("at node_modules/@supabase/ssr/dist/index.js").includes("@supabase/ssr"));
check("undefined stays undefined", scrub(undefined) === undefined);

// --- a realistic everything-at-once blob ---------------------------------------
{
  const blob = `POST https://x.app/api/spin?token=${FAN_TOKEN} failed for fan@example.com (ip 10.1.2.3, fan ${UUID}): {"password":"hunter2","apiKey":"sk_live_abc"} Bearer ${JWT}`;
  check(`nothing sensitive survives a mixed blob (leaked: ${leaks(scrub(blob)).join(", ")})`, leaks(scrub(blob)).length === 0);
}

// --- routes -----------------------------------------------------------------------
check("route: spin token segment", scrubRoute(`/spin/${FAN_TOKEN}`) === "/spin/[token]");
check("route: even a short demo token", scrubRoute("/spin/demo") === "/spin/[token]");
check("route: Next route file paths are kept", scrubRoute("/spin/[token]") === "/spin/[token]");
check("route: query + hash dropped", scrubRoute("/dashboard?section=admin&token=abc#x") === "/dashboard");
check("route: absolute URL → path only", scrubRoute(`https://fanfunnel.app/api/fans/${UUID}?x=1`) === "/api/fans/[id]");
check("route: numeric ids collapse", scrubRoute("/api/grants/12345") === "/api/grants/[id]");
check("route: e-mail in a segment is redacted", scrubRoute("/c/fan@example.com") === "/c/[email]");
check("route: empty → undefined", scrubRoute("") === undefined);

// --- truncation --------------------------------------------------------------------
check("truncate keeps short text", truncate("abc", 5) === "abc");
check("truncate cuts to the limit with an ellipsis", truncate("abcdefgh", 5) === "abcd…" && truncate("abcdefgh", 5)!.length === 5);

console.log(`monitoring/scrub: ${passed} checks passed`);
