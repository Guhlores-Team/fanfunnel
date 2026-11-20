// @ts-check
// A39: read-back proof that a linked Supabase project has every migration this
// commit ships, and nothing this commit does not know about.
//
//   supabase migration list --linked --password ... | node scripts/ci/verify-migrations-applied.mjs [--label PRODUCTION]
//
// `supabase db push` exiting 0 is not treated as proof on its own: this re-reads
// the remote history after the push and fails (exit 1, ::error annotation) when
//   - a migration file in supabase/migrations/ has no Remote entry,
//   - the Remote history has a version with no local file (drift/hand-applied),
//   - the listing has no rows or cannot be parsed (fail closed).
// The production job in supabase-migrations.yml runs this on every push to main;
// that job is the Vercel Deployment Check that holds Production traffic (see
// docs/GO_LIVE.md section 5), so new code is not promoted before this passes.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const MIGRATIONS_DIR = join(import.meta.dirname, "../../supabase/migrations");

/** Versions of the migration files, as the Supabase CLI derives them (prefix before the first `_`).
 *  @param {string[]} files */
export function localVersions(files) {
  const versions = files
    .filter((f) => f.endsWith(".sql"))
    .map((f) => {
      const m = /^(\d+)_[^/\\]+\.sql$/.exec(f);
      if (!m) throw new Error(`MIGRATION_NAME_UNPARSEABLE: ${f}`);
      return m[1];
    });
  if (new Set(versions).size !== versions.length) throw new Error("MIGRATION_VERSION_DUPLICATED");
  return versions.sort();
}

// The CLI builds a markdown table (`|Local|Remote|Time (UTC)|`, cells wrapped in
// backticks, an absent cell as "` `") and renders it with glamour's ASCII style:
// no outer border, cells joined by `|` and a dash separator line (CLI 2.122.0,
// apps/cli/src/output/glamour-table.ts). Older glamour builds draw the same
// table with box characters (`│`, `─`, `┼`) and some upper-case the header, so
// both are accepted; anything else with a column separator fails closed.
const COLUMN = /[|│]/;
const SEPARATOR_CELL = /^[-+:─┼]*$/;

/** One cell: trimmed, with one pair of surrounding backticks removed. @param {string} c */
const cell = (c) => {
  const s = c.trim();
  const m = /^`(.*)`$/s.exec(s);
  return (m ? m[1] : s).trim();
};

/**
 * Parse `supabase migration list` table output into {local, remote} rows.
 * Header and separator lines are recognised and skipped; any other line with a
 * column separator must have at least two cells, each empty or a bare version
 * number, and at least one of them non-empty.
 * @param {string} text
 */
export function parseMigrationList(text) {
  /** @type {{ local: string, remote: string }[]} */
  const rows = [];
  let sawHeader = false;
  for (const raw of String(text).split(/\r?\n/)) {
    if (!COLUMN.test(raw)) continue;
    let cells = raw.split(COLUMN).map(cell);
    // A bordered table (`| a | b |`) yields empty outer cells; drop them.
    if (COLUMN.test(raw.trim()[0] ?? "") && cells.length > 2 && cells[0] === "" && cells.at(-1) === "") {
      cells = cells.slice(1, -1);
    }
    if (/^local$/i.test(cells[0] ?? "") && /^remote$/i.test(cells[1] ?? "")) {
      sawHeader = true;
      continue;
    }
    if (cells.every((c) => SEPARATOR_CELL.test(c))) continue;
    if (!sawHeader) throw new Error("MIGRATION_LIST_UNPARSEABLE: table row before the Local | Remote header");
    const [local, remote] = cells;
    if (!/^\d*$/.test(local ?? "x") || !/^\d*$/.test(remote ?? "x") || (!local && !remote)) {
      throw new Error("MIGRATION_LIST_UNPARSEABLE: unexpected row");
    }
    rows.push({ local: local ?? "", remote: remote ?? "" });
  }
  if (!sawHeader) throw new Error("MIGRATION_LIST_UNPARSEABLE: no Local | Remote header");
  return rows;
}

/**
 * @param {string[]} expected local migration versions shipped by this commit
 * @param {{ local: string, remote: string }[]} rows parsed listing
 * @returns {{ ok: boolean, problems: string[], latest: string }}
 */
export function compareHistory(expected, rows) {
  const problems = [];
  const remote = new Set(rows.map((r) => r.remote).filter(Boolean));
  if (expected.length === 0) problems.push("no local migrations found");
  if (rows.length === 0) problems.push("the remote listing has no rows");
  const notApplied = expected.filter((v) => !remote.has(v));
  if (notApplied.length) problems.push(`not applied remotely: ${notApplied.join(", ")}`);
  const unknown = [...remote].filter((v) => !expected.includes(v)).sort();
  if (unknown.length) problems.push(`remote history has versions with no file in this commit: ${unknown.join(", ")}`);
  const listedLocal = new Set(rows.map((r) => r.local).filter(Boolean));
  const unlisted = expected.filter((v) => !listedLocal.has(v));
  if (unlisted.length) problems.push(`the CLI did not list these local files (wrong checkout?): ${unlisted.join(", ")}`);
  return { ok: problems.length === 0, problems, latest: expected.at(-1) ?? "" };
}

/** @param {string} listing @param {string[]} files @param {string} label */
export function verify(listing, files, label) {
  let result;
  try {
    result = compareHistory(localVersions(files), parseMigrationList(listing));
  } catch (error) {
    result = { ok: false, problems: [String(error instanceof Error ? error.message : error)], latest: "" };
  }
  const lines = result.ok
    ? [`${label}: all ${files.filter((f) => f.endsWith(".sql")).length} migrations through ${result.latest} are applied; no unknown remote versions.`]
    : result.problems.map((p) => `::error title=${label} migrations not verified::${p}`);
  return { ok: result.ok, lines };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const i = process.argv.indexOf("--label");
  const label = i >= 0 ? String(process.argv[i + 1]) : "Database";
  const { ok, lines } = verify(readFileSync(0, "utf8"), readdirSync(MIGRATIONS_DIR), label);
  for (const line of lines) console.log(line);
  process.exit(ok ? 0 : 1);
}
