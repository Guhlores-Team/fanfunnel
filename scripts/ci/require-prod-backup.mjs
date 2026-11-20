// @ts-check
// SC-01 / OPS-03: the production migration job runs `supabase db push` against
// LIVE with no backup step of its own, and nothing the CLI can do without new
// secrets takes one (a `db dump` on a public-repository runner would only copy
// fan data into a job log). What the job CAN do with the account token it
// already holds is read the Management API's backup list for the LIVE project
// and refuse to push unless a completed backup, or a PITR base backup, is
// recent. So this runs BEFORE `supabase db push` in `db-migrations-production`:
//
//   SUPABASE_ACCESS_TOKEN=… PROD_PROJECT_REF=… node scripts/ci/require-prod-backup.mjs
//
// Pass: a `COMPLETED` daily backup inserted within MAX_AGE_HOURS, or
// `pitr_enabled` with a physical backup within MAX_AGE_HOURS. Everything else
// fails closed (no backup, a plan without backups, an API error, an unparseable
// body). The one override is the repository VARIABLE (not a secret)
// PROD_BACKUP_POLICY=accept-no-backup, set knowingly by the owner and
// documented in docs/GO_LIVE.md section 5; it turns the refusal into a warning.
// GET only; the token never reaches a log line.

import { pathToFileURL } from "node:url";

export const MAX_AGE_HOURS = 36;
export const ACCEPT_NO_BACKUP = "accept-no-backup";
const API = "https://api.supabase.com/v1";

/** @param {unknown} v */
const str = (v) => (typeof v === "string" ? v : "");

/**
 * Decide from the API body alone. Returns `ok` plus one human line.
 * @param {unknown} body
 * @param {number} nowMs
 */
export function evaluateBackups(body, nowMs = Date.now()) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, line: "backup listing is not an object (fail closed)" };
  const b = /** @type {Record<string, unknown>} */ (body);
  const maxAgeMs = MAX_AGE_HOURS * 3_600_000;
  const backups = Array.isArray(b.backups) ? b.backups : [];
  let newest = -Infinity;
  for (const item of backups) {
    if (!item || typeof item !== "object") continue;
    const row = /** @type {Record<string, unknown>} */ (item);
    if (str(row.status).toUpperCase() !== "COMPLETED") continue;
    const t = Date.parse(str(row.inserted_at));
    if (Number.isFinite(t)) newest = Math.max(newest, t);
  }
  if (Number.isFinite(newest) && nowMs - newest <= maxAgeMs && nowMs - newest >= -maxAgeMs) {
    return { ok: true, line: `completed LIVE backup from ${new Date(newest).toISOString()} (${Math.round((nowMs - newest) / 3_600_000)} h ago)` };
  }
  const physical = b.physical_backup_data;
  if (b.pitr_enabled === true && physical && typeof physical === "object") {
    const latest = /** @type {Record<string, unknown>} */ (physical).latest_physical_backup_date_unix;
    if (typeof latest === "number" && Number.isFinite(latest)) {
      const ms = latest * 1000;
      if (nowMs - ms <= maxAgeMs && nowMs - ms >= -maxAgeMs) return { ok: true, line: `PITR is on with a physical backup from ${new Date(ms).toISOString()}` };
    }
  }
  if (backups.length === 0 && b.pitr_enabled !== true) return { ok: false, line: "the LIVE project lists no backups at all (Free plan, or backups not yet enabled)" };
  return { ok: false, line: `no completed backup within the last ${MAX_AGE_HOURS} h (newest: ${Number.isFinite(newest) ? new Date(newest).toISOString() : "none"})` };
}

/**
 * @param {Record<string, string | undefined>} env
 * @param {typeof fetch} fetcher
 */
export async function main(env = process.env, fetcher = fetch) {
  const token = env.SUPABASE_ACCESS_TOKEN ?? "";
  const ref = env.PROD_PROJECT_REF ?? "";
  const policy = (env.PROD_BACKUP_POLICY ?? "").trim();
  const override = policy === ACCEPT_NO_BACKUP;
  /** @param {string} line */
  const refuse = (line) => {
    if (override) {
      console.log(`::warning title=PRODUCTION migrations without a verified backup::${line}. Continuing only because the repository variable PROD_BACKUP_POLICY=${ACCEPT_NO_BACKUP} is set (docs/GO_LIVE.md section 5).`);
      return 0;
    }
    console.log(`::error title=PRODUCTION backup not verified::${line}. The production migration job refuses to run \`supabase db push\` without a recent LIVE backup. Take one (Supabase -> Database -> Backups, Pro plan) and re-run the job, or set the repository variable PROD_BACKUP_POLICY=${ACCEPT_NO_BACKUP} knowingly (docs/GO_LIVE.md section 5).`);
    return 1;
  };
  if (!/^[a-z]{20}$/.test(ref)) return refuse("PROD_PROJECT_REF is not a Supabase project ref");
  if (token.length < 20) return refuse("SUPABASE_ACCESS_TOKEN is missing");
  let body;
  try {
    const res = await fetcher(`${API}/projects/${ref}/database/backups`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return refuse(`the backup listing answered HTTP ${res.status}`);
    body = await res.json();
  } catch {
    return refuse("the backup listing could not be read");
  }
  const verdict = evaluateBackups(body);
  if (!verdict.ok) return refuse(verdict.line);
  console.log(`LIVE backup verified: ${verdict.line}.`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code), (e) => {
    console.log(`::error title=PRODUCTION backup not verified::${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
