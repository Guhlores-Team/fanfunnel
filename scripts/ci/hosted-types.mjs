// @ts-check
// SUP-1: the PR job's type check reads the hosted TypeScript generator for the
// TEST project with SUPABASE_TEST_ACCESS_TOKEN, a token scoped to TEST only.
// It calls the Management API directly (the same endpoint `supabase gen types
// --project-id` uses): the pinned CLI 2.122.1 refuses the project-scoped token
// format before sending it. The local `--db-url` generator emits different
// types and can never match src/lib/data/db.types.ts.
//
//   TEST_PROJECT_REF=… TEST_TYPES_TOKEN=… node scripts/ci/hosted-types.mjs > out.ts
//
// GET only. The token never reaches a log line; a refusal prints its shape
// (length, prefix) so a mis-pasted secret can be told from a rejected one.

import { pathToFileURL } from "node:url";
import { TEST_REF } from "./supabase-test-db-url.mjs";

const API = "https://api.supabase.com/v1";

/** @param {string} token */
export function tokenShape(token) {
  return `length ${token.length}, starts with sbp_: ${token.startsWith("sbp_")}, surrounding whitespace: ${token !== token.trim()}`;
}

/**
 * @param {Record<string, string | undefined>} env
 * @param {typeof fetch} fetchImpl
 * @param {{ out: (s: string) => void, log: (s: string) => void }} io
 * @returns {Promise<number>} exit code
 */
export async function main(env, fetchImpl = fetch, io = { out: (s) => process.stdout.write(s), log: (s) => console.error(s) }) {
  const ref = env.TEST_PROJECT_REF ?? "";
  const token = env.TEST_TYPES_TOKEN ?? "";
  if (ref !== TEST_REF) {
    io.log(`::error title=TEST types refused::TEST_PROJECT_REF is not the TEST project (${TEST_REF}).`);
    return 1;
  }
  if (!token) {
    io.log("::error title=TEST types token missing::Add SUPABASE_TEST_ACCESS_TOKEN (a Supabase access token scoped to the TEST project only) to the 'test' environment (docs/GO_LIVE.md, SUP-1).");
    return 1;
  }
  let res;
  try {
    res = await fetchImpl(`${API}/projects/${ref}/types/typescript?included_schemas=public`, {
      headers: { Authorization: `Bearer ${token.trim()}`, Accept: "application/json" },
    });
  } catch {
    io.log("::error title=TEST types not read::The Supabase Management API could not be reached.");
    return 1;
  }
  if (!res.ok) {
    io.log(`::error title=TEST types not read::The Supabase Management API answered ${res.status}. Token shape: ${tokenShape(token)}.`);
    return 1;
  }
  let body;
  try {
    body = await res.json();
  } catch {
    io.log("::error title=TEST types not read::The Supabase Management API answered with something that is not JSON.");
    return 1;
  }
  const types = body && typeof body === "object" && typeof body.types === "string" ? body.types : "";
  if (!types.includes("export type Database")) {
    io.log("::error title=TEST types not read::The Supabase Management API answer holds no TypeScript types.");
    return 1;
  }
  io.out(types);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await main(process.env);
}
