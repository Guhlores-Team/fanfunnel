import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {STABLE_ORIGIN,STABLE_HOST,TEST_REF,PREVIEW_PROJECT,PREVIEW_TEAM,checkSensitiveCronEnvironment,checkStableAlias} from './test-maintenance-guards.mjs';
import {runMaintenance,summarizeStatus} from './test-maintenance.mjs';
import {PLATFORM_INSPECTION_SQL,CONTRACT_SQL,CONFIGURATION_SQL,SETUP_SQL,STATUS_SQL,CRON_COMMAND,INITIAL_DESCRIPTION,ROLLBACK_SQL,platformEnableSQL} from './test-maintenance-sql.mjs';
let checks=0;const check=(label,value)=>{assert.ok(value,label);checks++;};
const SHA='a'.repeat(40),NOW=Date.parse('2026-10-28T05:00:00Z'),CREATED=NOW-60*60*1000,ALIAS=CREATED+1000,QUEUED=NOW-30*60*1000;
const env={GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_REF:'refs/heads/dashboard-redesign',GITHUB_REPOSITORY:'Guhlores-Team/fanfunnel',GITHUB_SHA:SHA,GITHUB_RUN_ID:'123',MAINTENANCE_EXPECTED_SHA:SHA,TEST_MAINTENANCE_ACTION:'setup',SUPABASE_TEST_PROJECT_REF:TEST_REF,TEST_MAINTENANCE_ORIGIN:STABLE_ORIGIN,SUPABASE_ACCESS_TOKEN:'m'.repeat(40),VERCEL_TOKEN:'v'.repeat(40),FANFUNNEL_TEST_CRON_SECRET:'s'.repeat(64)};
const alias={alias:STABLE_HOST,projectId:PREVIEW_PROJECT,updatedAt:ALIAS,deployment:{id:'dpl_verified',url:'fanfunnel-123456789-easy-simple-sites.vercel.app'}};
const deployment={id:alias.deployment.id,url:alias.deployment.url,projectId:PREVIEW_PROJECT,ownerId:PREVIEW_TEAM,target:null,readyState:'READY',createdAt:CREATED,meta:{verifiedCommitSha:SHA,verifiedGitBranch:'dashboard-redesign'}};
const project={id:PREVIEW_PROJECT,accountId:PREVIEW_TEAM,targets:{production:{id:'dpl_production',url:'fanfunnel-production.vercel.app'}}};
const sensitive={envs:[{key:'CRON_SECRET',type:'sensitive',target:['preview'],gitBranch:'dashboard-redesign',updatedAt:CREATED-1000,value:'THIS_VALUE_MUST_NEVER_APPEAR_IN_A_REPORT'}]};
const installed={database:'postgres',actor:'postgres',cronSettingsCompatible:true,extensionsSchemaReady:true,unsafeCronJobWriters:false,applicationReady:true,vaultMetadataOnly:true,existingCronContract:true,extensions:['pg_cron','pg_net','supabase_vault'].map(name=>({name,availableVersion:'1.0',installedVersion:'1.0'})),unexpectedSchemas:[],unsafeExtensions:[]};
const contract={cronContract:true,vaultMetadataOnly:true,timezone:'GMT',cronDatabase:'postgres',runLogging:true,postgresAccess:true};
const zero=Object.fromEntries(['codeStockMismatch','heldReservationMismatch','liveChaseMissingReservation','heldCodeMismatch','orphanReservedCode','unwitnessedStockReservation','fanCreditMismatch'].map(key=>[key,0]));
const last=new Date(QUEUED+2000).toISOString();
const health={canaryStatus:'healthy',canaryFailureAt:null,invariantsStatus:'healthy',invariantCounts:zero,lastMaintenanceAt:last,invariantsCheckedAt:last};
const request={requestId:'123',runId:'456',queuedAt:new Date(QUEUED).toISOString(),cronStatus:'succeeded',cronStartedAt:new Date(QUEUED-10).toISOString(),cronEndedAt:new Date(QUEUED+1).toISOString(),responsePresent:true,httpStatus:200,timedOut:false,transportError:false,httpCompletedAt:new Date(QUEUED+3000).toISOString(),applicationOk:true,applicationCompletedAt:last};
function fixture(options={}){
 const calls=[],mutations=[];let configured=options.configured??false,platform=structuredClone(options.platform??installed),gets=0;
 const fetcher=async(url,init={})=>{
  calls.push({url,init});const path=new URL(url).pathname;
  const response=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
  if(path.startsWith('/v4/aliases/'))return response(options.alias??alias,options.vercelStatus??200);
  if(path.startsWith('/v13/deployments/'))return response(options.deployment??deployment);
  if(path===`/v9/projects/${PREVIEW_PROJECT}`)return response(project);
  if(path===`/v10/projects/${PREVIEW_PROJECT}/env`)return response(options.sensitive??sensitive);
  if(url===`https://api.supabase.com/v1/projects/${TEST_REF}`)return response({ref:options.wrongRef??TEST_REF,id:TEST_REF,status:'ACTIVE_HEALTHY'},options.managementStatus??200);
  if(path==='/api/cron/retention'){
   gets++;const stamp=new Date(NOW).toISOString();return response({ok:true,health:{ok:true,demo:false,canary:{status:'healthy'},invariants:{status:'healthy'},summary:{lastMaintenanceAt:stamp}}},options.probeStatus??200);
  }
  if(url!==`https://api.supabase.com/v1/projects/${TEST_REF}/database/query`)throw Error('unexpected destination');
  const body=JSON.parse(init.body);
  if(body.read_only===false){mutations.push(body);if(body.query===SETUP_SQL){configured=true;return response([{result:{configured:true,createdJob:true,createdSecret:true,guard:1}}]);}platform=structuredClone(installed);return response([]);}
  if(body.query===PLATFORM_INSPECTION_SQL)return response([{result:platform}]);
  if(body.query===CONTRACT_SQL)return response([{result:contract}]);
  if(body.query===STATUS_SQL)return response([{result:options.status??{requests:[],health}}]);
  if(body.query===CONFIGURATION_SQL||body.query.startsWith('with owned as materialized'))return response([{result:options.configuration??{jobCount:configured?1:0,jobMatches:configured,secretCount:configured?1:0,secretOwned:configured,secretMatches:configured}}]);
  throw Error('unexpected safe query');
 };
 return{calls,mutations,fetcher,get probeGets(){return gets;}};
}
async function run(options={},patch={}){const f=fixture(options);try{const result=await runMaintenance({env:{...env,...patch},actualSha:SHA,trackedStatus:'',fetcher:f.fetcher,now:()=>NOW});return{...f,result};}catch(error){return{...f,error};}}
async function main(){
 const cases=[{SUPABASE_TEST_PROJECT_REF:'ttlogfmogcccwiraaoae'},{TEST_MAINTENANCE_ORIGIN:'https://fanfunnel.vercel.app'},{MAINTENANCE_EXPECTED_SHA:'b'.repeat(40)},{GITHUB_REF:'refs/heads/main'},{VERCEL_TOKEN:''},{SUPABASE_ACCESS_TOKEN:''},{FANFUNNEL_TEST_CRON_SECRET:'short'},{GITHUB_EVENT_NAME:'pull_request'}];
 for(const patch of cases){const result=await run({},patch);check('wrong ref/host/source/credential/manual boundary rejects before any request',result.error&&result.calls.length===0&&result.mutations.length===0);}
 for(const options of [{deployment:{...deployment,target:'production'}},{deployment:{...deployment,ownerId:'team_wrong'}},{deployment:{...deployment,meta:{verifiedCommitSha:'b'.repeat(40),verifiedGitBranch:'dashboard-redesign'}}},{alias:{...alias,redirect:'https://fanfunnel.vercel.app'}},{sensitive:{envs:[{...sensitive.envs[0],type:'encrypted'}]}},{sensitive:{envs:[{...sensitive.envs[0],updatedAt:CREATED+1}]}},{sensitive:{...sensitive,pagination:{next:123}}}]){const result=await run(options);check('metadata mismatch rejects before any mutation or app request',result.error&&result.mutations.length===0&&result.probeGets===0);}
 for(const option of [{vercelStatus:401},{managementStatus:401}]){const result=await run(option);check('invalid nonempty operator credentials fail before mutation or app calls',result.error&&result.mutations.length===0&&result.probeGets===0);}
 const wrong=await run({wrongRef:'ttlogfmogcccwiraaoae'});check('Management response must prove pinned TEST ref',wrong.error&&wrong.mutations.length===0);
 const unsafe=await run({platform:{...installed,unsafeExtensions:['net']}});check('existing unsafe extension requires review before any mutation',unsafe.error?.code==='EXISTING_EXTENSION_API_GRANTS_REQUIRE_REVIEW'&&unsafe.mutations.length===0&&unsafe.probeGets===0);
 const mismatch=await run({configuration:{jobCount:1,jobMatches:false,secretCount:1,secretOwned:true,secretMatches:true}});check('different existing job is never changed',mismatch.error?.code==='EXISTING_JOB_MISMATCH'&&mismatch.mutations.length===0&&mismatch.probeGets===0);
 const secretMismatch=await run({configuration:{jobCount:0,jobMatches:false,secretCount:1,secretOwned:true,secretMatches:false}});check('mismatched existing secret is never changed',secretMismatch.error?.code==='EXISTING_VAULT_SECRET_MISMATCH'&&secretMismatch.mutations.length===0);
 const noAuth=await run({probeStatus:401});check('wrong deployed bearer fails before platform mutation',noAuth.error&&noAuth.mutations.length===0);
 const setup=await run();check('setup creates only its fixed job after healthy authenticated preview proof',setup.result?.ok&&setup.mutations.length===1&&setup.mutations[0].query===SETUP_SQL&&setup.result.manualProbe.credentialAccepted);
 check('secret is a bind parameter, never SQL literal or cron command',setup.mutations[0].parameters[0]===env.FANFUNNEL_TEST_CRON_SECRET&&!SETUP_SQL.includes(env.FANFUNNEL_TEST_CRON_SECRET)&&!CRON_COMMAND.includes(env.FANFUNNEL_TEST_CRON_SECRET));
 check('setup success never claims scheduled execution',setup.result.phase==='configuration_only'&&!setup.result.scheduledExecutionVerified);
 check('reports omit credentials and raw environment data',![env.VERCEL_TOKEN,env.SUPABASE_ACCESS_TOKEN,env.FANFUNNEL_TEST_CRON_SECRET,sensitive.envs[0].value].some(value=>JSON.stringify(setup.result).includes(value)));
 const noRun=await run({configured:true},{TEST_MAINTENANCE_ACTION:'status'});check('status is read-only and unproven execution fails',noRun.result&&!noRun.result.ok&&noRun.mutations.length===0&&noRun.probeGets===0);
 const success=await run({configured:true,status:{requests:[request],health}},{TEST_MAINTENANCE_ACTION:'status'});check('status requires exact cron, HTTP and app completion',success.result?.ok&&success.result.scheduledExecutionVerified&&success.mutations.length===0);
 const preview={deploymentCreatedAt:CREATED,aliasAssignedAt:ALIAS};
 for(const patch of [{cronStatus:'running'},{httpStatus:401},{timedOut:true},{transportError:true},{applicationOk:false},{applicationCompletedAt:null},{responsePresent:false},{queuedAt:new Date(CREATED-1).toISOString()}]){const result=summarizeStatus({requests:[{...request,...patch}],health},preview,NOW);check('enqueue/HTTP/application/current Preview failures cannot be green',!result.scheduledExecutionVerified);}
 const expired=summarizeStatus({requests:[{...request,responsePresent:false,queuedAt:new Date(NOW-7*3600000).toISOString()}],health},preview,NOW);check('expired response evidence stays explicitly unverified',expired.requests[0].evidenceExpired&&!expired.scheduledExecutionVerified);
 check('nonzero current ledger counts cannot be healthy',!summarizeStatus({requests:[request],health:{...health,invariantCounts:{...zero,fanCreditMismatch:1}}},preview,NOW).currentHealthHealthy);
 const dirtyFixture=fixture();let dirtyError;try{await runMaintenance({env,actualSha:SHA,trackedStatus:' M source.ts',fetcher:dirtyFixture.fetcher,now:()=>NOW});}catch(error){dirtyError=error;}check('dirty actual source refuses before requests',dirtyError&&dirtyFixture.calls.length===0);
 const shaFixture=fixture();let shaError;try{await runMaintenance({env,actualSha:'b'.repeat(40),trackedStatus:'',fetcher:shaFixture.fetcher,now:()=>NOW});}catch(error){shaError=error;}check('actual checkout SHA is independently required',shaError&&shaFixture.calls.length===0);
 const partial=await run({platform:{...installed,extensions:installed.extensions.map(row=>row.name==='pg_net'?{...row,installedVersion:null}:row)},configuration:{jobCount:0,jobMatches:false,secretCount:1,secretOwned:true,secretMatches:false}});check('partial platform cannot hide an existing secret mismatch',partial.error?.code==='EXISTING_VAULT_SECRET_MISMATCH'&&partial.mutations.length===0&&partial.probeGets===0);
 const protectedPlatform=platformEnableSQL(['pg_cron','supabase_vault']);check('installation hardens only the newly created extension',protectedPlatform.includes('create extension pg_net')&&protectedPlatform.includes('revoke all on schema net')&&!protectedPlatform.includes('revoke all on schema vault')&&!protectedPlatform.includes('revoke all on schema cron'));
 check('reviewed rollback file exactly matches fixed generated SQL',readFileSync(new URL('./test-maintenance-rollback.sql',import.meta.url),'utf8')===ROLLBACK_SQL+'\n');
 const workflow=readFileSync(new URL('../../.github/workflows/e2e-supabase.yml',import.meta.url),'utf8');
 check('existing integration steps remain present',workflow.includes('run: npm run e2e:supabase')&&workflow.includes('run: npm run e2e:spin')&&workflow.includes('node scripts/security/rls-runtime-test.mjs'));
 check('manual job needs unchanged Supabase tests and no npm install/deployment',workflow.includes('needs: supabase')&&workflow.includes("inputs.test_maintenance_action != 'off'")&&!workflow.slice(workflow.indexOf('  test-maintenance:')).includes('npm ci'));
 check('fixed command uses bounded GET, Vault and only description updates',CRON_COMMAND.includes('net.http_get(')&&CRON_COMMAND.includes('timeout_milliseconds:=60000')&&CRON_COMMAND.includes('for update of v')&&CRON_COMMAND.includes('update vault.secrets s set description=')&&!/set\s+secret\s*=/i.test(CRON_COMMAND));
 check('initial Vault metadata is versioned and empty',JSON.parse(INITIAL_DESCRIPTION).requests.length===0&&JSON.parse(INITIAL_DESCRIPTION).version===1);
 assert.throws(()=>checkSensitiveCronEnvironment({envs:[]},CREATED));checks++;
 assert.throws(()=>checkStableAlias({...alias,deploymentId:'dpl_other'}));checks++;
 console.log(`TEST maintenance: ${checks} pure guard/API/workflow/evidence checks passed; no hosted calls or real secrets`);
}
await main();
