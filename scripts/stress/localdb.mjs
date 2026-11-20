// Disposable local PostgreSQL 16 for the stress harness: the same bootstrap as
// scripts/db/interplay-check.mjs (stub + supabase/schema.sql) on its own
// socket directory and port (54226, never 54221 so it can run beside the drift
// and interplay checks). No Supabase URL or credential is ever read.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, chownSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createPool } from "./pgwire.mjs";

export const STRESS_PG_PORT = 54226;

export async function startLocalDatabase({ poolSize = 32, root = join(import.meta.dirname, "../.."), port = STRESS_PG_PORT } = {}) {
  const bin = process.env.PG_BIN; if (!bin) throw Error("Set PG_BIN to a PostgreSQL 16 bin directory (for example /usr/lib/postgresql/16/bin)");
  const work = mkdtempSync(join(tmpdir(), "ff-stress-"));
  let runAs = {};
  if (process.getuid?.() === 0) { runAs = { uid: Number(spawnSync("id", ["-u", "postgres"], { encoding: "utf8" }).stdout.trim()), gid: Number(spawnSync("id", ["-g", "postgres"], { encoding: "utf8" }).stdout.trim()) }; chownSync(work, runAs.uid, runAs.gid); }
  const run = (tool, args) => { const r = spawnSync(join(bin, tool), args, { encoding: "utf8", cwd: work, ...runAs }); if (r.status !== 0) throw Error(r.stderr); return r.stdout; };
  const psql = ["-U", "postgres", "-X", "-h", work, "-p", String(port), "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-qAt"];
  // STRESS_PG_LOG=<file> keeps the server log (deadlock reports name every statement involved).
  const stop = () => { try { spawnSync(join(bin, "pg_ctl"), ["-D", join(work, "data"), "-m", "immediate", "stop"], { cwd: work, ...runAs }); if (process.env.STRESS_PG_LOG) copyFileSync(join(work, "log"), process.env.STRESS_PG_LOG); } finally { rmSync(work, { recursive: true, force: true }); } };
  try {
    run("initdb", ["-D", join(work, "data"), "-A", "trust", "--no-sync", "-U", "postgres", "-E", "UTF8", "--locale=C"]);
    run("pg_ctl", ["-D", join(work, "data"), "-l", join(work, "log"), "-w", "-o", `-p ${port} -k ${work} -c listen_addresses= -c fsync=off -c max_connections=${poolSize + 20} -c synchronous_commit=off`, "start"]);
    run("psql", [...psql, "-f", join(root, "scripts/db/supabase-stub.sql")]);
    run("psql", [...psql, "-f", join(root, "supabase/schema.sql")]);
    const pool = await createPool(work, port, poolSize);
    return { sql: pool.sql, pool, work, stop: () => { pool.close(); stop(); } };
  } catch (e) { stop(); throw e; }
}
