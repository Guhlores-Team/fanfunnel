import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { mock } from "node:test";
let complete=false;
mock.module("@/lib/hooks/useFetch",{namedExports:{useFetch:(url:string)=>({loading:false,error:null,reload:async()=>{},data:url.includes("/roi")?{rows:[{prizeId:null,label:"Deleted Gift",rarity:"common",timesWon:1,costCents:null,totalCostCents:0},{prizeId:"current",label:"Gift",rarity:"common",timesWon:1,costCents:5000,totalCostCents:5000}]}:url.includes("/profit")?{summary:{revenueCents:20000,costCents:5000,profitCents:15000,marginPct:.75,costsComplete:complete,costBasis:"current_prize_cost",historicalCostsKnown:false}}:null})}});
mock.module("@/components/dashboard/CrmPanel",{defaultExport:()=>null});
async function main(){const {default:AnalyticsPanel}=await import("./AnalyticsPanel");
 const html=renderToStaticMarkup(createElement(AnalyticsPanel)),unknown=html.slice(html.indexOf("Deleted Gift"),html.indexOf("</tr>",html.indexOf("Deleted Gift")));
 assert.equal((unknown.match(/—/g)??[]).length,3,"unknown unit/total/revenue percentage are all unavailable");
 assert.ok(!unknown.includes("$0.00"),"unknown cost never appears as free");
 assert.ok(html.includes("historical costs at the time of each win were not recorded")&&html.includes("Current cost each")&&html.includes("Estimated profit"),"all financial copy describes current estimates honestly");
 assert.ok(!html.includes("$150.00")&&!html.includes("75%"),"incomplete cost knowledge cannot display exact profit/margin");
 complete=true;const known=renderToStaticMarkup(createElement(AnalyticsPanel));assert.ok(known.includes("$150.00")&&known.includes("75%")&&known.includes("current estimates"),"complete known current estimate displays its labelled amount");
 console.log("financial estimate UI: 5 checks passed");
}
main().catch(error=>{console.error(error);process.exit(1);});
