// Disposable local PostgreSQL only. No Supabase URL or service credential is read.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, chownSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { probeBingoGames } from "./bingoGamesProbe.mjs";
const root=join(import.meta.dirname,"../.."),bin=process.env.PG_BIN,work=mkdtempSync(join(tmpdir(),"ff-bingo-"));
if(!bin)throw Error("Set PG_BIN to PostgreSQL16 bin");
let runAs={};if(process.getuid?.()===0){runAs={uid:Number(spawnSync("id",["-u","postgres"],{encoding:"utf8"}).stdout.trim()),gid:Number(spawnSync("id",["-g","postgres"],{encoding:"utf8"}).stdout.trim())};chownSync(work,runAs.uid,runAs.gid);}
const run=(tool,args)=>{const r=spawnSync(join(bin,tool),args,{encoding:"utf8",cwd:work,...runAs});if(r.status!==0)throw Error(r.stderr);return r.stdout;};
const args=["-U","postgres","-X","-h",work,"-p","54220","-d","postgres","-v","ON_ERROR_STOP=1","-qAt"];
const sql=q=>new Promise((resolve,reject)=>{const p=spawn(join(bin,"psql"),[...args,"-c",q],{stdio:["ignore","pipe","pipe"]});let out="",err="";p.stdout.on("data",v=>out+=v);p.stderr.on("data",v=>err+=v);p.on("error",reject);p.on("close",code=>code===0?resolve(out):reject(Error(err)));});
try{
 run("initdb",["-D",join(work,"data"),"-A","trust","--no-sync","-U","postgres","-E","UTF8","--locale=C"]);
 run("pg_ctl",["-D",join(work,"data"),"-l",join(work,"log"),"-w","-o",`-p 54220 -k ${work} -c listen_addresses= -c fsync=off`,"start"]);
 run("psql",[...args,"-f",join(root,"scripts/db/supabase-stub.sql")]);
 run("psql",[...args,"-f",join(root,"supabase/schema.sql")]);
 await probeBingoGames(sql);
}catch(e){console.error(e.message);process.exitCode=1;}finally{spawnSync(join(bin,"pg_ctl"),["-D",join(work,"data"),"-m","immediate","stop"],{cwd:work,...runAs});rmSync(work,{recursive:true,force:true});}
