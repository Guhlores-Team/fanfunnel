import assert from "node:assert/strict";
import { mock } from "node:test";

const redirects: string[] = [];
mock.module("next/navigation", { namedExports: { redirect: (to: string) => { redirects.push(to); throw new Error("NEXT_REDIRECT " + to); } } });

let passed = 0;
const check = (label: string, cond: unknown) => { assert.ok(cond, label); passed++; };
async function main() {
const { linkAttemptsBlocked, linkNotFound, notFoundPath, parseNotFoundPath } = await import("./linkNotFound");

check("a dead spin link goes to the unmatched not-found path with its token", notFoundPath("spin", "abc def") === "/not-found/spin/abc%20def");
check("no detail, no tail", notFoundPath("share") === "/not-found/share");
check("a huge id is cut (the path is only a signal)", notFoundPath("c", "x".repeat(500)).length < 200);
check("the proxy reads the kind and the id back", JSON.stringify(parseNotFoundPath("/not-found/spin/abc%20def")) === JSON.stringify({ kind: "spin", detail: "abc def" }));
check("the busy page carries its retry seconds", JSON.stringify(parseNotFoundPath("/not-found/busy/42")) === JSON.stringify({ kind: "busy", detail: "42" }));
check("an unknown kind is not a not-found signal", parseNotFoundPath("/not-found/admin/x") === null && parseNotFoundPath("/not-found") === null);
check("a bad encoding loses the detail, never throws", parseNotFoundPath("/not-found/spin/%E0%A4%A")?.detail === null);
assert.throws(() => linkNotFound("verify", "id1"), /NEXT_REDIRECT \/not-found\/verify\/id1/);
assert.throws(() => linkAttemptsBlocked(58_400), /NEXT_REDIRECT \/not-found\/busy\/59/);
check("both helpers redirect (never return)", redirects.length === 2);
console.log(`linkNotFound: ${passed + 2} checks passed`);
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
