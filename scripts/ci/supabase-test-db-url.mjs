// @ts-check
// SUP-1: the PR migration job reaches TEST with a TEST-only database URL instead
// of the Supabase account token (which reaches every project, PROD included).
// This guard refuses to hand `supabase db push --db-url` anything but the TEST
// project's own database, so a mis-pasted secret cannot write elsewhere.
//
//   env TEST_DB_URL=... node scripts/ci/supabase-test-db-url.mjs
//   exit 0, or exit 1 with an ::error annotation that never echoes the URL.
//
// Accepted shapes (Supabase dashboard -> Connect):
//   postgresql://postgres.<TEST ref>:<pw>@aws-<n>-<region>.pooler.supabase.com:5432/postgres  (session pooler)
//   postgresql://postgres:<pw>@db.<TEST ref>.supabase.co:5432/postgres                         (direct, IPv6)

import { pathToFileURL } from "node:url";

export const TEST_REF = "snmcrmhgevfqggxdiomu";
export const PROD_REF = "ttlogfmogcccwiraaoae";
const POOLER_HOST = /^aws-[0-9]+-[a-z0-9-]+\.pooler\.supabase\.com$/;

/** @param {string | undefined} value @returns {string | null} problem code, or null when it is the TEST database */
export function testDbUrlProblem(value, ref = TEST_REF) {
  if (typeof value !== "string" || !value.trim()) return "TEST_DB_URL_MISSING";
  if (value.includes(PROD_REF)) return "PRODUCTION_REF_REFUSED";
  let url;
  try {
    url = new URL(value);
  } catch {
    return "TEST_DB_URL_UNPARSEABLE";
  }
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") return "TEST_DB_URL_NOT_POSTGRES";
  if (!url.password) return "TEST_DB_URL_NO_PASSWORD";
  if (url.pathname !== "/postgres" || url.hash) return "TEST_DB_URL_WRONG_DATABASE";
  // 6543 is the transaction pooler: `db push` needs a session (5432).
  if (url.port !== "5432") return "TEST_DB_URL_NOT_SESSION_PORT";
  const pooled = url.username === `postgres.${ref}` && POOLER_HOST.test(url.hostname);
  const direct = url.username === "postgres" && url.hostname === `db.${ref}.supabase.co`;
  if (!pooled && !direct) return "TEST_DB_URL_NOT_TEST_PROJECT";
  return null;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const problem = testDbUrlProblem(process.env.TEST_DB_URL);
  if (problem) {
    console.log(`::error title=TEST database URL refused::${problem}. SUPABASE_TEST_DB_URL must be the TEST project's (${TEST_REF}) session-pooler or direct connection string on port 5432.`);
    process.exit(1);
  }
  console.log(`TEST database URL points at ${TEST_REF}.`);
}
