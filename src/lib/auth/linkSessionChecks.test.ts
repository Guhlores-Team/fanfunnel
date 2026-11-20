import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startFakeAuthServer } from "../../../scripts/test/fake-auth-server.mjs";
import { runLinkSessionChecks, LINK_TEST_EMAIL } from "../../../scripts/security/link-session-checks.mjs";

// The hosted check for review A1 (scripts/security/link-session-runtime-test.mjs)
// cannot run here: it needs the TEST project's keys. This holds the script
// itself to account locally:
//   - a dry run of its checks against the in-memory Auth server passes when
//     that server issues `otp` (and the legacy link methods), cleans up every
//     user it made, and FAILS when the server issues a method the app's rule
//     does not accept (so a wrong assumption about the hosted server cannot
//     pass silently);
//   - the command line refuses production, any project that is not the fixed
//     TEST project, and missing keys, before it makes a single request.
// A dry run says nothing about the hosted Auth server's real behaviour.

let passed = 0;
function check(label: string, cond: unknown) {
  assert.ok(cond, label);
  passed++;
}

async function dryRun(linkAmr: string | ((type: string) => string)) {
  const fake = await startFakeAuthServer({ linkAmr });
  const lines: string[] = [];
  const result = await runLinkSessionChecks({ url: fake.url, anonKey: fake.anonKey, serviceKey: fake.serviceKey, log: (l: string) => lines.push(l) });
  const left = [...fake.users.values()].filter((u) => LINK_TEST_EMAIL.test(u.email)).length;
  await fake.close();
  return { ...result, lines, left };
}

async function main() {
  let run = await dryRun("otp");
  check("dry run with an otp-issuing server: every check passes", run.failures === 0 && !run.cleanupFailed);
  check("…it saw otp for recovery, magic link and invitation", ["recovery", "magiclink", "invite"].every((k) => run.methods[k]?.join() === "otp"));
  check("…it asserted the app's own rule, the negative and the single-use refusal", ["openedByRecentLink() accepts", "NEGATIVE: a password sign-in is NOT a link session", "stops accepting it one hour after", "refused as otp_expired", "does not extend", "sets a new password", "sets its first password"].every((needle) => run.lines.some((l) => l.includes(needle) || (needle === "does not extend" && l.includes("not extended")))));
  check("…and deleted every user it created", run.left === 0);

  run = await dryRun((type) => type);
  check("dry run with a server that keeps the link's own type (recovery / magiclink / invite): passes too", run.failures === 0 && run.methods.recovery?.join() === "recovery" && run.methods.invite?.join() === "invite" && run.left === 0);

  for (const method of ["password", "email/signup", "email"]) {
    run = await dryRun(method);
    check(`dry run with a server that issues ${method}: the script FAILS (it cannot pass on a wrong assumption)`, run.failures > 0);
    check(`…and still cleans up`, run.left === 0 && !run.cleanupFailed);
  }

  // The command line's guards (no network: each refusal comes first, and the
  // script is told not to read .env.local, so a developer's real keys can
  // never turn one of these cases into a run against a hosted project).
  const script = join(import.meta.dirname, "../../../scripts/security/link-session-runtime-test.mjs");
  const cli = (env: Record<string, string>) => {
    const r = spawnSync(process.execPath, [script], { env: { NODE_ENV: "test", PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", LINK_SESSION_TEST_ENV_FILE: "off", ...env }, encoding: "utf8", timeout: 30_000 });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  };
  const KEYS = { NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon", SUPABASE_SERVICE_ROLE_KEY: "service" };
  let r = cli({ NEXT_PUBLIC_SUPABASE_URL: "https://ttlogfmogcccwiraaoae.supabase.co", ...KEYS });
  check("the command line refuses the PRODUCTION project", r.status === 1 && /Refusing to run: .*PRODUCTION/.test(r.out));
  r = cli({ NEXT_PUBLIC_SUPABASE_URL: "https://TTLOGFMOGCCCWIRAAOAE.supabase.co/", ...KEYS });
  check("…in any letter case", r.status === 1 && /PRODUCTION/.test(r.out));
  r = cli({ NEXT_PUBLIC_SUPABASE_URL: "https://someotherproject.supabase.co", ...KEYS });
  check("…and any project that is not the fixed TEST project", r.status === 1 && /fixed FanFunnel TEST project is required/.test(r.out));
  r = cli({ NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321", ...KEYS });
  check("…and a local URL", r.status === 1 && /fixed FanFunnel TEST project is required/.test(r.out));
  r = cli({ NEXT_PUBLIC_SUPABASE_URL: "https://someotherproject.supabase.co", RLS_TEST_REQUIRE_REF: "snmcrmhgevfqggxdiomu", ...KEYS });
  check("…and a URL that is not the ref CI requires", r.status === 1 && /not the expected project/.test(r.out));
  r = cli({ NEXT_PUBLIC_SUPABASE_URL: "https://snmcrmhgevfqggxdiomu.supabase.co" });
  check("missing keys are a failure, not a pass", r.status === 1 && /Need NEXT_PUBLIC_SUPABASE_URL/.test(r.out));
  const source = readFileSync(script, "utf8");
  check("the refusals come before the checks module is loaded", /import\("\.\/link-session-checks\.mjs"\)/.test(source) && !/^import .*link-session-checks/m.test(source));

  // The workflow step that runs the RLS runtime test runs this one too.
  const workflow = readFileSync(join(import.meta.dirname, "../../../.github/workflows/e2e-supabase.yml"), "utf8");
  const step = workflow.slice(workflow.indexOf("RLS runtime test — tenant isolation"));
  check("CI's hosted job runs it right after the RLS runtime test, in the same guarded step", /node scripts\/security\/rls-runtime-test\.mjs\n\s+npx tsx scripts\/security\/link-session-runtime-test\.mjs/.test(step) && step.indexOf("link-session-runtime-test.mjs") < step.indexOf("test-maintenance:"));

  console.log(`linkSessionChecks.test: ${passed} checks passed`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
