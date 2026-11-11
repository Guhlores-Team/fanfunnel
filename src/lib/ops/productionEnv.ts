// OPS3-01: a Production build must fail when a key the live site cannot run
// without is missing or malformed, so a mistyped key (or a skipped go-live
// step) is caught by the build, not by the first fan who gets a 500. Pure and
// dependency-free: next.config.ts runs it at build time. The required list
// mirrors docs/handoff/GO_LIVE_KEYS.md; messages name variables, never values.

export type EnvProblem = { name: string; problem: "missing" | "malformed"; hint: string };
type Env = Record<string, string | undefined>;

const JWT = /^[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$/;
const EMAIL = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;
const B64URL = /^[A-Za-z0-9_-]+$/;

const isHttpsOrigin = (v: string) => { try { const u = new URL(v); return u.protocol === "https:" && u.pathname === "/" && !u.search && !u.hash; } catch { return false; } };
const isSupabaseKey = (v: string, prefix: "sb_publishable_" | "sb_secret_") => JWT.test(v) || (v.startsWith(prefix) && /^[A-Za-z0-9_-]{20,}$/.test(v));
const isBase64Key32 = (v: string) => { try { const b = Buffer.from(v, "base64"); return /^[A-Za-z0-9+/]+={0,2}$/.test(v) && b.length === 32 && b.toString("base64") === v; } catch { return false; } };
const isEmailList = (v: string) => { const parts = v.split(",").map((p) => p.trim()).filter(Boolean); return parts.length > 0 && parts.every((p) => EMAIL.test(p)); };

/** Required on Production, with the shape each must have (GO_LIVE_KEYS steps 1-6). */
export const PRODUCTION_REQUIRED: readonly { name: string; ok: (v: string) => boolean; hint: string }[] = [
  { name: "NEXT_PUBLIC_SUPABASE_URL", ok: isHttpsOrigin, hint: "the project URL, https://<ref>.supabase.co with no path" },
  { name: "NEXT_PUBLIC_SUPABASE_ANON_KEY", ok: (v) => isSupabaseKey(v, "sb_publishable_"), hint: "the anon/publishable key from Supabase → Project Settings → API" },
  { name: "SUPABASE_SERVICE_ROLE_KEY", ok: (v) => isSupabaseKey(v, "sb_secret_"), hint: "the service-role/secret key from Supabase → Project Settings → API" },
  { name: "CRON_SECRET", ok: (v) => v.length >= 16 && !/\s/.test(v), hint: "at least 16 characters, no spaces (openssl rand -hex 32)" },
  { name: "REWARD_ENCRYPTION_KEY", ok: isBase64Key32, hint: "base64 of exactly 32 random bytes (openssl rand -base64 32)" },
  { name: "REWARD_CODE_FINGERPRINT_KEY", ok: isBase64Key32, hint: "base64 of exactly 32 random bytes, different from REWARD_ENCRYPTION_KEY" },
  { name: "RESEND_API_KEY", ok: (v) => /^re_[A-Za-z0-9_]{8,}$/.test(v), hint: "a Resend API key (starts with re_)" },
  { name: "ALERT_EMAIL_TO", ok: isEmailList, hint: "one e-mail address, or several separated by commas" },
];

/** Optional on Production, but malformed when set (a typo would silently turn the feature off). */
export const PRODUCTION_OPTIONAL: readonly { name: string; ok: (v: string) => boolean; hint: string }[] = [
  { name: "VAPID_PUBLIC_KEY", ok: (v) => B64URL.test(v) && v.length === 87, hint: "the 87-character public key from npx web-push generate-vapid-keys" },
  { name: "VAPID_PRIVATE_KEY", ok: (v) => B64URL.test(v) && v.length === 43, hint: "the 43-character private key from npx web-push generate-vapid-keys" },
  { name: "VAPID_SUBJECT", ok: (v) => /^mailto:[^\s@]+@[^\s@]+$/.test(v) || /^https:\/\/\S+$/.test(v), hint: "mailto:you@example.com or an https URL" },
  { name: "ADMIN_EMAILS", ok: isEmailList, hint: "comma-separated e-mail addresses" },
  { name: "HEARTBEAT_URL", ok: (v) => /^https:\/\/\S+$/.test(v), hint: "an https ping URL" },
  { name: "ALERT_EMAIL_FROM", ok: (v) => /^(?:[^<>\r\n]+<)?[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+>?$/.test(v), hint: "Name <address@domain> or address@domain" },
  { name: "ACCOUNT_EMAIL_FROM", ok: (v) => /^(?:[^<>\r\n]+<)?[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+>?$/.test(v), hint: "Name <address@domain> or address@domain" },
  { name: "REWARD_ENCRYPTION_KEY_VERSION", ok: (v) => /^\d{1,5}$/.test(v) && Number(v) >= 1 && Number(v) <= 32767, hint: "an integer from 1 to 32767" },
  { name: "REWARD_ENCRYPTION_KEY_PREVIOUS", ok: isBase64Key32, hint: "base64 of exactly 32 bytes (the previous key during a rotation)" },
  { name: "REWARD_ENCRYPTION_KEY_PREVIOUS_VERSION", ok: (v) => /^\d{1,5}$/.test(v) && Number(v) >= 1 && Number(v) <= 32767, hint: "an integer from 1 to 32767" },
  { name: "NEXT_PUBLIC_SITE_URL", ok: isHttpsOrigin, hint: "the public https origin, no path" },
  { name: "FF_REQUIRE_SUPABASE", ok: (v) => v === "1", hint: "1" },
  { name: "KV_REST_API_URL", ok: (v) => /^https:\/\/\S+$/.test(v), hint: "an https URL" },
  { name: "UPSTASH_REDIS_REST_URL", ok: (v) => /^https:\/\/\S+$/.test(v), hint: "an https URL" },
];

/** Every problem with a Production environment, in a stable order. Names and hints only. */
export function productionEnvProblems(env: Env = process.env): EnvProblem[] {
  const out: EnvProblem[] = [];
  const value = (name: string) => (env[name] ?? "").trim();
  for (const key of PRODUCTION_REQUIRED) {
    const v = value(key.name);
    if (!v) out.push({ name: key.name, problem: "missing", hint: key.hint });
    else if (!key.ok(v)) out.push({ name: key.name, problem: "malformed", hint: key.hint });
  }
  for (const key of PRODUCTION_OPTIONAL) {
    const v = value(key.name);
    if (v && !key.ok(v)) out.push({ name: key.name, problem: "malformed", hint: key.hint });
  }
  const vapid = ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"];
  const vapidSet = vapid.filter((n) => value(n));
  if (vapidSet.length > 0 && vapidSet.length < vapid.length) {
    for (const n of vapid) if (!value(n)) out.push({ name: n, problem: "missing", hint: "set all three VAPID_* variables or none" });
  }
  if (value("NEXT_PUBLIC_SUPABASE_ANON_KEY") && value("NEXT_PUBLIC_SUPABASE_ANON_KEY") === value("SUPABASE_SERVICE_ROLE_KEY")) {
    out.push({ name: "SUPABASE_SERVICE_ROLE_KEY", problem: "malformed", hint: "must not be the anon key" });
  }
  if (value("REWARD_ENCRYPTION_KEY") && value("REWARD_ENCRYPTION_KEY") === value("REWARD_CODE_FINGERPRINT_KEY")) {
    out.push({ name: "REWARD_CODE_FINGERPRINT_KEY", problem: "malformed", hint: "must be a different key from REWARD_ENCRYPTION_KEY" });
  }
  if (value("NEXT_PUBLIC_ENABLE_DEBUG") === "1") {
    out.push({ name: "NEXT_PUBLIC_ENABLE_DEBUG", problem: "malformed", hint: "must be absent on Production (Preview only)" });
  }
  return out;
}

/** The build-failing message: variable names and what each should look like, never a value. */
export function describeEnvProblems(problems: EnvProblem[]): string {
  return [
    "FanFunnel Production build refused: fix these environment variables in Vercel → Settings → Environment Variables (Production scope), then redeploy.",
    ...problems.map((p) => `  - ${p.name}: ${p.problem} (${p.hint})`),
    "See docs/handoff/GO_LIVE_KEYS.md.",
  ].join("\n");
}

/**
 * True for a `next build` of the live site: Vercel's Production scope
 * (VERCEL_ENV=production) or a self-hosted production (FF_REQUIRE_SUPABASE=1
 * off Vercel). On Vercel, VERCEL_ENV decides: a Preview also sets
 * FF_REQUIRE_SUPABASE=1 to use the TEST database and is not the live site.
 * Previews, local builds, CI, `next start` and `next dev` are never checked.
 */
export function isProductionBuild(env: Env = process.env, argv: readonly string[] = process.argv): boolean {
  const production = env.VERCEL_ENV ? env.VERCEL_ENV === "production" : env.FF_REQUIRE_SUPABASE === "1";
  const building = env.NEXT_PHASE === "phase-production-build" || argv.slice(2).includes("build");
  return production && building;
}

/** Throws (failing the build) when a Production build's environment has a problem. */
export function assertProductionEnv(env: Env = process.env): void {
  const problems = productionEnvProblems(env);
  if (problems.length > 0) throw new Error(describeEnvProblems(problems));
}
