import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { serverRequestProtocol } from "./cookies";

// RS-09: the proxy and the server derive the cookie's Secure flag from the
// same first-hop rule, so a multi-hop proxy (`https,http`) can never produce
// two session cookies that disagree.
let passed = 0;
const check = (label: string, ok: unknown) => { assert.ok(ok, label); passed++; };
check("first hop wins on a multi-hop header", serverRequestProtocol("https,http") === "https" && serverRequestProtocol("http, https") === "http");
const mw = readFileSync(new URL("./middleware.ts", import.meta.url), "utf8");
const server = readFileSync(new URL("./server.ts", import.meta.url), "utf8");
check("middleware.ts uses serverRequestProtocol for the cookie options", /sessionCookieOptions\(\s*serverRequestProtocol\(request\.headers\.get\("x-forwarded-proto"\)/.test(mw));
check("server.ts uses the same helper", /sessionCookieOptions\(\s*serverRequestProtocol\(headerStore\.get\("x-forwarded-proto"\)\)/.test(server));
check("no raw x-forwarded-proto reaches sessionCookieOptions anywhere", !/sessionCookieOptions\(\s*request\.headers\.get/.test(mw));
console.log(`middleware proto: ${passed} checks passed`);
