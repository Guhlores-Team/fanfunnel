import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { mock } from "node:test";

(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;
let passed = 0;
function check(label: string, condition: boolean) { assert.ok(condition, label); passed++; }

async function main() {
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.RESEND_API_KEY;
  delete process.env.ALERT_EMAIL_TO;
  delete process.env.VERCEL_ENV;
  delete process.env.FF_REQUIRE_SUPABASE;
  let externalCalls = 0;
  globalThis.fetch = (async () => { externalCalls++; throw new Error("No external request is allowed in this test"); }) as typeof fetch;
  const { NextRequest } = await import("next/server");
  const { unstable_doesMiddlewareMatch } = await import("next/experimental/testing/server");
  const { default: nextConfig } = await import("../next.config");
  const middleware = await import("./lib/supabase/middleware");
  const refreshed: string[] = [];
  mock.module("@/lib/supabase/middleware", { namedExports: {
    needsSessionRefresh: middleware.needsSessionRefresh,
    updateSession: async (request: InstanceType<typeof NextRequest>) => { refreshed.push(request.nextUrl.pathname); return new Response("refreshed", { headers: { "x-test-session-refresh": "1" } }); },
  } });
  const store = await import("./lib/data/appErrors");
  const { proxy, config } = await import("./proxy");
  const matches = (path: string) => unstable_doesMiddlewareMatch({ config, nextConfig, url: `https://fanfunnel.test${path}` });
  const pending: Promise<unknown>[] = [];
  const event = { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); } } as Parameters<typeof proxy>[1];
  store.resetMemoryAppErrors();
  const secrets = ["private-fan-token", "private-password", "private-cookie", "private-agent", "private-query"];
  const malformed = ["/%", "/%GG", "/%E0%A4%A", "/%C0%AF", "/spin/private-fan-token%", "/c/%FF", "/dashboard/%ED%A0%80", "/api/fans/%F4%90%80%80"];
  for (const path of malformed) {
    check(`${path} reaches the encoding guard`, matches(path));
    const response = await proxy(new NextRequest(`https://fanfunnel.test${path}?token=private-query`, { headers: { authorization: "Bearer private-password", cookie: "session=private-cookie", "user-agent": "private-agent" } }), event);
    check(`${path} rejects before routing with400`, response.status === 400);
    check(`${path} cannot be cached`, response.headers.get("cache-control") === "no-store");
    check(`${path} has a generic response`, JSON.stringify(await response.json()) === '{"error":"bad_request"}');
  }
  check("every rejection schedules supported background monitoring", pending.length === malformed.length);
  await Promise.all(pending.splice(0));
  check("malformed paths never refresh Supabase auth", refreshed.length === 0);
  const errors = await store.listAppErrors({ status: "open" });
  assert.ok(Array.isArray(errors));
  check("the actual monitor stores the generic server occurrence", errors.length === 1 && errors[0].source === "server" && errors[0].route === "/[invalid-encoding]" && errors[0].count === malformed.length);
  check("raw path/query/headers never enter stored metadata", errors[0].message === "Malformed URL encoding rejected" && errors[0].userAgent === null);
  check("stored monitoring metadata contains no private input", !secrets.some(secret => JSON.stringify(errors).includes(secret)));

  const validPublic = ["/", "/terms", "/c/caf%C3%A9", "/spin/%25", "/spin/%2525", "/share/with%20space", "/verify/%2F", "/leaderboard/%E6%97%A5", "/api/spin?token=bad%", "/_next/static/with%20space.js"];
  for (const path of validPublic) {
    const response = await proxy(new NextRequest(`https://fanfunnel.test${path}`), event);
    check(`valid public ${path} passes without session work`, response.status === 200 && response.headers.get("x-middleware-next") === "1");
  }
  check("healthy public and API requests do not call the auth helper", refreshed.length === 0);
  check("healthy public requests do not enter monitoring", pending.length === 0);
  for (const path of ["/dashboard", "/dashboard/%25", "/admin", "/agency", "/pending", "/login", "/signup", "/mfa"]) {
    check(`auth matcher remains for ${path}`, matches(path));
    check(`auth refresh remains for ${path}`, (await proxy(new NextRequest(`https://fanfunnel.test${path}`), event)).headers.get("x-test-session-refresh") === "1");
  }
  check("exactly the auth-relevant requests called refresh", refreshed.length === 8);
  for (const path of ["/", "/c/demo", "/spin/some-token", "/api/spin", "/_next/static/main.js"]) check(`normal public ${path} still skips Proxy entirely`, !matches(path));
  // Actual monitoring storage now fails closed because a required database
  // configuration is absent; rejecting a bad public path must still work.
  process.env.FF_REQUIRE_SUPABASE = "1";
  const failure = await proxy(new NextRequest("https://fanfunnel.test/spin/%"), event);
  await Promise.all(pending);
  delete process.env.FF_REQUIRE_SUPABASE;
  check("monitor failure cannot turn malformed input into500", failure.status === 400);
  check("no valid or invalid public request performed an external fetch", externalCalls === 0);
  console.log(`proxyEncoding: ${passed} checks passed`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
