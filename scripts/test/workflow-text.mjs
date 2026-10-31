// @ts-check
// Minimal, dependency-free readers for this repository's workflow YAML, used by
// the workflow-guard tests in scripts/test/. They rely on the files' fixed
// two-space layout (jobs at 2 spaces, steps at 6) rather than a YAML parser,
// and throw when a job is missing so a renamed job fails its guard loudly.

import { readFileSync } from "node:fs";

/** @param {string} name e.g. "e2e-supabase.yml" */
export const readWorkflow = (name) =>
  readFileSync(new URL(`../../.github/workflows/${name}`, import.meta.url), "utf8");

/** Text of one job (from its `  id:` line to the next top-level job). @param {string} wf @param {string} id */
export function jobBlock(wf, id) {
  const start = wf.indexOf(`\n  ${id}:\n`);
  if (start < 0) throw new Error(`job ${id} not found`);
  const rest = wf.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[A-Za-z0-9_-]+:\n/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

/** Steps of a job block, each as its own text. @param {string} job */
export function steps(job) {
  const i = job.indexOf("\n    steps:\n");
  if (i < 0) throw new Error("job has no steps");
  return job
    .slice(i + "\n    steps:\n".length)
    .split(/\n(?= {6}- )/)
    .map((s) => s.replace(/^\n/, ""))
    .filter((s) => s.trim().startsWith("- "));
}

/** The `if:` condition of a step, or "" when unconditional. @param {string} step */
export function stepIf(step) {
  const m = /^ {6}(?:- | {2})if: (.+)$/m.exec(step);
  return m ? m[1].trim() : "";
}
