// @ts-check
// Builds a project's session-pooler database URL (port 5432) from the
// Management API's pooler config plus the database password, so the CLI can
// run `db push --db-url` / `migration list --db-url` without `supabase link`.
// Why: CLI 2.122.1 refuses Supabase's project-scoped access tokens ("Invalid
// access token format") before sending them, and `link` needs one. Fetching
// the pooler host here keeps the token away from the CLI entirely.
//
//   POOLER_REF=… POOLER_TOKEN=… POOLER_DB_PASSWORD=… node scripts/ci/pooler-db-url.mjs
//
// Prints the URL on stdout only (capture it in a shell variable; the password
// is a masked secret). GET only. Neither the token nor the password reaches a
// log line; refusals name the API status and what was wrong with the answer.

import { pathToFileURL } from "node:url";
import { POOLER_HOST } from "./supabase-test-db-url.mjs";

const API = "https://api.supabase.com/v1";
const REF = /^[a-z]{20}$/;

/**
 * Pick the primary pooler entry and build the session-mode URL.
 * @param {unknown} body @param {string} ref @param {string} password
 * @returns {{ url: string } | { problem: string }}
 */
export function buildPoolerUrl(body, ref, password) {
  const list = Array.isArray(body) ? body : body && typeof body === "object" ? [body] : [];
  const entries = list.filter((e) => e && typeof e === "object");
  const entry = /** @type {Record<string, unknown> | undefined} */ (entries.find((e) => e.database_type === "PRIMARY") ?? entries[0]);
  if (!entry) return { problem: "the pooler config holds no entry" };
  let user = typeof entry.db_user === "string" ? entry.db_user : "";
  let host = typeof entry.db_host === "string" ? entry.db_host : "";
  let name = typeof entry.db_name === "string" && entry.db_name ? entry.db_name : "postgres";
  const cs = typeof entry.connection_string === "string" ? entry.connection_string : "";
  if ((!user || !host) && cs) {
    try {
      const u = new URL(cs.replace(/\[YOUR-PASSWORD\]/g, "x"));
      user ||= decodeURIComponent(u.username);
      host ||= u.hostname;
      name = u.pathname.replace(/^\//, "") || name;
    } catch {
      return { problem: "the pooler connection string does not parse" };
    }
  }
  if (user !== `postgres.${ref}`) return { problem: "the pooler user is not this project's" };
  if (!POOLER_HOST.test(host)) return { problem: "the pooler host is not a Supabase pooler" };
  if (name !== "postgres") return { problem: "the pooler database is not postgres" };
  return { url: `postgresql://${user}:${encodeURIComponent(password)}@${host}:5432/postgres` };
}

/**
 * @param {Record<string, string | undefined>} env
 * @param {typeof fetch} fetchImpl
 * @param {{ out: (s: string) => void, log: (s: string) => void }} io
 * @returns {Promise<number>}
 */
export async function main(env, fetchImpl = fetch, io = { out: (s) => process.stdout.write(s), log: (s) => console.error(s) }) {
  const ref = env.POOLER_REF ?? "";
  const token = (env.POOLER_TOKEN ?? "").trim();
  const password = env.POOLER_DB_PASSWORD ?? "";
  const fail = (/** @type {string} */ why) => { io.log(`::error title=Database URL not built::${why}`); return 1; };
  if (!REF.test(ref)) return fail("the project ref is missing or malformed.");
  if (!token) return fail("the Supabase access token is missing.");
  if (!password) return fail("the database password is missing.");
  let res;
  try {
    res = await fetchImpl(`${API}/projects/${ref}/config/database/pooler`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  } catch {
    return fail("the Supabase Management API could not be reached.");
  }
  if (!res.ok) return fail(`the Supabase Management API answered ${res.status} for the pooler config.`);
  let body;
  try {
    body = await res.json();
  } catch {
    return fail("the pooler config is not JSON.");
  }
  const built = buildPoolerUrl(body, ref, password);
  if ("problem" in built) return fail(`${built.problem}.`);
  io.out(built.url);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await main(process.env);
}
