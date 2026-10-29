import assert from "node:assert/strict";
import { mock } from "node:test";
import { NextResponse } from "next/server";
let allowed=true;const calls:unknown[][]=[];
mock.module("@/lib/data",{namedExports:{spin:async(...args:unknown[])=>{calls.push(args);return {prize:{id:"authoritative",label:"Server",rarity:"rare",weight:1},prizeIndex:0,spinsRemaining:2,gameKind:"bingo",bonusWins:[]};}}});
mock.module("@/lib/api/fanToken",{namedExports:{withFanToken:async(req:Request,_options:unknown,run:(token:string,body:Record<string,unknown>)=>Promise<NextResponse>)=>allowed?run("resolved-token",await req.json()):NextResponse.json({error:"blocked"},{status:403})}});
async function main(){const {POST}=await import("./route"),requestId=crypto.randomUUID();const payload={token:"client-token",requestId,clientSeed:"chosen-client-seed",gameKind:"bingo",cardId:"foreign-card",fanId:"foreign-fan",markedMask:511,bonusWins:[{reward:{value:"forged"}}],serverSeed:"forged",prizeId:"forged-prize"};
 const response=await POST(new Request("http://localhost/api/spin",{method:"POST",body:JSON.stringify(payload)}));assert.equal(response.status,200);assert.deepEqual(calls,[["resolved-token","chosen-client-seed",requestId,undefined]],"only token binding and opaque intent reach the authoritative data engine");assert.equal(response.headers.get("Cache-Control"),"no-store");
 allowed=false;const blocked=await POST(new Request("http://localhost/api/spin",{method:"POST",body:JSON.stringify(payload)}));assert.equal(blocked.status,403);assert.equal(calls.length,1,"F5 refusal prevents any game/card/bonus call");
 console.log("game route authority: 5 checks passed");}
main().catch(error=>{console.error(error);process.exit(1);});
