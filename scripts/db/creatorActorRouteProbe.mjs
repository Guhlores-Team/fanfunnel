import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
export async function probeCreatorActorRoute(sql,{actor,creator,grant,session}) {
 const child=spawn('npx',['tsx','--experimental-test-module-mocks','--import','./scripts/test-preload.mjs','scripts/db/creatorActorRouteFixture.ts'],{cwd:new URL('../../',import.meta.url),env:{...process.env,FF_FIXTURE_ACTOR:actor,FF_FIXTURE_CREATOR:creator,FF_FIXTURE_GRANT:grant,FF_FIXTURE_SESSION:session},stdio:['pipe','pipe','pipe']});
 let stderr='',done=0;child.stderr.on('data',b=>stderr+=b);
 const timer=setTimeout(()=>child.kill('SIGTERM'),45000);
 createInterface({input:child.stdout}).on('line',async line=>{const request=JSON.parse(line);if(request.done){done=request.checks;return;}if(!request.sql)return;try{const data=await sql(request.sql);child.stdin.write(JSON.stringify({id:request.id,data})+'\n');}catch(error){child.stdin.write(JSON.stringify({id:request.id,error:error.message})+'\n');}});
 await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',code=>{clearTimeout(timer);code===0&&done?resolve():reject(Error('Actual creator HTTP/PG route fixture failed: '+stderr));});});
 console.log(`PASS actual creator route -> real service gateway: ${done} causal checks`);
}
