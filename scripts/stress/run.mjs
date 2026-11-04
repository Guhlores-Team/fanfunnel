#!/usr/bin/env node
// A26 load/abuse harness. Fully local: DB-level concurrency on a disposable
// PostgreSQL 16 (PG_BIN) and HTTP-level load/abuse against a local `next start`
// in demo/debug mode. Never points at a hosted project: the DB side only dials
// its own socket, the HTTP side refuses any non-loopback base URL.
//
//   npm run stress                       both halves, full size
//   node scripts/stress/run.mjs --db     DB scenarios only
//   node scripts/stress/run.mjs --http   HTTP scenarios only (needs `npm run build` first)
//   --quick            smaller sizes (smoke)
//   --only D4,H2       run only these scenario ids
//   --out <file.json>  write the full report (default scripts/stress/last-run.json is NOT written; pass a path)
//   STRESS_BASE_URL    reuse an already running local server instead of starting one
//   STRESS_PORT        port for the server the harness starts (default 3274)
//   STRESS_SOFT_LATENCY=1  a p95 breach warns instead of failing
//   STRESS_STRICT=1        documented known bugs (STRESS_RESULTS.md) fail the run instead of printing KNOWN-BUG
// Exit code 1 on any invariant violation, 5xx, or (unless soft) latency breach.
import { writeFileSync } from "node:fs";
import { Report } from "./metrics.mjs";

const args = new Set(process.argv.slice(2));
const quick = args.has("--quick"), wantDb = args.has("--db") || !args.has("--http"), wantHttp = args.has("--http") || !args.has("--db");
const outIndex = process.argv.indexOf("--out"), out = outIndex > 0 ? process.argv[outIndex + 1] : null;
const onlyIndex = process.argv.indexOf("--only"), only = onlyIndex > 0 ? new Set(process.argv[onlyIndex + 1].split(",")) : null;
const report = new Report();
const started = Date.now();
let failed = false;
try {
  if (wantDb) {
    const { startLocalDatabase } = await import("./localdb.mjs");
    const { runDbScenarios } = await import("./db.mjs");
    const t = Date.now(), db = await startLocalDatabase({ poolSize: 32 });
    console.log(`local postgres ready in ${Date.now() - t}ms (pool ${db.pool.size})`);
    try { await runDbScenarios(report, { sql: db.sql, pool: db.pool, quick, only }); } finally { db.stop(); }
  }
  if (wantHttp) {
    const { runHttpScenarios } = await import("./http.mjs");
    await runHttpScenarios(report, { quick, only });
  }
} catch (e) {
  failed = true;
  console.error("\nharness error:", e?.stack ?? e);
  if (report.current) { report.check(false, `harness error: ${e?.message ?? e}`); report.finish(); }
}
const failures = report.failures;
console.log(`\n${"=".repeat(60)}\n${report.scenarios.length} scenarios in ${Math.round((Date.now() - started) / 1000)}s, ${failures.length} failure(s)`);
for (const f of failures) console.log("  FAIL " + f);
for (const k of report.knownBugs) console.log("  KNOWN-BUG " + k);
console.log("\n" + report.markdown());
if (out) { writeFileSync(out, JSON.stringify(report.toJSON(), null, 1)); console.log(`\nreport written to ${out}`); }
process.exitCode = failed || failures.length ? 1 : 0;
