import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import CreatorMfaRecovery from "@/components/auth/CreatorMfaRecovery";
import { creatorMfaRecoveryHref } from "./creatorMfaRecovery";
let count=0;
for(const destination of ["settings","reset","admin","/mfa","//evil.example","https://evil.example","/dashboard?password=private",null,{next:"/mfa"}]) {
 const url=new URL(creatorMfaRecoveryHref(destination),"https://example.test");
 assert.equal(url.origin,"https://example.test");count++;
 assert.equal(url.pathname,"/mfa");count++;
 const next=url.searchParams.get("next");assert.ok(["/admin","/dashboard?section=settings","/dashboard?section=boosts"].includes(next!));count++;
 assert.ok(!url.href.includes("private")&&!url.href.includes("evil"));count++;
}
assert.equal(renderToStaticMarkup(createElement(CreatorMfaRecovery,{required:false,destination:"settings"})),"");count++;
const html=renderToStaticMarkup(createElement(CreatorMfaRecovery,{required:true,destination:"settings"}));
assert.ok(html.includes('role="alert"')&&html.includes('href="/mfa?next=')&&html.includes("submit this change again")&&html.includes('target="_blank"')&&html.includes('rel="noopener noreferrer"'));count++;
assert.ok(!/input|password|localStorage|sessionStorage/.test(html));count++;
console.log(`creator MFA recovery: ${count} checks passed`);
