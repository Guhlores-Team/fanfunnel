import assert from "node:assert";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";

// Next's server modules expect the global its own Node bootstrap installs, so
// they're imported in main(), after this.
(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;

// PERF-4: the proxy (session refresh) runs only where a refresh is needed.
// AUTH-SENSITIVE: every server-rendered page that reads the session must stay
// matched, and dropping a route from the proxy must not drop its security
// headers (those come from next.config.ts).

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

// Every app route, with dynamic segments filled in.
function appRoutes(dir = join("src", "app")): { path: string; file: string }[] {
  const out: { path: string; file: string }[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...appRoutes(p));
    else if (entry === "page.tsx" || entry === "route.ts") {
      const segs = relative(join("src", "app"), dir)
        .split(sep)
        .filter((s) => s && !/^\(.*\)$/.test(s))
        .map((s) => (/^\[.*\]$/.test(s) ? "sample-id" : s));
      out.push({ path: "/" + segs.join("/"), file: p });
    }
  }
  return out;
}

async function main() {
  const { unstable_doesMiddlewareMatch, unstable_getResponseFromNextConfig } = await import(
    "next/experimental/testing/server"
  );
  const { default: nextConfig } = await import("../next.config");
  const { config } = await import("./proxy");
  const { needsSessionRefresh } = await import("./lib/supabase/middleware");
  const matches = (path: string) =>
    unstable_doesMiddlewareMatch({ config, nextConfig, url: path });

  const routes = appRoutes();
  check("found the app routes", routes.length > 50);

  // 1. The matcher and needsSessionRefresh agree on every real route.
  for (const { path } of routes) {
    check(`matcher == needsSessionRefresh for ${path}`, matches(path) === needsSessionRefresh(path));
  }

  // 2. Every server-rendered page that reads the session is matched. A page
  //    reads it directly (auth.getUser / getSession) or through the admin
  //    guard (checkAdmin / requireAdminRoute call auth.getUser for it).
  const sessionPages = routes.filter(({ file }) => {
    if (!file.endsWith("page.tsx")) return false;
    const src = readFileSync(file, "utf8");
    return (
      !/^\s*["']use client["']/.test(src) &&
      /auth\.get(User|Session)\(|\b(checkAdmin|requireAdminRoute)\(/.test(src)
    );
  });
  check("found the session-reading pages", sessionPages.length >= 4);
  for (const { path } of sessionPages) {
    check(`session-reading page ${path} runs the proxy`, matches(path));
  }

  // 3. The auth routes, explicitly (incl. nested dashboard/admin paths).
  for (const path of ["/dashboard", "/dashboard/settings", "/admin", "/agency", "/pending", "/login", "/signup"]) {
    check(`${path} runs the proxy`, matches(path) && needsSessionRefresh(path));
  }

  // 4. Public pages, API routes and assets skip it.
  const skipped = [
    "/",
    "/c/demo",
    "/spin/some-token",
    "/share/abc",
    "/verify/abc",
    "/leaderboard/abc",
    "/forgot-password",
    "/reset-password",
    "/auth/callback",
    "/api/spin",
    "/api/campaigns/stats",
    "/_next/static/chunks/main.js",
    "/favicon.ico",
    "/logo.png",
    "/dashboardish",
    "/administrator",
  ];
  for (const path of skipped) {
    check(`${path} skips the proxy`, !matches(path) && !needsSessionRefresh(path));
  }

  // 5. Security headers still apply to routes the proxy no longer runs on.
  const expected = [
    "referrer-policy",
    "x-content-type-options",
    "x-frame-options",
    "permissions-policy",
    "content-security-policy",
  ];
  for (const path of ["/", "/c/demo", "/spin/some-token", "/api/spin", "/dashboard"]) {
    const res = await unstable_getResponseFromNextConfig({
      url: `https://fanfunnel.test${path}`,
      nextConfig,
    });
    for (const h of expected) {
      check(`${path} keeps ${h}`, !!res.headers.get(h));
    }
  }

  console.log(`proxy: ${passed} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
