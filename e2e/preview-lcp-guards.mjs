// Dependency-free preflight. No site or fixture request is allowed until both
// the source identity and authenticated Vercel deployment metadata are checked.
// SUP-5: only the preflight step (run before `npm ci`) holds VERCEL_TOKEN. The
// measurement step runs without it and accepts the deployment only through the
// verified preflight record that step wrote in the same workflow run.
import { createHash } from "node:crypto";
export const PREVIEW_PROJECT = "prj_SYsq2wTEYY2EJuenGcfIRN3D2qPU";
export const PREVIEW_TEAM = "team_nGs11yLViBWNrMoWyy12Xu5W";
export const TEST_REF = "snmcrmhgevfqggxdiomu";
export const TEST_ORIGIN = `https://${TEST_REF}.supabase.co`;
export const SAMPLE_COUNT = 5;
const IMMUTABLE_HOST = /^fanfunnel-[a-z0-9]{9}-easy-simple-sites\.vercel\.app$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export class PreviewPerfError extends Error {
  constructor(code) { super(code); this.name = "PreviewPerfError"; this.code = code; }
}
export const refuse = code => { throw new PreviewPerfError(code); };
export const failureCode = error => error instanceof PreviewPerfError ? error.code : "MEASUREMENT_FAILED";
export function browserEnvironment(env) {
  // Chromium needs normal network/proxy/CA/runtime settings, not application,
  // database or CI credentials. Never pass those inherited secrets to its OS
  // process merely because the controller itself needs server-side credentials.
  return Object.fromEntries(Object.entries(env).filter(([name, value]) => typeof value === "string" && !/(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(name)));
}
export function checkCheckoutIdentity(expectedSha, actualSha, trackedStatus) {
  if (typeof actualSha !== "string" || actualSha.trim() !== expectedSha) refuse("CHECKOUT_SHA_MISMATCH");
  if (typeof trackedStatus !== "string" || trackedStatus.trim()) refuse("CHECKOUT_SOURCE_DIRTY");
}
export function immutablePreviewOrigin(value) {
  let url;
  try { url = new URL(value); } catch { refuse("INVALID_PREVIEW_ORIGIN"); }
  if (url.protocol !== "https:" || !IMMUTABLE_HOST.test(url.hostname) || url.port || url.username || url.password || url.pathname !== "/" || url.search || url.hash) refuse("INVALID_PREVIEW_ORIGIN");
  return url.origin;
}
export function previewPerfEnvironment(env, { preflight = true } = {}) {
  if (env.GITHUB_EVENT_NAME !== "workflow_dispatch" || env.GITHUB_REF !== "refs/heads/dashboard-redesign" || env.GITHUB_REPOSITORY?.toLowerCase() !== "guhlores-team/fanfunnel") refuse("MANUAL_PREVIEW_BRANCH_REQUIRED");
  const expectedSha = env.PREVIEW_EXPECTED_SHA;
  if (typeof expectedSha !== "string" || !/^[a-f0-9]{40}$/.test(expectedSha) || expectedSha !== env.GITHUB_SHA) refuse("SOURCE_SHA_MISMATCH");
  const origin = immutablePreviewOrigin(env.PREVIEW_PERF_URL);
  let database;
  try { database = new URL(env.NEXT_PUBLIC_SUPABASE_URL); } catch { refuse("TEST_PROJECT_REQUIRED"); }
  if (database.origin !== TEST_ORIGIN || database.pathname !== "/" || database.search || database.hash || database.username || database.password) refuse("TEST_PROJECT_REQUIRED");
  for (const name of ["NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", ...(preflight ? ["VERCEL_TOKEN"] : [])]) {
    if (typeof env[name] !== "string" || !env[name].trim()) refuse("CREDENTIALS_MISSING");
  }
  // The steps that install and run dependencies must not hold the Vercel token.
  if (!preflight && env.VERCEL_TOKEN !== undefined) refuse("VERCEL_TOKEN_OUTSIDE_PREFLIGHT");
  if (!/^[0-9]+$/.test(env.GITHUB_RUN_ID ?? "")) refuse("WORKFLOW_RUN_REQUIRED");
  return { origin, host: new URL(origin).hostname, expectedSha, runId: env.GITHUB_RUN_ID,
    databaseOrigin: TEST_ORIGIN, anon: env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    service: env.SUPABASE_SERVICE_ROLE_KEY, vercel: preflight ? env.VERCEL_TOKEN : null };
}
// Ties a preflight record to one immutable Preview, source commit and workflow
// run without writing the Preview URL into the uploaded report.
export function preflightBinding(config) {
  return createHash("sha256").update(`${config.origin}\n${config.expectedSha}\n${config.runId}`).digest("hex");
}
export function preflightRecord(config, provenance) {
  return { verified: true, deploymentId: provenance.deploymentId, target: provenance.target, sourceShaMatched: true,
    projectVerified: true, teamVerified: true, binding: preflightBinding(config) };
}
export function checkPreflightRecord(config, record) {
  if (!record || typeof record !== "object" || record.verified !== true || record.target !== "preview" || record.sourceShaMatched !== true
    || record.projectVerified !== true || record.teamVerified !== true || typeof record.deploymentId !== "string" || !record.deploymentId.startsWith("dpl_")
    || record.binding !== preflightBinding(config)) refuse("PREFLIGHT_NOT_VERIFIED");
  return { deploymentId: record.deploymentId, target: "preview", sourceSha: config.expectedSha, projectVerified: true, teamVerified: true };
}

export function checkDeploymentMetadata(config, deployment, project) {
  if (!deployment || typeof deployment !== "object" || !project || typeof project !== "object") refuse("INVALID_DEPLOYMENT_METADATA");
  if (deployment.projectId !== PREVIEW_PROJECT || project.id !== PREVIEW_PROJECT) refuse("WRONG_VERCEL_PROJECT");
  if ((deployment.ownerId == null && deployment.teamId == null) || deployment.ownerId != null && deployment.ownerId !== PREVIEW_TEAM || deployment.teamId != null && deployment.teamId !== PREVIEW_TEAM || project.accountId !== PREVIEW_TEAM) refuse("WRONG_VERCEL_TEAM");
  if (!Object.hasOwn(deployment, "target") || ![null, "preview"].includes(deployment.target)) refuse("PRODUCTION_DEPLOYMENT_REFUSED");
  const production = project.targets?.production;
  if (!production || typeof production.id !== "string" || !production.id.startsWith("dpl_")) refuse("PRODUCTION_REFERENCE_MISSING");
  if (deployment.id === production.id || deployment.url === production.url || deployment.isProduction === true) refuse("PRODUCTION_DEPLOYMENT_REFUSED");
  const aliases = [...(Array.isArray(deployment.alias) ? deployment.alias : []), ...(Array.isArray(deployment.aliases) ? deployment.aliases : [])]
    .map(alias => typeof alias === "string" ? alias : alias?.alias);
  if (aliases.includes("fanfunnel.vercel.app")) refuse("PRODUCTION_DEPLOYMENT_REFUSED");
  if (deployment.readyState !== "READY" || typeof deployment.id !== "string" || !deployment.id.startsWith("dpl_")) refuse("PREVIEW_NOT_READY");
  const origin = immutablePreviewOrigin(`https://${deployment.url}`);
  if (origin !== config.origin) refuse("DEPLOYMENT_URL_MISMATCH");
  if (deployment.meta?.verifiedCommitSha !== config.expectedSha || deployment.meta?.verifiedGitBranch !== "dashboard-redesign") refuse("DEPLOYMENT_SHA_MISMATCH");
  // Deliberately return only public provenance, never the raw metadata/token.
  return { origin, deploymentId: deployment.id, sourceSha: config.expectedSha, target: "preview", projectVerified: true, teamVerified: true };
}
export async function verifyPreviewDeployment(config, fetcher = fetch) {
  const paths = [`/v13/deployments/${encodeURIComponent(config.host)}`, `/v9/projects/${PREVIEW_PROJECT}`];
  let bodies;
  try {
    bodies = await Promise.all(paths.map(async path => {
      const response = await fetcher(`https://api.vercel.com${path}?teamId=${PREVIEW_TEAM}`, {
        method: "GET", headers: { Authorization: `Bearer ${config.vercel}` }, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) refuse("VERCEL_METADATA_UNAVAILABLE");
      return response.json();
    }));
  } catch (error) { if (error instanceof PreviewPerfError) throw error; refuse("VERCEL_METADATA_UNAVAILABLE"); }
  return checkDeploymentMetadata(config, bodies[0], bodies[1]);
}
export function fixturePhotoUrl(value, owner) {
  let url;
  try { url = new URL(value); } catch { refuse("INVALID_FIXTURE_PHOTO"); }
  const prefix = `/storage/v1/object/public/creator-media/${owner}/`;
  const filename = url.pathname.slice(prefix.length);
  if (!UUID.test(owner ?? "") || url.origin !== TEST_ORIGIN || url.username || url.password || url.search || url.hash || !url.pathname.startsWith(prefix) || !filename.endsWith(".webp") || !UUID.test(filename.slice(0, -5))) refuse("INVALID_FIXTURE_PHOTO");
  return url.href;
}
export function summarizeLcp(values) {
  if (!Array.isArray(values) || values.length !== SAMPLE_COUNT || values.some(value => typeof value !== "number" || !Number.isFinite(value) || value <= 0)) refuse("INCOMPLETE_LCP_SAMPLES");
  const sorted = [...values].sort((a, b) => a - b);
  return { samples: sorted.length, medianMs: sorted[2], p75Ms: sorted[Math.ceil(sorted.length * 0.75) - 1], minMs: sorted[0], maxMs: sorted.at(-1) };
}
