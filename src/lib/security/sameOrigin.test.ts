import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { ORIGIN_EXEMPT_API, isCrossOriginWrite, isOriginExemptApi } from "./sameOrigin";

// I4: a cookie-carrying write to /api must be same-origin. Allow cases: the
// app's own pages (Sec-Fetch-Site same-origin, or an Origin naming this host,
// on localhost, a Vercel Preview or the configured site), safe methods, no
// cookie, a non-browser client, exempt token/cron routes. Deny cases: any
// cross-site or same-site (sibling subdomain) browser write, Origin "null",
// a foreign or malformed Origin.
(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;

let passed = 0;
const check = (label: string, cond: unknown) => { assert.ok(cond, label); passed++; };

const PREVIEW = "fanfunnel-git-feature-team.vercel.app";
const h = (o: Record<string, string>) => new Headers(o);
const write = (headers: Record<string, string>, extra: Partial<Parameters<typeof isCrossOriginWrite>[0]> = {}) =>
  isCrossOriginWrite({ method: "POST", path: "/api/wheel", headers: h({ cookie: "sb-ref-auth-token=x", ...headers }), ...extra });

// Allowed.
check("same-origin fetch (Sec-Fetch-Site) is allowed", !write({ "sec-fetch-site": "same-origin", host: "localhost:3299" }));
check("same-origin with a matching Origin is allowed", !write({ "sec-fetch-site": "same-origin", origin: "http://localhost:3299", host: "localhost:3299" }));
check("no Sec-Fetch-Site, Origin = localhost host, is allowed", !write({ origin: "http://localhost:3299", host: "localhost:3299" }));
check("a Vercel Preview origin on its own host is allowed", !write({ origin: `https://${PREVIEW}`, host: PREVIEW }));
const VERCEL_SET = { "x-vercel-id": "fra1::abc", "x-vercel-deployment-url": PREVIEW };
check("x-forwarded-host (Vercel) naming the Origin is allowed", !write({ origin: `https://${PREVIEW}`, host: "internal:3000", "x-forwarded-host": PREVIEW, ...VERCEL_SET }, { onVercel: true }));
// Batch 6 N5: off Vercel, or without Vercel's header set, X-Forwarded-Host is client input.
check("x-forwarded-host without Vercel's header set is not trusted", write({ origin: "https://evil.example", host: "internal:3000", "x-forwarded-host": "evil.example" }, { onVercel: true }));
check("x-forwarded-host off Vercel is not trusted, even with spoofed x-vercel-* headers", write({ origin: "https://evil.example", host: "localhost:3299", "x-forwarded-host": "evil.example", ...VERCEL_SET }));
check("the configured site URL is allowed", !write({ origin: "https://fanfunnel.app", host: "internal:3000" }, { allowedOrigins: ["https://fanfunnel.app/"] }));
check("host comparison ignores case", !write({ origin: "https://FanFunnel.App", host: "fanfunnel.app" }));
check("a non-browser client (no Origin, no Sec-Fetch-Site) is allowed", !write({ host: "localhost:3299" }));
for (const method of ["GET", "HEAD", "OPTIONS", "get"]) {
  check(`${method} is never checked`, !write({ "sec-fetch-site": "cross-site", origin: "https://evil.example" }, { method }));
}
check("a request without cookies is not checked", !isCrossOriginWrite({ method: "POST", path: "/api/wheel", headers: h({ "sec-fetch-site": "cross-site", origin: "https://evil.example" }) }));
check("a non-API path is not checked", !write({ "sec-fetch-site": "cross-site" }, { path: "/dashboard" }));
for (const path of ["/api/spin", "/api/fan/checkin", "/api/fan-data/export", "/api/messages/fan/thread", "/api/cron/retention", "/api/wishlists"]) {
  check(`exempt token/cron route ${path} is not checked`, !write({ "sec-fetch-site": "cross-site", origin: "https://evil.example" }, { path }));
}

// Denied.
check("cross-site Sec-Fetch-Site is refused", write({ "sec-fetch-site": "cross-site", origin: "https://evil.example", host: "localhost:3299" }));
check("same-site (a sibling subdomain) is refused", write({ "sec-fetch-site": "same-site", origin: "https://evil.fanfunnel.app", host: "fanfunnel.app" }));
check("Sec-Fetch-Site none is refused for a write", write({ "sec-fetch-site": "none", host: "localhost:3299" }));
check("Sec-Fetch-Site wins over a spoofable matching Origin", write({ "sec-fetch-site": "cross-site", origin: "http://localhost:3299", host: "localhost:3299" }));
check("a foreign Origin (no Sec-Fetch-Site) is refused", write({ origin: "https://evil.example", host: "localhost:3299" }));
check("another Vercel deployment is refused", write({ origin: "https://attacker.vercel.app", host: PREVIEW }));
check("Origin null is refused", write({ origin: "null", host: "localhost:3299" }));
check("a malformed Origin is refused", write({ origin: "not a url", host: "localhost:3299" }));
check("a non-http Origin is refused", write({ origin: "file://", host: "localhost:3299" }));
check("a different port is refused", write({ origin: "http://localhost:4000", host: "localhost:3299" }));
for (const method of ["PUT", "PATCH", "DELETE"]) {
  check(`${method} is checked`, write({ "sec-fetch-site": "cross-site" }, { method }));
}
for (const path of ["/api/webhooks", "/api/webhooks/secret", "/api/messages/thread/f1", "/api/fans/f1/link-game", "/api/report/photo", "/api/fanatic", "/api/spinner"]) {
  check(`cookie route ${path} is checked`, write({ "sec-fetch-site": "cross-site" }, { path }));
}

// Every exempt route is really token/secret-authenticated: it never reads a
// session, so an exemption can't open a CSRF hole on a cookie route.
for (const entry of ORIGIN_EXEMPT_API) {
  const dir = join("src/app", entry.replace(/\/$/, ""));
  const routes: string[] = [];
  const walk = (d: string) => {
    if (existsSync(join(d, "route.ts"))) routes.push(join(d, "route.ts"));
    if (entry.endsWith("/")) {
      for (const e of readdirSync(d, { withFileTypes: true })) if (e.isDirectory()) walk(join(d, e.name));
    }
  };
  check(`exempt entry ${entry} exists`, existsSync(dir));
  walk(dir);
  check(`exempt entry ${entry} has routes`, routes.length > 0);
  for (const r of routes) {
    const src = readFileSync(r, "utf8");
    check(`${r} reads no session`, !/createClient\(|auth\.get(User|Session)|requireAdminRoute|requireCreator|resolveActingCreator/.test(src));
  }
}
check("prefix entries match only below them", isOriginExemptApi("/api/fan/x") && !isOriginExemptApi("/api/fans/x") && !isOriginExemptApi("/api/fan"));

// The proxy applies it: 403 before the route, pass-through otherwise.
async function proxyChecks() {
  const { NextRequest } = await import("next/server");
  const { proxy } = await import("@/proxy");
  const event = { waitUntil: () => {} } as never;
  const call = (path: string, headers: Record<string, string>, method = "POST") =>
    proxy(new NextRequest(`http://localhost:3299${path}`, { method, headers: { host: "localhost:3299", ...headers } }), event);
  let res = await call("/api/wheel", { cookie: "sb-ref-auth-token=x", "sec-fetch-site": "cross-site", origin: "https://evil.example" });
  check("proxy: a cross-site cookie write is 403", res.status === 403 && (await res.json()).error === "forbidden");
  check("proxy: the refusal is not cached", res.headers.get("cache-control") === "no-store");
  res = await call("/api/wheel", { cookie: "sb-ref-auth-token=x", "sec-fetch-site": "same-origin", origin: "http://localhost:3299" });
  check("proxy: a same-origin cookie write passes through", res.status === 200 && res.headers.get("x-middleware-next") === "1");
  res = await call("/api/wheel", { cookie: "sb-ref-auth-token=x" });
  check("proxy: a non-browser cookie write passes through", res.headers.get("x-middleware-next") === "1");
  res = await call("/api/spin", { cookie: "theme=1", "sec-fetch-site": "cross-site" });
  check("proxy: an exempt fan route passes through", res.headers.get("x-middleware-next") === "1");
  res = await call("/api/wheel", { cookie: "sb-ref-auth-token=x", "sec-fetch-site": "cross-site" }, "GET");
  check("proxy: a cross-site GET passes through (read-only)", res.headers.get("x-middleware-next") === "1");

  // M1: the leaderboard page is rate-limited per client (public tier, 120/min).
  const page = (ip: string) => call("/leaderboard/bella", { "x-real-ip": ip }, "GET");
  res = await page("203.0.113.7");
  check("proxy: the leaderboard page passes through under the limit", res.headers.get("x-middleware-next") === "1");
  for (let i = 1; i < 121 && res.status !== 429; i++) res = await page("203.0.113.7");
  check("proxy: the leaderboard page answers 429 past the limit", res.status === 429 && Number(res.headers.get("retry-after")) >= 1);
  check("proxy: …and the 429 is not cached", res.headers.get("cache-control") === "no-store");
  check("proxy: another client is unaffected", (await page("203.0.113.8")).headers.get("x-middleware-next") === "1");
}

proxyChecks()
  .then(() => console.log(`sameOrigin: ${passed} checks passed`))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
