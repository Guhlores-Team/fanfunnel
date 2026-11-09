import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { TEST_ORIGIN, PreviewPerfError, browserEnvironment, checkDeploymentMetadata, verifyPreviewDeployment } from "../../../e2e/preview-lcp-guards.mjs";
import {
  SHARED_GUARD_SHA256, MAX_BINGO_PLAYS, previewFeatureEnvironment, featureBrowserUrlAllowed, ownFixtureUser,
  safeApiUrl, checkPrimaryReceipt, checkReplay, checkCleanupBeforeAuth,
  INSTANT_HEALTH_MAX_AGE_MS, checkInstantHealth, checkNoPrivateReward, checkPublicRewardDocument, checkInstantStock, checkInstantWin, checkInstantEconomy,
} from "../../../e2e/preview-feature-guards.mjs";

async function main() {
  let passed = 0;
  const check = (label: string, condition: unknown) => { assert.ok(condition, label); passed++; };
  const refused = (fn: () => unknown, code: string) => { assert.throws(fn, error => error instanceof PreviewPerfError && error.code === code); passed++; };
  const origin = "https://fanfunnel-a1b2c3d4e-easy-simple-sites.vercel.app";
  const env = { GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/heads/dashboard-redesign", GITHUB_REPOSITORY: "guhlores-team/fanfunnel",
    GITHUB_SHA: "a".repeat(40), PREVIEW_EXPECTED_SHA: "a".repeat(40), GITHUB_RUN_ID: "1234", PREVIEW_FEATURE_URL: origin,
    NEXT_PUBLIC_SUPABASE_URL: TEST_ORIGIN, NEXT_PUBLIC_SUPABASE_ANON_KEY: "unit-anon", SUPABASE_SERVICE_ROLE_KEY: "unit-service", VERCEL_TOKEN: "unit-vercel" };
  const config = previewFeatureEnvironment(env);
  check("feature smoke uses the fixed TEST target and explicit feature origin", config.origin === origin && config.databaseOrigin === TEST_ORIGIN);
  for (const changes of [{ GITHUB_EVENT_NAME: "push" }, { GITHUB_EVENT_NAME: "pull_request" }, { GITHUB_REF: "refs/heads/main" }, { GITHUB_REPOSITORY: "other/fanfunnel" }]) refused(() => previewFeatureEnvironment({ ...env, ...changes }), "MANUAL_PREVIEW_BRANCH_REQUIRED");
  for (const changes of [{ GITHUB_SHA: "b".repeat(40) }, { PREVIEW_EXPECTED_SHA: "abc" }, { PREVIEW_EXPECTED_SHA: "A".repeat(40) }]) refused(() => previewFeatureEnvironment({ ...env, ...changes }), "SOURCE_SHA_MISMATCH");
  refused(() => previewFeatureEnvironment({ ...env, PREVIEW_FEATURE_URL: "", PREVIEW_PERF_URL: origin }), "FEATURE_PREVIEW_REQUIRED");
  for (const value of ["https://fanfunnel.vercel.app", "https://fanfunnel-git-dashboard-redesign-easy-simple-sites.vercel.app", origin + "/login", origin + "?token=private", "http://" + new URL(origin).host]) refused(() => previewFeatureEnvironment({ ...env, PREVIEW_FEATURE_URL: value }), "INVALID_PREVIEW_ORIGIN");
  refused(() => previewFeatureEnvironment({ ...env, NEXT_PUBLIC_SUPABASE_URL: "https://ttlogfmogcccwiraaoae.supabase.co" }), "TEST_PROJECT_REQUIRED");
  for (const name of ["SUPABASE_SERVICE_ROLE_KEY", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "VERCEL_TOKEN"]) refused(() => previewFeatureEnvironment({ ...env, [name]: "" }), "CREDENTIALS_MISSING");
  const deployment = { id: "dpl_preview", projectId: "prj_SYsq2wTEYY2EJuenGcfIRN3D2qPU", ownerId: "team_nGs11yLViBWNrMoWyy12Xu5W", url: new URL(origin).host,
    target: "preview", readyState: "READY", meta: { verifiedCommitSha: env.GITHUB_SHA, verifiedGitBranch: "dashboard-redesign" } };
  const project = { id: deployment.projectId, accountId: deployment.ownerId, targets: { production: { id: "dpl_production", url: "fanfunnel-production-easy-simple-sites.vercel.app" } } };
  let reads = 0;
  await verifyPreviewDeployment(config, async (input: string | URL | Request, options?: RequestInit) => {
    const url = new URL(String(input)); reads++;
    assert.equal(url.origin, "https://api.vercel.com"); assert.equal(options?.method, "GET"); assert.equal(options?.redirect, "error");
    return new Response(JSON.stringify(url.pathname.startsWith("/v13/") ? deployment : project), { status: 200 });
  });
  check("shared preflight remains two metadata reads with no fixture operation", reads === 2);
  refused(() => checkDeploymentMetadata(config, { ...deployment, target: "production" }, project), "PRODUCTION_DEPLOYMENT_REFUSED");
  refused(() => checkDeploymentMetadata(config, { ...deployment, ownerId: "team_other" }, project), "WRONG_VERCEL_TEAM");
  refused(() => checkDeploymentMetadata(config, { ...deployment, projectId: "prj_other" }, project), "WRONG_VERCEL_PROJECT");
  refused(() => checkDeploymentMetadata(config, { ...deployment, meta: { ...deployment.meta, verifiedCommitSha: "b".repeat(40) } }, project), "DEPLOYMENT_SHA_MISMATCH");
  const filtered = browserEnvironment({ PATH: "/bin", HTTPS_PROXY: "http://proxy:8080", NODE_EXTRA_CA_CERTS: "/ca.pem", SUPABASE_SERVICE_ROLE_KEY: "secret-fixture", VERCEL_TOKEN: "secret-fixture", GITHUB_TOKEN: "secret-fixture", PASSWORD: "secret-fixture" });
  check("browser OS environment drops application/CI credentials", !JSON.stringify(filtered).includes("secret-fixture"));
  check("proxy and CA trust survive filtering", filtered.HTTPS_PROXY === "http://proxy:8080" && filtered.NODE_EXTRA_CA_CERTS === "/ca.pem");
  check("actual Preview and TEST browser traffic is allowed", featureBrowserUrlAllowed(origin + "/login", origin) && featureBrowserUrlAllowed(TEST_ORIGIN + "/auth/v1/token", origin));
  for (const value of ["https://fanfunnel.vercel.app/api/spin", "https://ttlogfmogcccwiraaoae.supabase.co/auth/v1/token", "https://evil.example.test", "https://user@" + new URL(origin).host, "http://" + new URL(origin).host, "file:///tmp/site"]) check("all other browser origins fail closed", !featureBrowserUrlAllowed(value, origin));
  for (const path of ["https://evil.test/api/spin", "//evil.test/api/spin", "/api/../login", "/api/\\evil", "/login", "/api/spin#private"]) refused(() => safeApiUrl(origin, path), "INVALID_SMOKE_API_PATH");
  check("creator API requests are rooted to the verified Preview", safeApiUrl(origin, "/api/passes") === origin + "/api/passes");
  const owner = "00000000-0000-4000-8000-000000000001", other = "00000000-0000-4000-8000-000000000002", email = "unit-only@fanfunnel.test";
  check("cleanup ownership requires exact UUID and email", ownFixtureUser({ id: owner, email }, owner, email));
  check("another creator can never become the cleanup target", !ownFixtureUser({ id: other, email }, owner, email) && !ownFixtureUser({ id: owner, email: "other@fanfunnel.test" }, owner, email));
  const clean = { acknowledged: true, userAbsent: false, owned: true, media: 0, storage: 0, publicObjects: 0 };
  checkCleanupBeforeAuth(clean); passed++;
  for (const changes of [{ media: 1 }, { storage: 1 }, { publicObjects: 1 }]) refused(() => checkCleanupBeforeAuth({ ...clean, ...changes }), "CLEANUP_PENDING_STORAGE");
  for (const changes of [{ media: null }, { storage: undefined }, { publicObjects: -1 }]) refused(() => checkCleanupBeforeAuth({ ...clean, ...changes }), "CLEANUP_STORAGE_UNVERIFIED");
  refused(() => checkCleanupBeforeAuth({ ...clean, userAbsent: true, acknowledged: false }), "CLEANUP_CREATE_UNCONFIRMED");
  refused(() => checkCleanupBeforeAuth({ ...clean, owned: false }), "CLEANUP_OWNERSHIP_UNVERIFIED");
  const wheel = { shareId: "abcdef0123456789ab", attemptId: owner, prize: { id: other }, spinsRemaining: 1 };
  checkPrimaryReceipt(wheel, "wheel", 2); passed++;
  const scratch = { ...wheel, gameKind: "scratch", presentation: { kind: "scratch", cells: Array.from({ length: 9 }, () => ({})) }, bonusWins: [] };
  checkPrimaryReceipt(scratch, "scratch", 2); passed++;
  refused(() => checkPrimaryReceipt({ ...scratch, spinsRemaining: 0 }, "scratch", 2), "PRIMARY_RECEIPT_UNVERIFIED");
  refused(() => checkPrimaryReceipt({ ...scratch, presentation: { ...scratch.presentation, cells: [] } }, "scratch", 2), "SCRATCH_FACE_UNVERIFIED");
  const replay = { ...scratch, replayed: true };
  checkReplay(scratch, replay); passed++;
  for (const changes of [{ attemptId: other }, { shareId: "changed" }, { spinsRemaining: 0 }, { presentation: {} }, { bonusWins: [{}] }]) refused(() => checkReplay(scratch, { ...replay, ...changes }), "REPLAY_RECEIPT_UNVERIFIED");
  check("Bingo has a fixed spend bound", MAX_BINGO_PLAYS === 36);
  const guard = readFileSync(new URL("../../../e2e/preview-lcp-guards.mjs", import.meta.url));
  check("the shared5-path provenance guard is unchanged", createHash("sha256").update(guard).digest("hex") === SHARED_GUARD_SHA256);
  const runner = readFileSync(new URL("../../../e2e/preview-feature-smoke.mjs", import.meta.url), "utf8");
  const fixtureAt = runner.indexOf("const credentials = await createFixture(admin");
  check("no fixture is created until source and deployment provenance pass", fixtureAt > 0 && [
    "provenance = await verifyPreviewDeployment(config)", "provenance = checkPreflightRecord(config, record)", "checkCheckoutIdentity(config.expectedSha",
  ].every(anchor => { const at = runner.indexOf(anchor); return at > 0 && at < fixtureAt; }));
  check("the smoke step reads Vercel only in --preflight and otherwise needs its record (SUP-5)", runner.includes("previewFeatureEnvironment(process.env, { preflight: preflightOnly })")
    && /if \(preflightOnly\) \{\n\s+provenance = await verifyPreviewDeployment\(config\);/.test(runner));
  check("no authenticated screenshots, trace, HAR or storage-state artifact", !/\.screenshot\s*\(|\.tracing\.|recordHar\s*:|storageState\s*\(/.test(runner));
  check("create fixture confirms email without triggering email delivery", runner.includes("email_confirm: true") && !/signUp\s*\(|inviteUserByEmail|resetPasswordForEmail|signInWithOtp/.test(runner));
  check("server capabilities change only the exact owned fixture profile", runner.includes('features: { wheel: true, scratch: true, bingo: true }') && runner.includes('.eq("id", state.userId).select("id").single()'));
  check("no hosted Chase toggle or demo admin/debug fixture is used", !/chase_enabled\s*:\s*true|\/api\/debug|\/api\/admin|enableFixtureChase|acc-you/.test(runner));
  check("no seed, outcome or Bingo-card mutation is used", !/\.from\("(?:bingo_cards|spin_attempts|fan_passes)"\)\.(?:update|insert)|next_server_seed\s*:|marked_mask\s*:/.test(runner));
  check("cleanup checks bytes and metadata before deleting Auth", runner.indexOf("checkCleanupBeforeAuth({") < runner.indexOf("admin.auth.admin.deleteUser(state.userId)"));
  check("actual Focus grant, Scratch reveal and Bingo UI controls are clicked", runner.includes('getByTestId("focus-grant").click()') && runner.includes('getByTestId("scratch-reveal-all").focus()') && runner.includes('getByTestId("fan-spin").click()'));
  const workflow = readFileSync(new URL("../../../.github/workflows/e2e-supabase-ui.yml", import.meta.url), "utf8");
  check("feature smoke is a separate explicit manual opt-in", /preview-feature-smoke:[\s\S]*?if: github\.event_name == 'workflow_dispatch' && inputs\.preview_smoke_url != ''/.test(workflow));
  const smokeJob = workflow.slice(workflow.indexOf("\n  preview-feature-smoke:\n"));
  const smokeTokenSteps = smokeJob.split(/\n(?= {6}- )/).filter(step => step.includes("VERCEL_TOKEN:"));
  check("VERCEL_TOKEN reaches only the feature preflight step (SUP-5)", smokeTokenSteps.length === 1 && smokeTokenSteps[0].includes("run: node e2e/preview-feature-smoke.mjs --preflight") && !smokeJob.split("\n    steps:\n")[0].includes("VERCEL_TOKEN:"));
  check("the feature preflight runs before any dependency is installed", smokeJob.indexOf("preview-feature-smoke.mjs --preflight") < smokeJob.indexOf("run: npm ci"));
  { const { VERCEL_TOKEN: _token, ...noToken } = env;
    check("the smoke step needs no Vercel token", previewFeatureEnvironment(noToken, { preflight: false }).vercel === null);
    refused(() => previewFeatureEnvironment(env, { preflight: false }), "VERCEL_TOKEN_OUTSIDE_PREFLIGHT"); }
  check("feature-specific URL and checked SHA do not reuse performance inputs", workflow.includes("PREVIEW_FEATURE_URL: ${{ inputs.preview_smoke_url }}") && workflow.includes("PREVIEW_EXPECTED_SHA: ${{ inputs.preview_smoke_expected_sha }}"));
  check("existing login and5-sample performance jobs remain", workflow.includes("  login-ui:\n") && workflow.includes("npm run e2e:login") && workflow.includes("  preview-lcp:\n") && workflow.includes("node e2e/preview-lcp.mjs"));
  check("feature artifacts are isolated to sanitized report directory", /name: preview-feature-smoke-\$\{\{ github.sha \}\}[\s\S]*?path: e2e\/artifacts\/preview-feature-smoke\//.test(workflow));
  const now = Date.parse("2026-10-28T12:00:00Z");
  const health = { canary_status: "healthy", canary_failure_at: null, canary_checked_at: "2026-10-28T11:59:00Z" };
  checkInstantHealth(health, now); passed++;
  check("health freshness bound is explicit and limited", INSTANT_HEALTH_MAX_AGE_MS === 15 * 60_000);
  for (const status of ["missing", "mismatch", "configuration_missing", "unavailable", undefined]) refused(() => checkInstantHealth({ ...health, canary_status: status }, now), "INSTANT_CANARY_NOT_VERIFIED");
  for (const changes of [{ canary_failure_at: "2026-10-27T00:00:00Z" }, { canary_failure_at: undefined }, { canary_checked_at: null }, { canary_checked_at: "invalid" }, { canary_checked_at: "2026-10-28T12:00:01Z" }, { canary_checked_at: "2026-10-28T11:44:59Z" }]) refused(() => checkInstantHealth({ ...health, ...changes }, now), "INSTANT_CANARY_NOT_VERIFIED");
  refused(() => checkInstantHealth(null, now), "INSTANT_CANARY_NOT_VERIFIED");
  refused(() => checkInstantHealth(health, NaN), "INSTANT_CANARY_NOT_VERIFIED");
  checkInstantHealth({ ...health, canary_checked_at: "2026-10-28T11:45:00Z" }, now); passed++;
  const codes = ["UNIT-NO-VALUE-PRIVATE-CODE-0001", "UNIT-NO-VALUE-PRIVATE-CODE-0002"];
  const stock = { delivery: "codes", ready: true, value: null, codesLeft: 2, codesUsed: 0, preview: ["••••0001", "••••0002"] };
  checkInstantStock(stock, 2, 0, codes); passed++;
  checkInstantStock({ ...stock, codesLeft: 0, codesUsed: 2, preview: [] }, 0, 2, codes); passed++;
  for (const changes of [{ delivery: "manual" }, { ready: false }, { value: "unexpected" }, { codesLeft: 1 }, { codesUsed: 1 }, { preview: ["••••0001"] }, { preview: ["unmasked-0001", "••••0002"] }]) refused(() => checkInstantStock({ ...stock, ...changes }, 2, 0, codes), "INSTANT_STOCK_UNVERIFIED");
  refused(() => checkInstantStock({ ...stock, preview: [codes[0], "••••0002"] }, 2, 0, codes), "INSTANT_PRIVATE_FIELD_EXPOSED");
  for (const value of [{ cipher: "redacted-test" }, { nested: { iv: "redacted-test" } }, { nested: [{ fingerprint: "redacted-test" }] }, { reward_cipher: "redacted-test" }, { reward_iv: "redacted-test" }, { reward_fingerprint: "redacted-test" }, { text: `prefix${codes[0]}suffix` }, [codes[1]]]) refused(() => checkNoPrivateReward(value, codes), "INSTANT_PRIVATE_FIELD_EXPOSED");
  for (const pool of [[], [codes[0]], [codes[0], "short"], [...codes, "extra"]]) refused(() => checkNoPrivateReward({}, pool), "INSTANT_POOL_UNVERIFIED");
  checkNoPrivateReward({ count: 2, preview: ["••••0001"], value: null }, codes); passed++;
  checkPublicRewardDocument('<p>Public odds fingerprint and committed fairness.</p>', codes); passed++;
  for (const html of ['{"cipher":"redacted-test"}', '{"iv":"redacted-test"}', '{"fingerprint":"redacted-test"}', '{\\"reward_cipher\\":\\"redacted-test\\"}', `<p>${codes[0]}</p>`]) refused(() => checkPublicRewardDocument(html, codes), "INSTANT_PRIVATE_FIELD_EXPOSED");
  const codeWin = { ...wheel, reward: { kind: "code", value: codes[0] } };
  checkInstantWin(codeWin, other, codes); passed++;
  for (const value of [{ ...codeWin, prize: { id: owner } }, { ...codeWin, reward: { kind: "text", value: codes[0] } }, { ...codeWin, reward: { kind: "code", value: "outside-own-pool" } }, { ...codeWin, reward: null }]) refused(() => checkInstantWin(value, other, codes), "INSTANT_WIN_UNVERIFIED");
  checkReplay(codeWin, { ...codeWin, replayed: true }); passed++;
  refused(() => checkReplay(codeWin, { ...codeWin, replayed: true, reward: { kind: "code", value: codes[1] } }), "REPLAY_RECEIPT_UNVERIFIED");
  check("real canary observation precedes all fixture creation", runner.indexOf('stage = "instant-health"') < runner.indexOf('const credentials = await createFixture(admin'));
  check("canary observation uses only non-secret health fields", runner.includes('.select("canary_status,canary_checked_at,canary_failure_at")') && !/\.from\("reward_crypto_canary"\)|initialize_reward_crypto_canary|record_system_health_check/.test(runner));
  check("the fixed TEST guard runs before service-client construction", runner.indexOf("config = previewFeatureEnvironment(process.env)") < runner.indexOf("admin = createClient(config.databaseOrigin, config.service"));
  check("real instant reveal is checked before actual acknowledgement", runner.indexOf("if (beforeAcknowledge) await beforeAcknowledge(result)") < runner.indexOf('getByRole("button", { name: "Awesome!" }).click()'));
  check("actual import and duplicate-paste counts are verified", runner.includes('imported.added === 2 && imported.duplicates === 1') && runner.includes('duplicate.added === 0 && duplicate.duplicates === 2'));
  check("actual server config is read before fixture pass creation", runner.indexOf("// Read back authoritative server weights/delivery") < runner.indexOf('name, spins: 2,'));
  check("history reopen uses actual controls and removes decrypted value on close", runner.includes('getByTestId("reward-history-toggle").click()') && runner.includes('getByTestId("reward-history-view").click()') && runner.includes('getByTestId("reward-value").count() === 0'));
  check("instant result reports contain counts and booleans only", /report\.instant = \{[\s\S]*?\n  await context\.close\(\);/.test(runner) && !/report\.instant = \{[\s\S]*?(?:value:|token:|shareId:|codes:|email:)[\s\S]*?\n  await context\.close\(\);/.test(runner));
  const economy = { fanId: owner, spinsRemaining: 0, grantedTotal: 2, totalSpins: 2, links: [{ token: "unit-link" }], grants: [{ spins: 2, editPass: { spinsRemaining: 0 } }] };
  checkInstantEconomy(economy, owner, 0, 2); passed++;
  for (const changes of [{ fanId: other }, { spinsRemaining: 1 }, { grantedTotal: 3 }, { totalSpins: 3 }, { links: [] }, { grants: [{ spins: 2, editPass: { spinsRemaining: -1 } }] }, { grants: [{ spins: 3, editPass: { spinsRemaining: 0 } }] }, { grants: [] }]) refused(() => checkInstantEconomy({ ...economy, ...changes }, owner, 0, 2), "INSTANT_ECONOMY_UNVERIFIED");
  check("private values are checked in local and session storage without artifacts", runner.includes("checkNoPrivateReward(await page.evaluate(() => [Object.values(localStorage), Object.values(sessionStorage)]), fixture.codes)"));
  console.log(`previewFeatureGuards.test: ${passed} checks passed`);
}
main().catch(() => { console.error("previewFeatureGuards.test failed"); process.exitCode = 1; });
