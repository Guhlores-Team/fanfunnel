import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

// L3 + L4, every API route:
//   - static: no route reads a body with an uncapped req.json() /
//     request.json(); a route that parses JSON itself caps the read and
//     refuses a non-object;
//   - runtime (demo store): every POST / PUT / PATCH / DELETE handler answers
//     a JSON body of null, an array, a number or a string with a 4xx (never a
//     500 or a thrown error, never a 2xx), and the unauthenticated fan and
//     visitor routes answer exactly 400 bad_request.
process.env.NEXT_PUBLIC_ENABLE_DEBUG = "1";

let passed = 0;
const check = (label: string, cond: unknown) => { assert.ok(cond, label); passed++; };

const API = join("src", "app", "api");
function routeFiles(dir = API): string[] {
  return readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    return statSync(p).isDirectory() ? routeFiles(p) : e === "route.ts" ? [p] : [];
  });
}
const files = routeFiles().sort();
check("found the API routes", files.length > 100);

// --- static ---------------------------------------------------------------
const RAW_JSON = /\b(req|request)\s*\.\s*json\s*\(/;
const OWN_PARSERS: Record<string, RegExp> = {
  // Both cap the read and refuse a non-object themselves.
  [join(API, "errors", "route.ts")]: /readCappedText\(/,
  [join(API, "admin", "system-health", "route.ts")]: /Array\.isArray\(body\)/,
};
for (const f of files) {
  const src = readFileSync(f, "utf8");
  check(`${f}: no uncapped req.json()`, !RAW_JSON.test(src));
  if (/JSON\.parse\(/.test(src)) {
    check(`${f}: parses JSON itself only where reviewed`, !!OWN_PARSERS[f] && OWN_PARSERS[f].test(src));
  }
}
// The ban also holds for any helper a route could call instead.
for (const f of ["src/lib/api/handler.ts", "src/lib/api/fanToken.ts"]) {
  check(`${f}: no uncapped req.json()`, !RAW_JSON.test(readFileSync(f, "utf8")));
}

// --- runtime --------------------------------------------------------------
const UNAUTHENTICATED = [
  "fan-data/delete", "fan-data/export", "fan/break", "fan/checkin", "fan/focus", "fan/reminder", "fan/reward",
  "fan/reward/history", "fans/ack", "leaderboard/opt-in", "messages/auto-intro", "messages/auto-outro",
  "messages/fan", "messages/fan/thread", "report", "report/photo", "self-exclude", "spin", "spin/status",
  "wishlists", "creator-application", "errors",
];
const METHODS = ["POST", "PUT", "PATCH", "DELETE"] as const;
const BODIES = ["null", "[]", "[{\"token\":\"t\"}]", "1", "\"token\"", "true"];

function routePath(f: string) {
  return "/" + relative(join("src", "app"), f).split(sep).slice(0, -1).map((s) => (/^\[.*\]$/.test(s) ? "x" : s)).join("/");
}
function params(f: string) {
  const p: Record<string, string> = {};
  for (const m of f.matchAll(/\[(\w+)\]/g)) p[m[1]] = "a0000000-0000-4000-8000-000000000001";
  return { params: Promise.resolve(p) };
}

async function main() {
  let ip = 0;
  let calls = 0;
  const seen = new Set<string>();
  for (const f of files) {
    const mod = (await import("./" + relative(API, f).split(sep).join("/"))) as Record<string, unknown>;
    const route = routePath(f).replace(/^\/api\//, "");
    // A handler that reads no body (sign-out, claim, a bare toggle) only has
    // to survive one; a handler that reads a JSON body must refuse it.
    const readsBody = /parseJsonBody\(|withFanToken\(|readCappedText\(|formData\(/.test(readFileSync(f, "utf8"));
    for (const method of METHODS) {
      const handler = mod[method];
      if (typeof handler !== "function") continue;
      seen.add(route);
      for (const body of BODIES) {
        const req = new Request(`http://localhost${routePath(f)}`, {
          method,
          headers: { "content-type": "application/json", "x-real-ip": `10.${(++ip >> 16) & 255}.${(ip >> 8) & 255}.${ip & 255}` },
          body,
        });
        let res: Response;
        try {
          res = (await (handler as (r: Request, c: unknown) => Promise<Response>)(req, params(f)));
        } catch (err) {
          assert.fail(`${method} ${route} with ${body} threw: ${String(err)}`);
        }
        calls++;
        check(`${method} ${route} with ${body}: never a 5xx (${res.status})`, res.status < 500);
        if (readsBody) check(`${method} ${route} with ${body}: a 4xx, not ${res.status}`, res.status >= 400);
        if (UNAUTHENTICATED.includes(route)) {
          const out = await res.json().catch(() => null);
          check(`${method} ${route} with ${body}: 400 bad_request (got ${res.status} ${JSON.stringify(out)})`, res.status === 400 && out?.error === "bad_request");
        }
      }
    }
  }
  for (const route of UNAUTHENTICATED) check(`unauthenticated route ${route} was exercised`, seen.has(route));
  check("a write handler was exercised for most routes", seen.size > 70 && calls > 400);
  console.log(`jsonBodies: ${passed} checks passed (${calls} calls)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
