import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
// Next's testing helper needs this global before it is imported (in main()).
(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;

// RS-04/WA-10: every /api answer is `private, no-store` unless it is one of the
// shared public reads, which next.config.ts leaves out by path (a config header
// replaces the route's own, so "default" has to mean "scoped"). Those excluded
// routes must therefore set Cache-Control themselves, which is checked here.
let passed = 0;
const check = (label: string, ok: unknown) => { assert.ok(ok, label); passed++; };

async function main() {
  const { unstable_getResponseFromNextConfig } = await import("next/experimental/testing/server");
  const { default: nextConfig } = await import("../../../next.config");
  const cacheHeader = async (path: string) => (await unstable_getResponseFromNextConfig({ url: `https://fanfunnel.test${path}`, nextConfig })).headers.get("cache-control");

  for (const p of ["/api/me", "/api/health", "/api/spin", "/api/admin/errors", "/api/cron/retention", "/api/account/export", "/api/publicity", "/api/recent-winsx"]) {
    check(`${p} is private, no-store by default`, (await cacheHeader(p)) === "private, no-store");
  }
  for (const p of ["/api/public/wheel/abc", "/api/recent-wins/abc"]) {
    check(`${p} keeps its own (public, short TTL) header`, (await cacheHeader(p)) === null);
  }
  for (const p of ["/", "/spin/abc", "/leaderboard/abc"]) {
    check(`${p} (a page) gets no API default`, (await cacheHeader(p)) === null);
  }

  // The excluded routes set Cache-Control on every success answer themselves.
  const root = new URL("../../../", import.meta.url).pathname;
  const routes: string[] = [];
  const walk = (dir: string) => { for (const f of readdirSync(dir)) { const p = join(dir, f); if (statSync(p).isDirectory()) walk(p); else if (f === "route.ts") routes.push(p); } };
  for (const dir of ["src/app/api/public", "src/app/api/recent-wins"]) walk(join(root, dir));
  check("the excluded prefixes hold route handlers", routes.length >= 2);
  for (const r of routes) {
    const code = readFileSync(r, "utf8");
    // A cacheable read says how long; the claim-code check (a POST verdict)
    // says no-store on every answer, refusals included.
    const verdict = r.endsWith("public/claim-check/route.ts");
    check(`${r.slice(root.length)} sets Cache-Control itself`, /"Cache-Control"/.test(code) && (verdict
      ? /"no-store"/.test(code) && !/return badRequest\(\);|return limited;/.test(code) && !/s-maxage/.test(code)
      : /public, s-maxage=\d+/.test(code)));
  }
  console.log(`api cache default: ${passed} checks passed`);
}
main().catch((e) => { console.error(e); process.exit(1); });
