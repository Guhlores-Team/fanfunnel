import assert from "node:assert/strict";
import { mock } from "node:test";
import { FakeTables,eqValue } from "@/lib/privacy/fakeTables";
const creator="creator-A",foreign="creator-B",fan="fan-A",token="private-bingo-export-token",at="2026-10-28T00:00:00Z";
const cards=Array.from({length:2001},(_,i)=>({id:`card-${String(2001-i).padStart(5,"0")}`,creator_id:creator,fan_id:fan,wheel_id:"game",cells:[{id:"cell",label:"Public",rarity:"rare",emoji:"⭐",cost_cents:995231,cipher:"PRIVATE-CIPHER"}],marked_mask:1,awarded_lines_mask:0,version:1,status:"active",created_at:at,completed_at:null,context:{seed:"FUTURE-SECRET"}}));
const awards=cards.map(card=>({card_id:card.id,line_index:0,creator_id:creator,fan_id:fan,wheel_id:"game",primary_spin_id:"primary",bonus_spin_id:"bonus",created_at:at,payload:{value:"PRIVATE-REWARD"}}));
const tables={profiles:[{id:creator,display_name:"Owner"}],fans:[{id:fan,creator_id:creator,display_name:"Fan"}],fan_passes:[{id:"link",token,creator_id:creator,fan_id:fan}],spins:[{id:"primary",creator_id:creator,fan_id:fan,kind:"play",game_kind:"bingo",prize_label:"Primary",prize_rarity:"rare",server_seed:"spent",created_at:at},{id:"bonus",creator_id:creator,fan_id:fan,kind:"bonus",parent_spin_id:"primary",bingo_line:0,game_kind:"bingo",prize_label:"Bonus",prize_rarity:"epic",created_at:at}],
 bingo_cards:[...cards,{...cards[0],id:"OTHER-FAN-CARD",fan_id:"other-fan"},{...cards[0],id:"OTHER-TENANT-CARD",creator_id:foreign}],bingo_line_awards:[...awards,{...awards[0],card_id:"OTHER-FAN-AWARD",fan_id:"other-fan"},{...awards[0],card_id:"OTHER-TENANT-AWARD",creator_id:foreign}]};
const service=new FakeTables(tables),session=new FakeTables(tables);let creatorMode=false,usedService=false;
mock.module("@/lib/supabase/server",{namedExports:{isSupabaseConfigured:()=>true,createServiceClient:()=>{if(creatorMode)usedService=true;return {from:(table:string)=>service.from(table)};},createClient:async()=>({from:(table:string)=>session.from(table),auth:{getUser:async()=>({data:{user:{id:creator,email:"owner@example.test",created_at:at}}})}})}});
let passed=0;function check(label:string,value:unknown){assert.ok(value,label);passed++;}
async function main(){const {exportFanData,exportCreatorData}=await import("./privacy");
 const exported=(await exportFanData(token))!;
 check("all cards and composite-key awards are paged beyond the default limit",exported.bingoCards.length===2001&&exported.bingoLineAwards.length===2001&&exported.complete);
 check("card cells are safe and no private contexts or rewards enter the file",!["995231","PRIVATE-CIPHER","FUTURE-SECRET","PRIVATE-REWARD","OTHER-FAN","OTHER-TENANT"].some(secret=>JSON.stringify(exported).includes(secret)));
 check("bonus linkage stays honest without an independent seed",exported.spins.find(spin=>spin.kind==="bonus")?.parentSpinId==="primary"&&exported.spins.find(spin=>spin.kind==="bonus")?.fairness.serverSeed===null);
 for(const statement of service.statements.filter(statement=>["bingo_cards","bingo_line_awards"].includes(statement.table))){check("new card and award reads are doubly scoped and ordered",eqValue(statement,"fan_id")===fan&&eqValue(statement,"creator_id")===creator&&!!statement.orders?.length);}
 service.rowLimit=137;const small=(await exportFanData(token))!;check("short server pages never imply complete early termination",small.complete&&small.bingoCards.length===2001&&small.bingoLineAwards.length===2001);
 service.failWhen=statement=>statement.table==="bingo_line_awards"&&statement.range?.[0]===137?"PRIVATE-DATABASE-DIAGNOSTIC":null;
 const partial=(await exportFanData(token))!;check("award paging failure is explicitly partial and keeps the successful prefix",!partial.complete&&partial.failed.includes("bingoLineAwards")&&partial.bingoLineAwards.length===137&&partial.bingoCards.length===2001&&!JSON.stringify(partial).includes("PRIVATE-DATABASE-DIAGNOSTIC"));
 creatorMode=true;const business=(await exportCreatorData())!;
 check("creator export pages complete owned card and award metadata",business.sections.bingo_cards.length===2002&&business.sections.bingo_line_awards.length===2002);
 check("creator export remains RLS-scoped without a service client",!usedService&&!JSON.stringify(business).includes("OTHER-TENANT"));
 const statements=session.statements.filter(statement=>statement.table==="bingo_line_awards");check("creator composite award pagination has stable card and line ordering",statements.every(statement=>eqValue(statement,"creator_id")===creator&&statement.orders?.some(order=>order.column==="card_id")&&statement.orders?.some(order=>order.column==="line_index")));
 console.log(`Bingo export paging: ${passed} checks passed`);
}
main().catch(error=>{console.error(error);process.exit(1);});
