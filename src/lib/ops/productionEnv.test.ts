import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assertProductionEnv, describeEnvProblems, isProductionBuild, PRODUCTION_REQUIRED, productionEnvProblems } from "./productionEnv";

// OPS3-01: a Production build fails, naming the variable, when a required key
// is missing or malformed; Preview, local and `next start` are untouched.
let passed = 0;
const check = (label: string, ok: unknown) => { assert.ok(ok, label); passed++; };

const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiIsInJlZiI6InByb2plY3QifQ.c2lnbmF0dXJlc2lnbmF0dXJl";
const GOOD: Record<string, string> = {
  NEXT_PUBLIC_SUPABASE_URL: "https://abcdefghijklmnop.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: JWT,
  SUPABASE_SERVICE_ROLE_KEY: JWT.replace("eyJyb2xlIjoiYW5vbiIs", "eyJyb2xlIjoic2VydmljZV9yb2xlIiwi"),
  CRON_SECRET: "0123456789abcdef0123456789abcdef",
  REWARD_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
  REWARD_CODE_FINGERPRINT_KEY: Buffer.alloc(32, 2).toString("base64"),
  RESEND_API_KEY: "re_live_0123456789abcdef",
  ALERT_EMAIL_TO: "owner@example.com",
};

function main() {
  check("the required list is the GO_LIVE_KEYS set", PRODUCTION_REQUIRED.map((k) => k.name).join(",") === "NEXT_PUBLIC_SUPABASE_URL,NEXT_PUBLIC_SUPABASE_ANON_KEY,SUPABASE_SERVICE_ROLE_KEY,CRON_SECRET,REWARD_ENCRYPTION_KEY,REWARD_CODE_FINGERPRINT_KEY,RESEND_API_KEY,ALERT_EMAIL_TO");
  check("a complete, well-formed Production env has no problem", productionEnvProblems(GOOD).length === 0);
  check("…also with the sb_ key formats", productionEnvProblems({ ...GOOD, NEXT_PUBLIC_SUPABASE_ANON_KEY: "sb_publishable_" + "a".repeat(30), SUPABASE_SERVICE_ROLE_KEY: "sb_secret_" + "b".repeat(30) }).length === 0);
  for (const name of Object.keys(GOOD)) {
    const { [name]: _gone, ...rest } = GOOD; void _gone;
    const problems = productionEnvProblems(rest);
    check(`${name} missing is named`, problems.length === 1 && problems[0].name === name && problems[0].problem === "missing");
  }
  const bad: [string, string][] = [
    ["NEXT_PUBLIC_SUPABASE_URL", "http://abc.supabase.co"], ["NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co/rest/v1"],
    ["NEXT_PUBLIC_SUPABASE_ANON_KEY", JWT + " "], ["SUPABASE_SERVICE_ROLE_KEY", "eyJ.x"], ["CRON_SECRET", "short"], ["CRON_SECRET", "has a space in it yes"],
    ["REWARD_ENCRYPTION_KEY", Buffer.alloc(31, 1).toString("base64")], ["REWARD_ENCRYPTION_KEY", "not base64!!"], ["REWARD_CODE_FINGERPRINT_KEY", Buffer.alloc(33, 1).toString("base64")],
    ["RESEND_API_KEY", "sk_test_abcdef"], ["ALERT_EMAIL_TO", "notanemail"], ["ALERT_EMAIL_TO", "a@b.co, nope"],
  ];
  for (const [name, value] of bad) {
    const problems = productionEnvProblems({ ...GOOD, [name]: value });
    check(`${name}=<${value.length} chars> is malformed`, problems.length === 1 && problems[0].name === name && problems[0].problem === "malformed");
  }
  check("a stray trailing character on a key fails (the pasted-key typo)", productionEnvProblems({ ...GOOD, REWARD_ENCRYPTION_KEY: GOOD.REWARD_ENCRYPTION_KEY + "x" })[0]?.name === "REWARD_ENCRYPTION_KEY");
  check("the service key must not be the anon key", productionEnvProblems({ ...GOOD, SUPABASE_SERVICE_ROLE_KEY: JWT }).some((p) => p.name === "SUPABASE_SERVICE_ROLE_KEY"));
  check("the two reward keys must differ", productionEnvProblems({ ...GOOD, REWARD_CODE_FINGERPRINT_KEY: GOOD.REWARD_ENCRYPTION_KEY }).some((p) => p.name === "REWARD_CODE_FINGERPRINT_KEY"));
  check("the debug flag must be absent on Production", productionEnvProblems({ ...GOOD, NEXT_PUBLIC_ENABLE_DEBUG: "1" }).some((p) => p.name === "NEXT_PUBLIC_ENABLE_DEBUG"));
  check("optional keys pass when unset", productionEnvProblems({ ...GOOD, VAPID_PUBLIC_KEY: "", HEARTBEAT_URL: "" }).length === 0);
  check("an optional key that is set but malformed fails", productionEnvProblems({ ...GOOD, HEARTBEAT_URL: "http://hc-ping.com/x" })[0]?.name === "HEARTBEAT_URL" && productionEnvProblems({ ...GOOD, ADMIN_EMAILS: "owner" })[0]?.name === "ADMIN_EMAILS");
  check("a partial VAPID trio fails naming the missing ones", productionEnvProblems({ ...GOOD, VAPID_PUBLIC_KEY: "B".repeat(87) }).map((p) => p.name).sort().join(",") === "VAPID_PRIVATE_KEY,VAPID_SUBJECT");
  check("a full, well-formed VAPID trio passes", productionEnvProblems({ ...GOOD, VAPID_PUBLIC_KEY: "B".repeat(87), VAPID_PRIVATE_KEY: "c".repeat(43), VAPID_SUBJECT: "mailto:a@b.co" }).length === 0);

  const secretish = { ...GOOD, CRON_SECRET: "cron-secret-value-0123456789", REWARD_ENCRYPTION_KEY: "oops-not-a-key" };
  const message = describeEnvProblems(productionEnvProblems(secretish));
  check("the message names variables and shapes, never a value", /REWARD_ENCRYPTION_KEY: malformed/.test(message) && !message.includes("oops-not-a-key") && !message.includes(secretish.CRON_SECRET) && /GO_LIVE_KEYS/.test(message));
  let threw: unknown = null;
  try { assertProductionEnv({}); } catch (e) { threw = e; }
  check("assertProductionEnv throws on an empty env", threw instanceof Error && /NEXT_PUBLIC_SUPABASE_URL: missing/.test(threw.message));
  threw = null;
  try { assertProductionEnv(GOOD); } catch (e) { threw = e; }
  check("…and not on a good one", threw === null);

  // When the check runs: only a BUILD of the live site.
  const build = ["node", "/x/node_modules/.bin/next", "build"];
  check("Vercel Production build → checked", isProductionBuild({ VERCEL_ENV: "production" }, build) && isProductionBuild({ VERCEL_ENV: "production", NEXT_PHASE: "phase-production-build" }, ["node", "x"]));
  check("self-hosted production build → checked", isProductionBuild({ FF_REQUIRE_SUPABASE: "1" }, build));
  check("Preview build → not checked", !isProductionBuild({ VERCEL_ENV: "preview" }, build));
  check("local / CI build → not checked", !isProductionBuild({}, build) && !isProductionBuild({ CI: "true", GITHUB_ACTIONS: "true" }, build));
  check("next start / next dev on Production → not checked (the runtime guard in supabase/server.ts applies)", !isProductionBuild({ VERCEL_ENV: "production" }, ["node", "/x/next", "start"]) && !isProductionBuild({ VERCEL_ENV: "production" }, ["node", "/x/next", "dev"]));
  const cfg = readFileSync(new URL("../../../next.config.ts", import.meta.url), "utf8");
  check("next.config.ts runs the check for a Production build", /if \(isProductionBuild\(\)\) assertProductionEnv\(\);/.test(cfg));
  console.log(`production env check: ${passed} checks passed`);
}
try { main(); } catch (e) { console.error(e); process.exitCode = 1; }
