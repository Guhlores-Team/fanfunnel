import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { mock } from "node:test";
let complete=false;let basis="current_prize_cost";let rowBasis:Record<string,unknown>={};
mock.module("@/lib/hooks/useFetch",{namedExports:{useCreatorFetch:(url:string)=>({loading:false,error:null,reload:async()=>{},data:url.includes("/roi")?{rows:[{prizeId:null,label:"Deleted Gift",rarity:"common",timesWon:1,costCents:null,totalCostCents:0},{prizeId:"current",label:"Gift",rarity:"common",timesWon:1,costCents:5000,totalCostCents:5000},{prizeId:"gone",label:"Retired Gift",rarity:"common",timesWon:2,costCents:null,totalCostCents:1400,...rowBasis}]}:url.includes("/profit")?{summary:{revenueCents:20000,costCents:5000,profitCents:15000,marginPct:.75,costsComplete:complete,costBasis:basis,historicalCostsKnown:basis==="award_cost"}}:null})}});
mock.module("@/components/dashboard/CrmPanel",{defaultExport:()=>null});
async function main(){const {default:AnalyticsPanel}=await import("./AnalyticsPanel");
 const html=renderToStaticMarkup(createElement(AnalyticsPanel)),unknown=html.slice(html.indexOf("Deleted Gift"),html.indexOf("</tr>",html.indexOf("Deleted Gift")));
 assert.equal((unknown.match(/—/g)??[]).length,3,"unknown unit/total/revenue percentage are all unavailable");
 assert.ok(!unknown.includes("$0.00"),"unknown cost never appears as free");
 assert.ok(html.includes("historical costs at the time of each win were not recorded")&&html.includes("Current cost each")&&html.includes("Estimated profit"),"all financial copy describes current estimates honestly");
 assert.ok(!html.includes("$150.00")&&!html.includes("75%"),"incomplete cost knowledge cannot display exact profit/margin");
 complete=true;const known=renderToStaticMarkup(createElement(AnalyticsPanel));assert.ok(known.includes("$150.00")&&known.includes("75%")&&known.includes("current estimates"),"complete known current estimate displays its labelled amount");
 const retired=(markup:string)=>markup.slice(markup.indexOf("Retired Gift"),markup.indexOf("</tr>",markup.indexOf("Retired Gift")));
 assert.ok(!retired(known).includes("$14.00"),"a row with no current cost and no recorded costs stays unknown");
 // A35 (0065): recorded award-time costs are labelled as such and need no current cost.
 basis="award_cost";rowBasis={costBasis:"award_cost",historicalCostsKnown:true};const recorded=renderToStaticMarkup(createElement(AnalyticsPanel));
 assert.ok(recorded.includes("cost when won")&&recorded.includes("as it was when the fan won it")&&!recorded.includes("historical costs at the time of each win were not recorded"),"recorded costs are described as award-time costs, not current estimates");
 assert.ok(retired(recorded).includes("$14.00"),"a row whose every win recorded its cost shows its total even without a current cost");
 basis="mixed";rowBasis={costBasis:"mixed",historicalCostsKnown:false};const mixed=renderToStaticMarkup(createElement(AnalyticsPanel));
 assert.ok(mixed.includes("current Cost setting instead")&&!retired(mixed).includes("$14.00"),"mixed reports say older wins are estimates and never show a partly unknown total");
 console.log("financial estimate UI: 9 checks passed");
}
main().catch(error=>{console.error(error);process.exit(1);});
