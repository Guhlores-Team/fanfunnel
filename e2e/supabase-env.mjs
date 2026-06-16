// Shared config resolver for the real-Supabase tests. Trims env (mobile paste
// artifacts), normalizes the URL to its origin, and validates shape with
// precise, NON-SECRET diagnostics. Returns a tagged result the caller acts on.

import { writeSync } from "node:fs";

export const log = (s = "") => writeSync(1, s + "\n");

const clean = (v) => (v || "").trim();

/**
 * @returns {{status:"skip"}                       // secrets absent
 *          | {status:"bad"}                        // present but URL malformed (diagnostics already logged)
 *          | {status:"ok", URL:string, ANON:string, SERVICE:string}}
 */
export function resolveSupabaseEnv() {
  const RAW_URL = clean(process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL);
  const ANON = clean(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  const SERVICE = clean(process.env.SUPABASE_SERVICE_ROLE_KEY);

  if (!RAW_URL || !ANON || !SERVICE) return { status: "skip" };

  const startsWithHttps = /^https:\/\//i.test(RAW_URL);
  let parsed = null;
  try {
    parsed = new globalThis.URL(RAW_URL);
  } catch {
    /* not a URL */
  }
  const host = parsed?.hostname ?? "";
  const hostIsSupabase = /\.supabase\.(co|in|net|io)$/i.test(host);

  if (!parsed || !hostIsSupabase) {
    log("❌ NEXT_PUBLIC_SUPABASE_URL is not a valid Supabase project API URL.");
    log("   It must be EXACTLY:  https://<your-project-ref>.supabase.co");
    log("   Find it in Supabase → Settings → API → 'Project URL' (or 'Data API').");
    log("   Common mistakes: missing https://, just the project ref, the browser");
    log("   dashboard URL, a connection string, or the wrong value in this secret.");
    log(
      `   diagnostics (no secret shown) → length=${RAW_URL.length} ` +
        `startsWithHttps=${startsWithHttps} parsesAsUrl=${!!parsed} ` +
        `hostIsSupabase=${hostIsSupabase} looksLikeJwtKey=${RAW_URL.startsWith("eyJ")}`
    );
    return { status: "bad" };
  }

  if (!ANON.startsWith("eyJ"))
    log("⚠  NEXT_PUBLIC_SUPABASE_ANON_KEY doesn't start with 'eyJ' — use the Legacy 'anon public' key.");
  if (!SERVICE.startsWith("eyJ"))
    log("⚠  SUPABASE_SERVICE_ROLE_KEY doesn't start with 'eyJ' — use the Legacy 'service_role secret' key.");

  return { status: "ok", URL: parsed.origin, ANON, SERVICE };
}

const SKIP_MSG =
  "⏭  Skipped — set NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, " +
  "and SUPABASE_SERVICE_ROLE_KEY (a dedicated TEST project) to run.";

/** Resolve env or exit the process: 0 when skipped (no secrets), 1 when the
 *  config is present-but-invalid. Returns {URL, ANON, SERVICE} on success. */
export function requireSupabaseEnvOrExit() {
  const r = resolveSupabaseEnv();
  if (r.status === "skip") {
    log(SKIP_MSG);
    process.exit(0);
  }
  if (r.status === "bad") process.exit(1);
  return r;
}
