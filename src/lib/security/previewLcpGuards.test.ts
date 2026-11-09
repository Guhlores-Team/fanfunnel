import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  PREVIEW_PROJECT, PREVIEW_TEAM, TEST_ORIGIN, PreviewPerfError, browserEnvironment, checkCheckoutIdentity, checkDeploymentMetadata,
  checkPreflightRecord, failureCode, fixturePhotoUrl, immutablePreviewOrigin, preflightBinding, preflightRecord, previewPerfEnvironment,
  summarizeLcp, verifyPreviewDeployment,
} from "../../../e2e/preview-lcp-guards.mjs";

async function main() {
  let passed = 0;
  const check = (label: string, condition: unknown) => { assert.ok(condition, label); passed++; };
  const env = { GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/heads/dashboard-redesign", GITHUB_REPOSITORY: "Guhlores-Team/fanfunnel", GITHUB_RUN_ID: "123456789",
    PREVIEW_PERF_URL: "https://fanfunnel-a1b2c3d4e-easy-simple-sites.vercel.app", PREVIEW_EXPECTED_SHA: "a".repeat(40), GITHUB_SHA: "a".repeat(40),
    NEXT_PUBLIC_SUPABASE_URL: TEST_ORIGIN, NEXT_PUBLIC_SUPABASE_ANON_KEY: "unit-only-anon", SUPABASE_SERVICE_ROLE_KEY: "unit-only-service", VERCEL_TOKEN: "unit-only-vercel" };
  const refuse = (fn: () => unknown, code: string) => { assert.throws(fn, error => error instanceof PreviewPerfError && error.code === code); passed++; };
  for (const url of ["https://fanfunnel.vercel.app", "https://fanfunnel.com", "https://fanfunnel-git-dashboard-redesign-easy-simple-sites.vercel.app", "https://other-a1b2c3d4e-easy-simple-sites.vercel.app", "http://fanfunnel-a1b2c3d4e-easy-simple-sites.vercel.app", "https://fanfunnel-a1b2c3d4e-easy-simple-sites.vercel.app.evil.test", "https://user@fanfunnel-a1b2c3d4e-easy-simple-sites.vercel.app", "https://fanfunnel-a1b2c3d4e-easy-simple-sites.vercel.app:8443", "https://fanfunnel-a1b2c3d4e-easy-simple-sites.vercel.app/login", "https://fanfunnel-a1b2c3d4e-easy-simple-sites.vercel.app/?token=private", "https://fanfunnel-a1b2c3d4e-easy-simple-sites.vercel.app/#private", "file:///tmp/site", ""]) refuse(() => immutablePreviewOrigin(url), "INVALID_PREVIEW_ORIGIN");
  check("valid immutable URL retains only its origin", immutablePreviewOrigin(env.PREVIEW_PERF_URL + "/") === env.PREVIEW_PERF_URL);
  const browser = browserEnvironment({ PATH: "/bin", HTTPS_PROXY: "http://proxy:8080", NODE_EXTRA_CA_CERTS: "/trusted-ca.pem", SUPABASE_SERVICE_ROLE_KEY: "never-forward", VERCEL_TOKEN: "never-forward", REWARD_ENCRYPTION_KEY: "never-forward", GITHUB_TOKEN: "never-forward", NEXT_PUBLIC_SUPABASE_ANON_KEY: "never-forward" });
  check("server and CI credentials never enter Chromium's child environment", !JSON.stringify(browser).includes("never-forward"));
  check("browser retains network proxy and CA trust settings", browser.HTTPS_PROXY === "http://proxy:8080" && browser.NODE_EXTRA_CA_CERTS === "/trusted-ca.pem");
  for (const changes of [{ GITHUB_EVENT_NAME: "pull_request" }, { GITHUB_EVENT_NAME: "push" }, { GITHUB_REF: "refs/heads/main" }, { GITHUB_REPOSITORY: "fork/fanfunnel" }]) refuse(() => previewPerfEnvironment({ ...env, ...changes }), "MANUAL_PREVIEW_BRANCH_REQUIRED");
  for (const changes of [{ PREVIEW_EXPECTED_SHA: "" }, { PREVIEW_EXPECTED_SHA: "a".repeat(7) }, { PREVIEW_EXPECTED_SHA: "A".repeat(40) }, { GITHUB_SHA: "b".repeat(40) }]) refuse(() => previewPerfEnvironment({ ...env, ...changes }), "SOURCE_SHA_MISMATCH");
  for (const url of ["https://ttlogfmogcccwiraaoae.supabase.co", "https://another.supabase.co", "http://snmcrmhgevfqggxdiomu.supabase.co", TEST_ORIGIN + "/rest/v1", TEST_ORIGIN + "/?key=private", "https://user@snmcrmhgevfqggxdiomu.supabase.co"]) refuse(() => previewPerfEnvironment({ ...env, NEXT_PUBLIC_SUPABASE_URL: url }), "TEST_PROJECT_REQUIRED");
  for (const name of ["NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "VERCEL_TOKEN"]) for (const value of [undefined, "", "   "]) refuse(() => previewPerfEnvironment({ ...env, [name]: value }), "CREDENTIALS_MISSING");
  refuse(() => previewPerfEnvironment({ ...env, GITHUB_RUN_ID: "" }), "WORKFLOW_RUN_REQUIRED");
  const config = previewPerfEnvironment(env);
  checkCheckoutIdentity(env.GITHUB_SHA, env.GITHUB_SHA + "\n", ""); passed++;
  refuse(() => checkCheckoutIdentity(env.GITHUB_SHA, "b".repeat(40), ""), "CHECKOUT_SHA_MISMATCH");
  refuse(() => checkCheckoutIdentity(env.GITHUB_SHA, env.GITHUB_SHA, " M e2e/preview-lcp.mjs\n"), "CHECKOUT_SOURCE_DIRTY");
  const deployment = { id: "dpl_preview", projectId: PREVIEW_PROJECT, ownerId: PREVIEW_TEAM, url: new URL(env.PREVIEW_PERF_URL).hostname, target: null, readyState: "READY",
    meta: { verifiedCommitSha: env.GITHUB_SHA, verifiedGitBranch: "dashboard-redesign" }, alias: [] as string[] };
  const project = { id: PREVIEW_PROJECT, accountId: PREVIEW_TEAM, targets: { production: { id: "dpl_production", url: "fanfunnel-production-easy-simple-sites.vercel.app" } } };
  check("verified metadata returns matching public provenance", checkDeploymentMetadata(config, deployment, project).sourceSha === env.GITHUB_SHA);
  refuse(() => checkDeploymentMetadata(config, { ...deployment, target: "production" }, project), "PRODUCTION_DEPLOYMENT_REFUSED");
  refuse(() => checkDeploymentMetadata(config, { ...deployment, target: undefined }, project), "PRODUCTION_DEPLOYMENT_REFUSED");
  refuse(() => checkDeploymentMetadata(config, { ...deployment, id: project.targets.production.id }, project), "PRODUCTION_DEPLOYMENT_REFUSED");
  refuse(() => checkDeploymentMetadata(config, { ...deployment, isProduction: true }, project), "PRODUCTION_DEPLOYMENT_REFUSED");
  refuse(() => checkDeploymentMetadata(config, { ...deployment, alias: ["fanfunnel.vercel.app"] }, project), "PRODUCTION_DEPLOYMENT_REFUSED");
  refuse(() => checkDeploymentMetadata(config, { ...deployment, projectId: "prj_other" }, project), "WRONG_VERCEL_PROJECT");
  refuse(() => checkDeploymentMetadata(config, deployment, { ...project, id: "prj_other" }), "WRONG_VERCEL_PROJECT");
  refuse(() => checkDeploymentMetadata(config, { ...deployment, ownerId: "team_other" }, project), "WRONG_VERCEL_TEAM");
  refuse(() => checkDeploymentMetadata(config, { ...deployment, teamId: "team_other" }, project), "WRONG_VERCEL_TEAM");
  refuse(() => checkDeploymentMetadata(config, deployment, { ...project, accountId: "team_other" }), "WRONG_VERCEL_TEAM");
  refuse(() => checkDeploymentMetadata(config, deployment, { ...project, targets: {} }), "PRODUCTION_REFERENCE_MISSING");
  refuse(() => checkDeploymentMetadata(config, { ...deployment, readyState: "BUILDING" }, project), "PREVIEW_NOT_READY");
  refuse(() => checkDeploymentMetadata(config, { ...deployment, url: "fanfunnel-z9y8x7w6v-easy-simple-sites.vercel.app" }, project), "DEPLOYMENT_URL_MISMATCH");
  refuse(() => checkDeploymentMetadata(config, { ...deployment, meta: { ...deployment.meta, verifiedCommitSha: "b".repeat(40) } }, project), "DEPLOYMENT_SHA_MISMATCH");
  refuse(() => checkDeploymentMetadata(config, { ...deployment, meta: { ...deployment.meta, verifiedGitBranch: "main" } }, project), "DEPLOYMENT_SHA_MISMATCH");
  let calls = 0;
  const fetcher = async (input: string | URL | Request, options?: RequestInit) => {
    const url = new URL(String(input)); calls++;
    assert.equal(url.origin, "https://api.vercel.com");
    assert.equal(options?.method, "GET"); assert.equal(options?.redirect, "error");
    assert.equal(url.searchParams.get("teamId"), PREVIEW_TEAM);
    return new Response(JSON.stringify(url.pathname.startsWith("/v13/") ? deployment : project), { status: 200 });
  };
  check("authenticated preflight performs only the two pinned metadata reads", (await verifyPreviewDeployment(config, fetcher)).target === "preview" && calls === 2);
  await assert.rejects(() => verifyPreviewDeployment(config, async () => { throw new Error("private transport detail"); }), error => error instanceof PreviewPerfError && error.code === "VERCEL_METADATA_UNAVAILABLE"); passed++;
  check("unexpected error messages never become report content", failureCode(new Error("private transport detail")) === "MEASUREMENT_FAILED");
  // SUP-5: the measurement step runs without VERCEL_TOKEN and accepts only the
  // preflight record bound to this Preview, source commit and workflow run.
  const { VERCEL_TOKEN: _token, ...noToken } = env;
  const measure = previewPerfEnvironment(noToken, { preflight: false });
  check("measurement step needs no Vercel token and never carries one", measure.vercel === null && measure.origin === config.origin);
  refuse(() => previewPerfEnvironment(env, { preflight: false }), "VERCEL_TOKEN_OUTSIDE_PREFLIGHT");
  refuse(() => previewPerfEnvironment({ ...noToken, VERCEL_TOKEN: "" }, { preflight: false }), "VERCEL_TOKEN_OUTSIDE_PREFLIGHT");
  for (const name of ["NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"]) refuse(() => previewPerfEnvironment({ ...noToken, [name]: "" }, { preflight: false }), "CREDENTIALS_MISSING");
  refuse(() => previewPerfEnvironment({ ...noToken, GITHUB_EVENT_NAME: "pull_request" }, { preflight: false }), "MANUAL_PREVIEW_BRANCH_REQUIRED");
  const record = preflightRecord(config, checkDeploymentMetadata(config, deployment, project));
  check("the preflight record holds no URL or credential", !JSON.stringify(record).includes("vercel.app") && !JSON.stringify(record).includes("unit-only"));
  check("a matching preflight record is accepted", checkPreflightRecord(measure, JSON.parse(JSON.stringify(record))).deploymentId === "dpl_preview");
  const otherRun = previewPerfEnvironment({ ...noToken, GITHUB_RUN_ID: "987654321" }, { preflight: false });
  const otherPreview = previewPerfEnvironment({ ...noToken, PREVIEW_PERF_URL: "https://fanfunnel-z9y8x7w6v-easy-simple-sites.vercel.app" }, { preflight: false });
  check("the binding changes with run and Preview", new Set([preflightBinding(measure), preflightBinding(otherRun), preflightBinding(otherPreview)]).size === 3);
  refuse(() => checkPreflightRecord(otherRun, record), "PREFLIGHT_NOT_VERIFIED");
  refuse(() => checkPreflightRecord(otherPreview, record), "PREFLIGHT_NOT_VERIFIED");
  for (const bad of [null, undefined, "", {}, { ...record, verified: false }, { ...record, target: "production" }, { ...record, deploymentId: "prod" },
    { ...record, binding: "0".repeat(64) }, { ...record, projectVerified: false }, { ...record, teamVerified: undefined }, { ...record, sourceShaMatched: false },
    { verified: false, errors: [{ code: "VERCEL_METADATA_UNAVAILABLE" }] }]) refuse(() => checkPreflightRecord(measure, bad), "PREFLIGHT_NOT_VERIFIED");
  const owner = "00000000-0000-4000-8000-000000000001";
  const image = "00000000-0000-4000-8000-000000000002.webp";
  const publicPhoto = `${TEST_ORIGIN}/storage/v1/object/public/creator-media/${owner}/${image}`;
  check("only own TEST public WebP asset is accepted", fixturePhotoUrl(publicPhoto, owner) === publicPhoto);
  for (const url of [publicPhoto.replace("snmcrmhgevfqggxdiomu", "ttlogfmogcccwiraaoae"), publicPhoto.replace(owner, "00000000-0000-4000-8000-000000000003"), publicPhoto + "?token=private", publicPhoto.replace("/public/", "/sign/"), publicPhoto.replace(image, "arbitrary.webp"), publicPhoto.replace(".webp", ".svg")]) refuse(() => fixturePhotoUrl(url, owner), "INVALID_FIXTURE_PHOTO");
  assert.deepEqual(summarizeLcp([5000, 1000, 4000, 2000, 3000]), { samples: 5, medianMs: 3000, p75Ms: 4000, minMs: 1000, maxMs: 5000 }); passed++;
  for (const values of [[], [1, 2, 3, 4], [1, 2, 3, 4, 5, 6], [1, 2, NaN, 4, 5], [1, 2, Infinity, 4, 5], [0, 2, 3, 4, 5], [-1, 2, 3, 4, 5]]) refuse(() => summarizeLcp(values), "INCOMPLETE_LCP_SAMPLES");
  const workflow = readFileSync(new URL("../../../.github/workflows/e2e-supabase-ui.yml", import.meta.url), "utf8");
  check("new measurement job runs only for an explicit manual URL", /preview-lcp:[\s\S]*?if: github\.event_name == 'workflow_dispatch' && inputs\.preview_url != ''/.test(workflow));
  const lcpJob = workflow.slice(workflow.indexOf("\n  preview-lcp:\n"), workflow.indexOf("\n  preview-feature-smoke:\n"));
  const lcpSteps = lcpJob.split(/\n(?= {6}- )/);
  const TOKEN = "VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}";
  const tokenSteps = lcpSteps.filter(step => step.includes(TOKEN));
  check("VERCEL_TOKEN reaches only the preflight step (SUP-5)", tokenSteps.length === 1 && tokenSteps[0].includes("run: node e2e/preview-lcp.mjs --preflight") && !lcpJob.split("\n    steps:\n")[0].includes("VERCEL_TOKEN:"));
  check("the preflight runs before any dependency is installed", lcpJob.indexOf("e2e/preview-lcp.mjs --preflight") < lcpJob.indexOf("run: npm ci"));
  check("the measurement step runs without VERCEL_TOKEN", lcpSteps.some(step => step.includes("run: node e2e/preview-lcp.mjs\n") && !step.includes("VERCEL_TOKEN:")));
  check("existing login-ui build, real test and failure artifacts remain", workflow.includes("  login-ui:\n") && workflow.includes("run: npm run build") && workflow.includes("npm run e2e:login") && workflow.includes("name: login-ui-artifacts"));
  console.log(`previewLcpGuards.test: ${passed} checks passed`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
