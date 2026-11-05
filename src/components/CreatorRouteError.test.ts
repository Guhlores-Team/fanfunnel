import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

// QA b5 m10: a creator page that crashed showed the fan copy ("your spins and
// balance are safe"), and /reset-password crashed in demo mode because it made
// a Supabase client without checking the config.
let passed = 0;
const check = (label: string, cond: unknown) => { assert.ok(cond, label); passed++; };
const view = readFileSync("src/components/CreatorRouteError.tsx", "utf8");
check("the creator error copy never talks about spins or balance", !/spins|balance/i.test(view.replace(/\/\*\*[\s\S]*?\*\//g, "")));
check("it reports through the shared boundary view", /import RouteErrorView from "@\/components\/RouteErrorView"/.test(view));
for (const route of ["dashboard", "agency", "admin", "login", "forgot-password", "reset-password", "mfa", "pending"]) {
  const f = `src/app/${route}/error.tsx`;
  check(`${f} exists`, existsSync(f));
  const src = existsSync(f) ? readFileSync(f, "utf8") : "";
  check(`${f} is a client boundary using the creator error`, src.trimStart().startsWith('"use client"') && /<CreatorRouteError /.test(src));
}
const reset = readFileSync("src/app/reset-password/page.tsx", "utf8");
const effect = reset.slice(reset.indexOf("useEffect(() => {"), reset.indexOf("async function submit"));
check("reset-password checks the config before creating a client", /if \(!configured\) return;/.test(effect) && effect.indexOf("if (!configured) return;") < effect.indexOf("createClient()"));
check("reset-password says what to do in demo mode", /Password reset isn&rsquo;t available here/.test(reset));
console.log(`CreatorRouteError.test: ${passed} checks passed`);
