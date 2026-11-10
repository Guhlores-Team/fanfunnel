import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;

// OPS-12: the maintenance matcher is pure; the rewrites next.config.ts builds
// from it and the proxy's write refusal agree with it on every path.
let passed = 0;
const check = (label: string, ok: unknown) => { assert.ok(ok, label); passed++; };

async function main() {
  const m = await import("./maintenance");
  // OPS3-04: /pending, /agency, the password pages, /verify and /api/cron/*
  // stay reachable while paused (an invited creator finishes set-up, a fan's
  // proof link works, the nightly job and its heartbeat still run).
  const PAGES = ["/", "/spin/abc123", "/c/demo", "/share/abc", "/leaderboard/x", "/signup", "/dashboardish", "/administrator", "/loginx", "/pendingx", "/verifyx", "/agencies"];
  const EXEMPT = ["/dashboard", "/dashboard/settings", "/admin", "/admin/x", "/agency", "/login", "/mfa", "/auth/callback", "/pending", "/forgot-password", "/reset-password", "/set-password", "/verify/0123456789abcdef01", "/maintenance", "/privacy", "/terms", "/app-icon", "/_next/static/chunks/main.js", "/favicon.ico", "/sw.js", "/robots.txt", "/manifest.webmanifest", "/logo.png", "/.well-known/security.txt", "/api/admin/audit", "/api/admin/lookup", "/api/admin", "/api/health", "/api/maintenance", "/api/cron/retention"];
  const API = ["/api/spin", "/api/fan/reward", "/api/campaigns/stats", "/api/healthz", "/api/administrator", "/api/errors", "/api/push/subscribe", "/api/cronx"];
  for (const p of PAGES) check(`${p} → maintenance page`, m.maintenanceRoute(p) === "page");
  for (const p of EXEMPT) check(`${p} stays reachable`, m.maintenanceRoute(p) === "exempt");
  for (const p of API) check(`${p} is paused API`, m.maintenanceRoute(p) === "api");
  check("an API write is blocked", m.maintenanceBlocksWrite("/api/spin", "POST") && m.maintenanceBlocksWrite("/api/fan/reward", "delete"));
  check("an API read passes the proxy", !m.maintenanceBlocksWrite("/api/campaigns/stats", "GET") && !m.maintenanceBlocksWrite("/api/campaigns/stats", "HEAD"));
  check("admin writes pass", !m.maintenanceBlocksWrite("/api/admin/account", "POST"));
  check("only exactly 1 turns it on", m.maintenanceOn({ FF_MAINTENANCE: "1" }) && !m.maintenanceOn({ FF_MAINTENANCE: "true" }) && !m.maintenanceOn({}));
  check("off: no rewrites at all", m.maintenanceRewrites({}).length === 0);
  check("Retry-After on every refusal", m.MAINTENANCE_HEADERS["Retry-After"] === String(m.MAINTENANCE_RETRY_AFTER_SECONDS));

  // The real next.config.ts rewrites, through Next's own route matcher.
  const { unstable_getResponseFromNextConfig } = await import("next/experimental/testing/server");
  const { default: nextConfig } = await import("../../../next.config");
  const rewrittenTo = async (path: string, cookies: Record<string, string> = {}) => {
    const res = await unstable_getResponseFromNextConfig({ url: `https://fanfunnel.test${path}`, nextConfig, cookies });
    const to = res.headers.get("x-middleware-rewrite");
    return to ? new URL(to).pathname : null;
  };
  delete process.env.FF_MAINTENANCE;
  for (const p of ["/", "/spin/abc123", "/api/spin"]) check(`off: ${p} is not rewritten`, (await rewrittenTo(p)) === null);
  process.env.FF_MAINTENANCE = "1";
  for (const p of PAGES) check(`on: ${p} → /maintenance`, (await rewrittenTo(p)) === m.MAINTENANCE_PAGE);
  for (const p of EXEMPT) check(`on: ${p} is not rewritten`, (await rewrittenTo(p)) === null);
  for (const p of API) check(`on: cookieless ${p} → /api/maintenance`, (await rewrittenTo(p)) === m.MAINTENANCE_API);
  for (const p of API) check(`on: signed-in ${p} is left to the proxy`, (await rewrittenTo(p, { "sb-x-auth-token": "1" })) === null);

  // The proxy's half: cookie-carrying API writes.
  const { NextRequest } = await import("next/server");
  const { proxy } = await import("../../proxy");
  const event = { waitUntil: () => undefined } as unknown as Parameters<typeof proxy>[1];
  const call = (path: string, method: string) => proxy(new NextRequest(`https://fanfunnel.test${path}`, { method, headers: { cookie: "sb-x-auth-token=1" } }), event);
  let res = await call("/api/spin", "POST");
  check("on: a signed-in API write → 503 maintenance", res.status === 503 && (await res.json()).error === "maintenance" && res.headers.get("retry-after") === "300" && /no-store/.test(res.headers.get("cache-control") ?? ""));
  res = await call("/api/campaigns/stats", "GET");
  check("on: a signed-in read passes", res.status === 200 && res.headers.get("x-middleware-next") === "1");
  res = await call("/api/admin/account", "POST");
  check("on: an admin write passes to its route", res.status !== 503);
  delete process.env.FF_MAINTENANCE;
  res = await call("/api/spin", "POST");
  check("off: the write passes", res.status !== 503);

  const { GET, POST } = await import("../../app/api/maintenance/route");
  const mreq = () => new Request("https://fanfunnel.test/api/maintenance", { method: "POST" });
  check("off: /api/maintenance is a 404", (await GET(mreq())).status === 404);
  process.env.FF_MAINTENANCE = "1";
  const r = await POST(mreq());
  check("on: /api/maintenance → 503 {error:maintenance} + Retry-After", r.status === 503 && (await r.json()).error === "maintenance" && r.headers.get("retry-after") === "300");
  console.log(`maintenance: ${passed} checks passed`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
