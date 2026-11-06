// TEST-only operations adapter. No site/database request is allowed before
// manual source identity and authenticated deployment provenance are verified.
import { PREVIEW_PROJECT, PREVIEW_TEAM, TEST_REF, checkCheckoutIdentity, immutablePreviewOrigin, verifyPreviewDeployment, PreviewPerfError } from '../../e2e/preview-lcp-guards.mjs';
export { PREVIEW_PROJECT, PREVIEW_TEAM, TEST_REF };
export const STABLE_HOST='fanfunnel-git-dashboard-redesign-easy-simple-sites.vercel.app';
export const STABLE_ORIGIN=`https://${STABLE_HOST}`;
export const MAINTENANCE_PATH='/api/cron/retention';
export const JOB_NAME='fanfunnel.test.maintenance.v1';
export const VAULT_NAME='fanfunnel.test.maintenance.cron-secret.v1';
export const OWNER='fanfunnel/test-maintenance';
export const SCHEDULE='17 4 * * *';
export const HTTP_TIMEOUT_MS=60_000;
export const REQUEST_HISTORY_LIMIT=8;
export class MaintenanceError extends Error {constructor(code){super(code);this.name='MaintenanceError';this.code=code;}}
export const refuse=code=>{throw new MaintenanceError(code);};
export const failureCode=error=>error instanceof MaintenanceError||error instanceof PreviewPerfError?error.code:'TEST_MAINTENANCE_FAILED';
const credential=value=>typeof value==='string'&&value.length>=20&&value.length<=1024&&!/\s/.test(value);
export function maintenanceEnvironment(env){
 if(env.GITHUB_EVENT_NAME!=='workflow_dispatch'||env.GITHUB_REF!=='refs/heads/dashboard-redesign'||env.GITHUB_REPOSITORY?.toLowerCase()!=='guhlores-team/fanfunnel')refuse('MANUAL_PREVIEW_BRANCH_REQUIRED');
 const expectedSha=env.MAINTENANCE_EXPECTED_SHA;
 if(!/^[a-f0-9]{40}$/.test(expectedSha??'')||expectedSha!==env.GITHUB_SHA)refuse('SOURCE_SHA_MISMATCH');
 if(!['setup','status'].includes(env.TEST_MAINTENANCE_ACTION))refuse('INVALID_MAINTENANCE_ACTION');
 if(env.SUPABASE_TEST_PROJECT_REF!==TEST_REF)refuse('TEST_PROJECT_REQUIRED');
 if(env.TEST_MAINTENANCE_ORIGIN!==STABLE_ORIGIN)refuse('STABLE_TEST_ORIGIN_REQUIRED');
 if(!credential(env.SUPABASE_ACCESS_TOKEN)||!credential(env.VERCEL_TOKEN))refuse('OPERATOR_CREDENTIALS_MISSING');
 const secret=env.FANFUNNEL_TEST_CRON_SECRET;
 if(typeof secret!=='string'||!/^[A-Za-z0-9_-]{32,256}$/.test(secret))refuse('TEST_CRON_SECRET_REQUIRED');
 if(!/^[0-9]+$/.test(env.GITHUB_RUN_ID??''))refuse('WORKFLOW_RUN_REQUIRED');
 return{action:env.TEST_MAINTENANCE_ACTION,expectedSha,runId:env.GITHUB_RUN_ID,management:env.SUPABASE_ACCESS_TOKEN,vercel:env.VERCEL_TOKEN,secret};
}
export function verifyCheckout(config,actualSha,trackedStatus){checkCheckoutIdentity(config.expectedSha,actualSha,trackedStatus);}
export async function vercelJson(path,token,fetcher=fetch){
 try{const response=await fetcher(`https://api.vercel.com${path}${path.includes('?')?'&':'?'}teamId=${PREVIEW_TEAM}`,{method:'GET',headers:{Authorization:`Bearer ${token}`},redirect:'error',cache:'no-store',signal:AbortSignal.timeout(15_000)});if(!response.ok)refuse('VERCEL_METADATA_UNAVAILABLE');return await response.json();}catch(error){if(error instanceof MaintenanceError)throw error;refuse('VERCEL_METADATA_UNAVAILABLE');}
}
export function checkStableAlias(raw){
 if(!raw||typeof raw!=='object'||raw.alias!==STABLE_HOST||raw.redirect!=null||raw.deletedAt!=null||raw.projectId!==PREVIEW_PROJECT||raw.teamId!=null&&raw.teamId!==PREVIEW_TEAM||raw.ownerId!=null&&raw.ownerId!==PREVIEW_TEAM)refuse('STABLE_ALIAS_METADATA_MISMATCH');
 if(raw.deploymentId!=null&&raw.deploymentId!==raw.deployment?.id)refuse('STABLE_ALIAS_METADATA_MISMATCH');
 if(!raw.deployment||typeof raw.deployment.id!=='string'||!raw.deployment.id.startsWith('dpl_'))refuse('STABLE_ALIAS_DEPLOYMENT_MISSING');
 if(!Number.isSafeInteger(raw.updatedAt))refuse('STABLE_ALIAS_ASSIGNMENT_TIME_MISSING');
 return{assignedAt:raw.updatedAt,deploymentId:raw.deployment.id,origin:immutablePreviewOrigin(`https://${raw.deployment.url}`)};
}
export function checkSensitiveCronEnvironment(raw,deploymentCreatedAt){
 if(raw?.pagination?.next!=null)refuse('CRON_ENVIRONMENT_METADATA_INCOMPLETE');
 const all=raw?.envs;
 if(!Array.isArray(all)||!Number.isSafeInteger(deploymentCreatedAt))refuse('CRON_ENVIRONMENT_METADATA_UNAVAILABLE');
 const candidates=all.filter(row=>row?.key==='CRON_SECRET'&&Array.isArray(row.target)&&row.target.includes('preview')&&(row.gitBranch==null||row.gitBranch==='dashboard-redesign'));
 const specific=candidates.filter(row=>row.gitBranch==='dashboard-redesign'),effective=specific.length?specific:candidates.filter(row=>row.gitBranch==null);
 if(effective.length!==1||effective[0].type!=='sensitive'||effective[0].target.length!==1||effective[0].target[0]!=='preview')refuse('SENSITIVE_PREVIEW_CRON_ENVIRONMENT_REQUIRED');
 const changed=effective[0].updatedAt??effective[0].createdAt;
 if(!Number.isSafeInteger(changed)||changed>deploymentCreatedAt)refuse('PREVIEW_REDEPLOY_AFTER_CRON_ENVIRONMENT_CHANGE_REQUIRED');
 // Values are deliberately ignored. A successful authenticated app request is
 // required separately; sensitive environment metadata cannot reveal equality.
 return{key:'CRON_SECRET',sensitivePreviewOnly:true,branchScoped:effective[0].gitBranch==='dashboard-redesign',appliedBeforeDeployment:true};
}
export async function verifyMaintenancePreview(config,fetcher=fetch){
 const alias=checkStableAlias(await vercelJson(`/v4/aliases/${STABLE_HOST}`,config.vercel,fetcher));
 let deployment;
 const capture=async(url,options)=>{const response=await fetcher(url,options);return{ok:response.ok,json:async()=>{const value=await response.json();if(new URL(url).pathname.startsWith('/v13/deployments/'))deployment=value;return value;}};};
 const preview=await verifyPreviewDeployment({origin:alias.origin,host:new URL(alias.origin).hostname,expectedSha:config.expectedSha,vercel:config.vercel},capture);
 if(preview.deploymentId!==alias.deploymentId)refuse('STABLE_ALIAS_METADATA_MISMATCH');
 const sensitive=checkSensitiveCronEnvironment(await vercelJson(`/v10/projects/${PREVIEW_PROJECT}/env?decrypt=false`,config.vercel,fetcher),deployment?.createdAt);
 const again=checkStableAlias(await vercelJson(`/v4/aliases/${STABLE_HOST}`,config.vercel,fetcher));
 if(again.deploymentId!==alias.deploymentId||again.origin!==alias.origin||again.assignedAt!==alias.assignedAt)refuse('STABLE_ALIAS_CHANGED');
 return{...preview,stableOrigin:STABLE_ORIGIN,deploymentCreatedAt:deployment.createdAt,aliasAssignedAt:alias.assignedAt,cronEnvironment:sensitive};
}
