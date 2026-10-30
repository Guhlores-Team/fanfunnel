import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { FakeTables } from "@/lib/privacy/fakeTables";
import { FakeStorage } from "@/lib/privacy/fakeStorage";
import { FakeStorageWork } from "./fakeWork";
import { abandonStorageUpload, processPendingStorageWork, storageRpc, trackedCreatorUpload, type StorageWorkClient } from "./work";
import { deleteAccountAndTombstoneLinks, processAccountStorageDeletion } from "@/lib/account/deleteAccount";
const A = "aaaaaaaa-0000-4000-8000-00000000000a";
const path = () => `${A}/${randomUUID()}.webp`;
function gate() {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  return { enter, release, entered, blocked };
}
async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error("causal operation stalled")),5000);})]); }
  finally { clearTimeout(timer); }
}
function fixture() {
  const tables = new FakeTables({profiles:[{id:A,role:"creator",is_active:true,approval_status:"approved"}]});
  const storage = new FakeStorage(); storage.add("avatars"); storage.add("creator-media");
  const users = new Set([A]);
  const work = new FakeStorageWork(tables,{authExists:(owner)=>users.has(owner)});
  const controls: { auth?: () => Promise<{error: unknown}> } = {};
  const service = {
    from:work.from,rpc:work.rpc,
    storage:{listBuckets:storage.storage.listBuckets,from:(bucket:string)=>({...storage.storage.from(bucket),upload:async(objectPath:string)=>{storage.add(bucket,objectPath);return {error:null};}})},
    auth:{admin:{deleteUser:async()=>controls.auth ? controls.auth() : {error:{status:400}}}},
  } as unknown as StorageWorkClient;
  const expire = () => { tables.rows("creator_storage_deletions")[0].lease_until=new Date(0).toISOString(); };
  const deniedStorage = { ...service, storage:{...service.storage,listBuckets:async()=>({data:null,error:{status:403}})} } as unknown as StorageWorkClient;
  return {tables,storage,users,work,controls,service,expire,deniedStorage};
}
async function upload(f:ReturnType<typeof fixture>,bucket:"avatars"|"creator-media"="avatars",publish=true) {
  const objectPath=path();
  const result=await trackedCreatorUpload(f.service,{owner:A,bucket,path:objectPath,bytes:new Uint8Array([1]),contentType:"image/webp",publish,authorize:async()=>f.tables.rows("profiles")[0]?.is_active===true});
  assert.ok("ok" in result);return {id:result.id,path:objectPath};
}
async function main() {
  for (const newAttempt of [false,true]) {
    // Preserve the review's exact adverse order: old list stalls, lease expires,
    // another worker restores, a fresh upload succeeds, old list resumes.
    const f=fixture(),g=gate(),original=f.service.storage.from.bind(f.service.storage);let first=true;
    f.service.storage.from=((bucket:string)=>({...original(bucket),list:async(...args:Parameters<ReturnType<typeof original>["list"]>)=>{
      if(first){first=false;g.enter();await g.blocked;} return original(bucket).list(...args);
    }})) as unknown as typeof f.service.storage.from;
    const old=deleteAccountAndTombstoneLinks(f.service,A,{wasAdmin:false});await within(g.entered);f.expire();
    assert.deepEqual(await processAccountStorageDeletion(f.deniedStorage,A),{error:"storage_cleanup_failed"});
    assert.equal(f.tables.rows("profiles")[0].is_active,true);
    const fresh=await upload(f);const oldAttempt=f.tables.rows("creator_storage_deletions")[0].attempt_id;
    if(newAttempt){await f.work.rpc("creator_storage_account",{p_operation:"begin",p_owner:A,p_actor:A,p_action:"account.self_close"});assert.notEqual(f.tables.rows("creator_storage_deletions")[0].attempt_id,oldAttempt);}
    g.release();assert.ok("pending" in await within(old));
    assert.ok(f.storage.objects.get("avatars")!.has(fresh.path),"expired list must never authorize removal of a restored account's fresh upload");
    assert.ok(!f.storage.removals.some((row)=>row.paths.includes(fresh.path)));
    assert.equal(f.tables.rows("creator_storage_dispatches").filter((row)=>row.kind!=="manifest").length,0,"stale discovery dispatches no removal in either old or new attempt");
    if(newAttempt){await processAccountStorageDeletion(f.service,A);assert.ok(!f.storage.objects.get("avatars")!.has(fresh.path),"only the newly authorized attempt can remove its own manifest");}
  }
  {
    const f=fixture(),g=gate();f.storage.add("avatars",`${A}/legacy.png`);
    const original=f.service.storage.from.bind(f.service.storage);let first=true;
    f.service.storage.from=((bucket:string)=>({...original(bucket),remove:async(paths:string[])=>{if(first){first=false;g.enter();await g.blocked;}return original(bucket).remove(paths);}})) as unknown as typeof f.service.storage.from;
    const old=deleteAccountAndTombstoneLinks(f.service,A,{wasAdmin:false});await within(g.entered);f.expire();
    const failure={...f.service,storage:{...f.service.storage,from:(bucket:string)=>({...original(bucket),remove:async()=>({data:null,error:{status:403}})})}} as unknown as StorageWorkClient;
    assert.ok("pending" in await processAccountStorageDeletion(failure,A));
    assert.equal(f.tables.rows("profiles")[0].is_active,false,"pending old remove blocks restoration despite a new worker's definite failure");
    assert.deepEqual(await trackedCreatorUpload(f.service,{owner:A,bucket:"avatars",path:path(),bytes:new Uint8Array([1]),contentType:"image/webp",authorize:async()=>true}),{error:"forbidden"});
    g.release();await within(old);
    assert.deepEqual(await processAccountStorageDeletion(f.deniedStorage,A),{error:"storage_cleanup_failed"});
    const fresh=await upload(f);assert.ok(f.storage.objects.get("avatars")!.has(fresh.path),"restoration is safe only after the old dispatch definitely finished");
  }
  for(const uncertain of [false,true]) {
    const f=fixture(),g=gate();f.controls.auth=async()=>{g.enter();await g.blocked;if(uncertain)throw new Error("Auth transport unknown");return {error:{status:400}};};
    const old=deleteAccountAndTombstoneLinks(f.service,A,{wasAdmin:false});await within(g.entered);f.expire();
    assert.ok("pending" in await processAccountStorageDeletion(f.deniedStorage,A));
    assert.equal(f.tables.rows("profiles")[0].is_active,false,"a delayed Auth dispatch can never coexist with restored active access");
    g.release();await within(old);
    const retry=await processAccountStorageDeletion(f.deniedStorage,A);
    if(uncertain){assert.ok("pending" in retry);assert.equal(f.tables.rows("profiles")[0].is_active,false);assert.ok(f.tables.rows("creator_storage_dispatches").some((row)=>row.kind==="auth"&&row.state==="uncertain"));}
    else{assert.deepEqual(retry,{error:"storage_cleanup_failed"});assert.equal(f.tables.rows("profiles")[0].is_active,true);await upload(f);}
  }
  {
    const f=fixture();f.storage.add("avatars",`${A}/unknown-remove.png`);
    const original=f.service.storage.from.bind(f.service.storage);
    f.service.storage.from=((bucket:string)=>({...original(bucket),remove:async(paths:string[])=>{await original(bucket).remove(paths);throw new Error("acknowledgement lost");}})) as unknown as typeof f.service.storage.from;
    assert.ok("pending" in await deleteAccountAndTombstoneLinks(f.service,A,{wasAdmin:false}));
    assert.ok("pending" in await processAccountStorageDeletion(f.deniedStorage,A));
    assert.equal(f.tables.rows("profiles")[0].is_active,false,"unknown removal dispatches cannot be waved away on lease expiry");
  }
  {
    const f=fixture(),fresh=await upload(f,"creator-media",false);
    const rpc=f.service.rpc.bind(f.service);
    f.service.rpc=(async(name:string,args:Record<string,unknown>)=>{const result=await rpc(name,args);if(name==="creator_storage_publish_media")throw new Error("response lost after commit");return result;}) as unknown as typeof f.service.rpc;
    const lost=await storageRpc(f.service,"creator_storage_publish_media",{p_id:fresh.id,p_caption:"safe",p_width:1,p_height:1});assert.equal(lost.error,"db_error");
    const row=f.tables.rows("creator_storage_objects")[0];assert.equal(row.media_id,fresh.id);assert.equal(f.tables.rows("creator_media").length,1);assert.ok(row.published_at);
    f.service.rpc=rpc;
    const recovered=await storageRpc(f.service,"creator_storage_publish_media",{p_id:fresh.id,p_caption:"safe",p_width:1,p_height:1});assert.equal(recovered.error,null);assert.equal(f.tables.rows("creator_media").length,1,"idempotent publication cannot create a duplicate row");
    // A process crash after the atomic commit retains both row and bytes;
    // maintenance cannot mistake a published bound photo for an orphan.
    row.expires_at=new Date(0).toISOString();await processPendingStorageWork(f.service);assert.ok(f.storage.objects.get("creator-media")!.has(fresh.path));
    assert.equal(await abandonStorageUpload(f.service,fresh.id),true);assert.equal(f.tables.rows("creator_media").length,0);assert.ok(!f.storage.objects.get("creator-media")!.has(fresh.path));
  }
  {
    // Preserve the original commit-then-error causal shape even for a legacy
    // unbound INSERT: abandonment must reconcile its exact owner/path row.
    const f=fixture(),fresh=await upload(f,"creator-media");f.tables.rows("creator_media").push({id:randomUUID(),creator_id:A,path:fresh.path});
    assert.equal(await abandonStorageUpload(f.service,fresh.id),true);assert.equal(f.tables.rows("creator_media").length,0,"bytes and committed metadata are removed together");
  }
  {
    const f=fixture();
    for(let i=0;i<40;i++){const id=randomUUID();await f.work.rpc("creator_storage_register_upload",{p_id:id,p_owner:A,p_bucket:"avatars",p_path:path()});await f.work.rpc("creator_storage_finish_upload",{p_id:id,p_outcome:"uncertain"});}
    const definite: string[]=[];
    for(let i=0;i<10;i++){const fresh=await upload(f);definite.push(fresh.path);if(i<5)await f.work.rpc("creator_storage_finish_upload",{p_id:fresh.id,p_outcome:"cleanup"});else{const row=f.tables.rows("creator_storage_objects").find((entry)=>entry.id===fresh.id)!;row.published_at=null;row.expires_at=new Date(0).toISOString();}}
    let completed=0;for(let i=0;i<4;i++)completed+=(await processPendingStorageWork(f.service)).completed;
    assert.equal(completed,10,"more than one bounded page of absent uncertain rows cannot starve newer queued or expired work");
    assert.ok(definite.every((objectPath)=>!f.storage.objects.get("avatars")!.has(objectPath)));
    const uncertain=f.tables.rows("creator_storage_objects").filter((row)=>row.upload_state==="uncertain");assert.equal(uncertain.length,40);assert.ok(uncertain.every((row)=>!row.removed_at&&Number(row.attempts)>=1&&row.last_attempt_at&&Date.parse(String(row.next_attempt_at))>Date.now()));
  }
  console.log("adversarial storage: stale list/new attempt, delayed remove/Auth, unknown dispatch restoration blocks, atomic media commit/error/crash and fair >20-item scheduling passed");
}
main().catch((error)=>{console.error(error);process.exit(1);});
