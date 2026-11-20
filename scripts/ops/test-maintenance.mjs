// Manual TEST-only setup/status entry point. No automatic invocation on import.
// Raw API payloads, SQL, parameters and exceptions are never written or logged.
import {spawnSync} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {maintenanceEnvironment,verifyCheckout,verifyMaintenancePreview,TEST_REF,STABLE_ORIGIN,MAINTENANCE_PATH,MaintenanceError,refuse,failureCode,HTTP_TIMEOUT_MS,JOB_NAME,SCHEDULE} from './test-maintenance-guards.mjs';
import {PLATFORM_INSPECTION_SQL,platformEnableSQL,CONTRACT_SQL,CONFIGURATION_SQL,configurationSQL,SETUP_SQL,STATUS_SQL} from './test-maintenance-sql.mjs';
export async function managementProject(config,fetcher=fetch){
 try{const response=await fetcher(`https://api.supabase.com/v1/projects/${TEST_REF}`,{method:'GET',headers:{Authorization:`Bearer ${config.management}`},redirect:'error',cache:'no-store',signal:AbortSignal.timeout(15_000)});if(!response.ok)refuse('TEST_PROJECT_METADATA_UNAVAILABLE');const value=await response.json();if(value.ref!==TEST_REF||value.id!=null&&value.id!==TEST_REF||value.status!=='ACTIVE_HEALTHY')refuse('TEST_PROJECT_METADATA_MISMATCH');return{testRef:TEST_REF,healthy:true};}catch(error){if(error instanceof MaintenanceError)throw error;refuse('TEST_PROJECT_METADATA_UNAVAILABLE');}
}
export async function managementQuery(config,query,parameters=[],readOnly=true,fetcher=fetch){
 try{const response=await fetcher(`https://api.supabase.com/v1/projects/${TEST_REF}/database/query`,{method:'POST',headers:{Authorization:`Bearer ${config.management}`,'Content-Type':'application/json'},body:JSON.stringify({query,parameters,read_only:readOnly}),redirect:'error',cache:'no-store',signal:AbortSignal.timeout(20_000)});if(!response.ok)refuse(readOnly?'TEST_PLATFORM_QUERY_UNAVAILABLE':'TEST_PLATFORM_CHANGE_REFUSED');const rows=await response.json();if(!Array.isArray(rows)||rows.length!==1||!rows[0]?.result||typeof rows[0].result!=='object'||Array.isArray(rows[0].result))refuse('INVALID_PLATFORM_RESULT');return rows[0].result;}catch(error){if(error instanceof MaintenanceError)throw error;refuse(readOnly?'TEST_PLATFORM_QUERY_UNAVAILABLE':'TEST_PLATFORM_CHANGE_REFUSED');}
}
export function checkPlatform(value){
 if(!value||value.database!=='postgres'||value.actor!=='postgres'||value.applicationReady!==true)refuse('VERIFIED_0063_TEST_DATABASE_REQUIRED');
 if(value.extensionsSchemaReady!==true)refuse('PLATFORM_EXTENSIONS_SCHEMA_REQUIRED');
 if(!Array.isArray(value.extensions)||value.extensions.length!==3||!['pg_cron','pg_net','supabase_vault'].every(name=>value.extensions.some(row=>row?.name===name&&typeof row.availableVersion==='string')))refuse('PLATFORM_DEPENDENCIES_UNAVAILABLE');
 if(value.cronSettingsCompatible!==true)refuse('INCOMPATIBLE_EXISTING_PLATFORM_CONTRACT');
 if(value.unsafeCronJobWriters!==false)refuse('EXISTING_CRON_JOB_WRITES_REQUIRE_REVIEW');
 if(value.vaultMetadataOnly!==true||value.existingCronContract!==true)refuse('INCOMPATIBLE_EXISTING_PLATFORM_CONTRACT');
 if(!Array.isArray(value.unexpectedSchemas)||value.unexpectedSchemas.length)refuse('SHARED_PLATFORM_SCHEMA_CONFLICT');
 if(!Array.isArray(value.unsafeExtensions)||value.unsafeExtensions.length)refuse('EXISTING_EXTENSION_API_GRANTS_REQUIRE_REVIEW');
 return value.extensions.filter(row=>typeof row.installedVersion==='string').map(row=>row.name);
}
export function checkContract(value){if(!value||value.cronContract!==true||value.vaultMetadataOnly!==true||!['GMT','UTC','Etc/UTC'].includes(value.timezone)||value.cronDatabase!=='postgres'||value.runLogging!==true||value.postgresAccess!==true)refuse('INCOMPATIBLE_PLATFORM_CONTRACT');}
export function checkConfiguration(value,requirePresent=false){
 if(!value||![0,1].includes(value.jobCount)||![0,1].includes(value.secretCount))refuse('MAINTENANCE_NAMESPACE_CONFLICT');
 if(value.jobCount===1&&value.jobMatches!==true)refuse('EXISTING_JOB_MISMATCH');
 if(value.secretCount===1&&(value.secretOwned!==true||value.secretMatches!==true))refuse('EXISTING_VAULT_SECRET_MISMATCH');
 if(value.jobCount===1&&value.secretCount!==1)refuse('SCHEDULED_JOB_SECRET_MISSING');
 if(requirePresent&&(value.jobCount!==1||value.secretCount!==1))refuse('TEST_MAINTENANCE_NOT_CONFIGURED');
 return{jobPresent:value.jobCount===1,secretPresent:value.secretCount===1,ownedSecretMatches:value.secretCount===1&&value.secretMatches===true};
}
export async function proveAppCredential(config,preview,fetcher=fetch,now=()=>Date.now()){
 const started=now();let response,value;
 try{response=await fetcher(preview.origin+MAINTENANCE_PATH,{method:'GET',headers:{Authorization:`Bearer ${config.secret}`},redirect:'error',cache:'no-store',signal:AbortSignal.timeout(HTTP_TIMEOUT_MS+5000)});if(response.status!==200)refuse('AUTHENTICATED_PREVIEW_MAINTENANCE_NOT_COMPLETE');value=await response.json();}catch(error){if(error instanceof MaintenanceError)throw error;refuse('AUTHENTICATED_PREVIEW_MAINTENANCE_UNAVAILABLE');}
 const health=value?.health,last=health?.summary?.lastMaintenanceAt,time=Date.parse(last??'');
 if(value.ok!==true||health?.ok!==true||health.demo!==false||health.canary?.status!=='healthy'||health.invariants?.status!=='healthy'||!Number.isFinite(time)||time<started-10_000||time>now()+10_000)refuse('AUTHENTICATED_PREVIEW_MAINTENANCE_NOT_COMPLETE');
 return{httpStatus:200,applicationCompleted:true,lastMaintenanceAt:new Date(time).toISOString(),credentialAccepted:true,target:'immutable_verified_preview'};
}
const timestamp=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))?new Date(Date.parse(value)).toISOString():null;
export function summarizeStatus(raw,preview,now=Date.now()){
 if(!raw||!Array.isArray(raw.requests)||raw.requests.length>8)refuse('INVALID_MAINTENANCE_STATUS');
 const requests=raw.requests.map(row=>{
  if(!row||!/^\d{1,19}$/.test(row.requestId??'')||!/^\d{1,19}$/.test(row.runId??'')||!timestamp(row.queuedAt))refuse('INVALID_MAINTENANCE_STATUS');
  const queued=Date.parse(row.queuedAt),started=Date.parse(row.cronStartedAt??''),ended=Date.parse(row.cronEndedAt??''),http=Date.parse(row.httpCompletedAt??''),app=Date.parse(row.applicationCompletedAt??'');
  const enqueueVerified=row.cronStatus==='succeeded'&&Number.isFinite(started)&&Number.isFinite(ended)&&started<=queued+10_000&&queued<=ended;
  const httpComplete=row.responsePresent===true&&Number.isInteger(row.httpStatus)&&row.httpStatus>=100&&row.httpStatus<=599&&row.timedOut!==true&&row.transportError!==true&&Number.isFinite(http)&&http>=queued&&http<=now+10_000;
  const applicationComplete=httpComplete&&row.httpStatus===200&&row.applicationOk===true&&Number.isFinite(app)&&app>=queued-10_000&&app<=http+10_000;
  const currentPreview=queued>=Math.max(preview.deploymentCreatedAt,preview.aliasAssignedAt);
  return{requestId:row.requestId,runId:row.runId,queuedAt:timestamp(row.queuedAt),cronStatus:['running','succeeded','failed'].includes(row.cronStatus)?row.cronStatus:'unavailable',enqueueVerified,httpCompletionVerified:httpComplete,httpStatus:Number.isInteger(row.httpStatus)?row.httpStatus:null,applicationCompletionVerified:applicationComplete,applicationCompletedAt:timestamp(row.applicationCompletedAt),httpCompletedAt:timestamp(row.httpCompletedAt),evidenceExpired:row.responsePresent!==true&&now-queued>6*60*60*1000,currentPreview};
 }).sort((a,b)=>Date.parse(b.queuedAt)-Date.parse(a.queuedAt));
 const health=raw.health,counts=health?.invariantCounts;
 const healthSafe=health&&['healthy','missing','configuration_missing','configuration_invalid','mismatch','unavailable','not_run'].includes(health.canaryStatus)&&['healthy','violations','incomplete','unavailable','not_run'].includes(health.invariantsStatus)&&counts&&typeof counts==='object'&&!Array.isArray(counts)&&Object.keys(counts).every(key=>['codeStockMismatch','heldReservationMismatch','liveChaseMissingReservation','heldCodeMismatch','orphanReservedCode','unwitnessedStockReservation','fanCreditMismatch'].includes(key)&&Number.isSafeInteger(counts[key])&&counts[key]>=0);
 const safeHealth=healthSafe?{canaryStatus:health.canaryStatus,canaryFailureAt:timestamp(health.canaryFailureAt),invariantsStatus:health.invariantsStatus,invariantCounts:counts,lastMaintenanceAt:timestamp(health.lastMaintenanceAt),invariantsCheckedAt:timestamp(health.invariantsCheckedAt)}:null;
 const latest=requests[0],currentHealthHealthy=safeHealth?.canaryStatus==='healthy'&&safeHealth.canaryFailureAt===null&&safeHealth.invariantsStatus==='healthy'&&safeHealth.lastMaintenanceAt!==null&&safeHealth.invariantsCheckedAt!==null&&Object.keys(safeHealth.invariantCounts).length===7&&Object.values(safeHealth.invariantCounts).every(value=>value===0);
 const scheduledExecutionVerified=Boolean(latest?.enqueueVerified&&latest.httpCompletionVerified&&latest.applicationCompletionVerified&&latest.currentPreview);
 return{requests,health:safeHealth,currentHealthHealthy:Boolean(currentHealthHealthy),scheduledExecutionVerified};
}
export async function runMaintenance({env,actualSha,trackedStatus,fetcher=fetch,now=()=>Date.now()}){
 const config=maintenanceEnvironment(env);verifyCheckout(config,actualSha,trackedStatus);
 const preview=await verifyMaintenancePreview(config,fetcher);await managementProject(config,fetcher);
 let platform=await managementQuery(config,PLATFORM_INSPECTION_SQL,[],true,fetcher),installed=checkPlatform(platform);
 if(config.action==='status'&&installed.length!==3)refuse('TEST_MAINTENANCE_NOT_CONFIGURED');
 let before=checkConfiguration(await managementQuery(config,configurationSQL(installed),[config.secret],true,fetcher),config.action==='status');
 if(installed.length===3)checkContract(await managementQuery(config,CONTRACT_SQL,[],true,fetcher));
 let manualProbe=null,changed=false;
 if(config.action==='setup'){
  manualProbe=await proveAppCredential(config,preview,fetcher,now);
  // Recheck alias/source/environment immediately before platform mutation.
  const fresh=await verifyMaintenancePreview(config,fetcher);if(fresh.deploymentId!==preview.deploymentId)refuse('STABLE_ALIAS_CHANGED');
  if(installed.length!==3){
   // Extension installation is one transaction. Harden only extensions this
   // operation creates; existing shared policies are never silently changed.
   const query=platformEnableSQL(installed);
   // DO has no result row. Wrap execution in a dedicated bounded transport.
   await managementStatement(config,query,fetcher);changed=true;
   platform=await managementQuery(config,PLATFORM_INSPECTION_SQL,[],true,fetcher);installed=checkPlatform(platform);if(installed.length!==3)refuse('PLATFORM_DEPENDENCIES_UNAVAILABLE');
   checkContract(await managementQuery(config,CONTRACT_SQL,[],true,fetcher));
   before=checkConfiguration(await managementQuery(config,CONFIGURATION_SQL,[config.secret],true,fetcher));
  }
  if(!before?.jobPresent){await managementQuery(config,SETUP_SQL,[config.secret],false,fetcher);changed=true;}
 }
 const configuration=checkConfiguration(await managementQuery(config,CONFIGURATION_SQL,[config.secret],true,fetcher),true);
 const status=summarizeStatus(await managementQuery(config,STATUS_SQL,[],true,fetcher),preview,now());
 const ok=config.action==='setup'||status.scheduledExecutionVerified&&status.currentHealthHealthy;
 return{version:1,action:config.action,ok,phase:config.action==='setup'?'configuration_only':'scheduled_execution_check',testRef:TEST_REF,sourceSha:config.expectedSha,workflowRun:config.runId,preview,stableOrigin:STABLE_ORIGIN,jobName:JOB_NAME,scheduleUtc:SCHEDULE,changed,configuration,manualProbe,...status};
}
async function managementStatement(config,query,fetcher){
 try{const response=await fetcher(`https://api.supabase.com/v1/projects/${TEST_REF}/database/query`,{method:'POST',headers:{Authorization:`Bearer ${config.management}`,'Content-Type':'application/json'},body:JSON.stringify({query,parameters:[],read_only:false}),redirect:'error',cache:'no-store',signal:AbortSignal.timeout(20_000)});if(!response.ok)refuse('TEST_PLATFORM_CHANGE_REFUSED');await response.arrayBuffer();}catch(error){if(error instanceof MaintenanceError)throw error;refuse('TEST_PLATFORM_CHANGE_REFUSED');}
}
function git(args){const result=spawnSync('git',args,{encoding:'utf8'});if(result.status!==0)refuse('CHECKOUT_IDENTITY_UNAVAILABLE');return result.stdout;}
async function main(){
 let report,exit=1;
 try{if(process.argv.length!==2)refuse('UNEXPECTED_ARGUMENT');report=await runMaintenance({env:process.env,actualSha:git(['rev-parse','HEAD']),trackedStatus:git(['status','--porcelain','--untracked-files=no'])});exit=report.ok?0:1;}catch(error){report={version:1,ok:false,code:failureCode(error)};}
 const path='artifacts/test-maintenance-status.json';mkdirSync(dirname(path),{recursive:true});writeFileSync(path,JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify(report));process.exitCode=exit;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
