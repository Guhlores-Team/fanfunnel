// @ts-check
// SC-07: the PR migration job (`test` in supabase-migrations.yml) needs the
// TEST environment's secrets. Dependabot PRs get only Dependabot secrets and
// fork PRs get none, so the job used to fail on every one of them: a
// permanently red check that teaches the owner to ignore red. This gate skips
// the job VISIBLY (a ::notice annotation, a job-summary line and `run=false`)
// only when BOTH hold:
//   - the PR is untrusted for secrets (actor `dependabot[bot]`, or the head
//     repository differs from this one), and
//   - the PR changes nothing under `supabase/` (so there is nothing to apply).
// Anything else, including an untrusted PR that does touch `supabase/`, runs
// the job and lets it fail closed on the missing secrets.
//
//   CHANGED_FILES="$(gh api --paginate repos/$REPO/pulls/$PR/files --jq '.[].filename')" \
//   node scripts/ci/migration-test-gate.mjs
//
// Pure: no network; it only reads env and writes GITHUB_OUTPUT / GITHUB_STEP_SUMMARY.

import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const DB_PATH = /^supabase\//;

/**
 * @param {Record<string, string | undefined>} env
 * @returns {{ run: boolean, reason: string, untrusted: boolean, touchesDb: boolean }}
 */
export function decide(env) {
  const repo = (env.REPOSITORY ?? "").toLowerCase();
  const headRepo = (env.HEAD_REPO ?? "").toLowerCase();
  const actor = env.ACTOR ?? "";
  const files = (env.CHANGED_FILES ?? "").split(/\r?\n/).map((f) => f.trim()).filter(Boolean);
  const fork = headRepo !== "" && repo !== "" && headRepo !== repo;
  const untrusted = actor === "dependabot[bot]" || fork;
  const touchesDb = files.some((f) => DB_PATH.test(f));
  if (untrusted && !touchesDb) {
    const who = actor === "dependabot[bot]" ? "a Dependabot PR" : `a fork PR (${headRepo})`;
    return { run: false, untrusted, touchesDb, reason: `${who} that changes nothing under supabase/ has no TEST secrets and nothing to apply` };
  }
  return { run: true, untrusted, touchesDb, reason: untrusted ? "untrusted PR touches supabase/: run and fail closed on missing secrets" : "same-repository PR: apply to TEST" };
}

/** @param {Record<string, string | undefined>} env */
export function main(env = process.env) {
  const d = decide(env);
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `run=${d.run ? "true" : "false"}\n`);
  if (!d.run) {
    console.log(`::notice title=TEST migrations not run::${d.reason}. The job is skipped, not failed; a PR that changes supabase/ always runs it.`);
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `**TEST migrations: NOT RUN** — ${d.reason}.\n`);
  } else {
    console.log(`TEST migrations: ${d.reason}.`);
  }
  return d;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
