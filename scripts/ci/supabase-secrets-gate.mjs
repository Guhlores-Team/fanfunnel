// @ts-check
// A25: decides whether a real-Supabase CI job may run, must fail, or may skip.
//
// The real-Supabase, RLS-runtime and login-UI tests used to exit 0 with only a
// warning when the TEST secrets were absent, so a misconfigured repository (or a
// Dependabot PR) showed a green security check that ran nothing. This gate makes
// a missing secret a FAILURE everywhere except a pull request from a fork, where
// GitHub withholds repository secrets by design. That one skip is announced with
// a warning annotation and a job-summary line, and every gated step shows as
// "skipped" in the checks UI instead of as a passing test.
//
// The workflow passes only presence booleans (`secrets.X != ''`), never values.
//
//   env: EVENT_NAME, REPOSITORY, HEAD_REPO, REF, BASE_REF, ACTOR,
//        HAS_SUPABASE_URL, HAS_SUPABASE_ANON_KEY, HAS_SUPABASE_SERVICE_ROLE_KEY,
//        GATE_JOB (label), GITHUB_OUTPUT, GITHUB_STEP_SUMMARY (both optional)
//   exit 0 + output run=true|false, or exit 1 with an ::error annotation.

import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const SECRET_NAMES = Object.freeze([
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
]);
export const PROTECTED_BRANCHES = Object.freeze(["main", "dashboard-redesign"]);

/** @param {string | undefined} v */
const truthy = (v) => v === "true";

/**
 * @param {{ eventName?: string, repository?: string, headRepo?: string, ref?: string,
 *   baseRef?: string, actor?: string, present: Record<string, boolean> }} ctx
 * @returns {{ action: "run" | "skip" | "fail", missing: string[], target: string, reason: string }}
 */
export function decide(ctx) {
  const missing = SECRET_NAMES.filter((name) => ctx.present[name] !== true);
  const target =
    ctx.eventName === "pull_request" ? String(ctx.baseRef || "") : String(ctx.ref || "").replace(/^refs\/heads\//, "");
  if (missing.length === 0) return { action: "run", missing, target, reason: "all TEST secrets present" };
  // A fork PR is the one context where GitHub withholds secrets by design. It is
  // recognised only from a positively different head repository: an empty or
  // unknown head repository is not proof of a fork and fails closed.
  const headRepo = String(ctx.headRepo || "");
  const isForkPr =
    ctx.eventName === "pull_request" &&
    headRepo !== "" &&
    String(ctx.repository || "") !== "" &&
    headRepo.toLowerCase() !== String(ctx.repository).toLowerCase();
  if (isForkPr && missing.length === SECRET_NAMES.length) {
    return { action: "skip", missing, target, reason: `fork pull request from ${headRepo}: repository secrets are withheld by design` };
  }
  const protectedTarget = PROTECTED_BRANCHES.includes(target);
  let reason = `TEST secrets missing on ${ctx.eventName || "unknown event"} targeting ${target || "an unknown ref"}`;
  if (protectedTarget) reason += ` (a protected branch: ${PROTECTED_BRANCHES.join(", ")})`;
  if (isForkPr) reason += "; a fork PR with only some secrets set is a misconfiguration";
  if (ctx.actor === "dependabot[bot]") {
    reason += "; Dependabot PRs read Dependabot secrets, so add the same three names under Settings > Secrets > Dependabot";
  }
  return { action: "fail", missing, target, reason };
}

/** GitHub annotation text must not contain raw newlines or the % escape char. */
const esc = (s) => String(s).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");

/** @param {NodeJS.ProcessEnv} env @param {(line: string) => void} log */
export function runGate(env, log = (line) => console.log(line)) {
  const result = decide({
    eventName: env.EVENT_NAME,
    repository: env.REPOSITORY,
    headRepo: env.HEAD_REPO,
    ref: env.REF,
    baseRef: env.BASE_REF,
    actor: env.ACTOR,
    present: {
      NEXT_PUBLIC_SUPABASE_URL: truthy(env.HAS_SUPABASE_URL),
      NEXT_PUBLIC_SUPABASE_ANON_KEY: truthy(env.HAS_SUPABASE_ANON_KEY),
      SUPABASE_SERVICE_ROLE_KEY: truthy(env.HAS_SUPABASE_SERVICE_ROLE_KEY),
    },
  });
  const job = env.GATE_JOB || "real-Supabase tests";
  if (env.GITHUB_OUTPUT) {
    appendFileSync(env.GITHUB_OUTPUT, `run=${result.action === "run"}\naction=${result.action}\n`);
  }
  const summary = (line) => {
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, line + "\n");
  };
  if (result.action === "run") {
    log(`${job}: TEST secrets present; the real tests run.`);
    summary(`- ${job}: ran against the TEST project.`);
    return 0;
  }
  if (result.action === "skip") {
    log(`::warning title=${esc(job)} NOT run (fork PR)::${esc(result.reason)}. The security tests in this job did NOT run; a maintainer must re-run them from a same-repository branch before merging.`);
    summary(`- **${job}: NOT RUN** (${result.reason}). This green check is not evidence that the security tests passed.`);
    return 0;
  }
  log(`::error title=${esc(job)}: TEST secrets missing::${esc(result.reason)}. Missing: ${result.missing.join(", ")}. Set them as repository Actions secrets for the dedicated TEST project; a missing secret no longer counts as a pass.`);
  summary(`- **${job}: FAILED**: missing ${result.missing.join(", ")} (${result.reason}).`);
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(runGate(process.env));
}
