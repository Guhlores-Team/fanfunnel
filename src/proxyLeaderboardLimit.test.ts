import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { mock } from "node:test";
import { NextResponse } from "next/server";

(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;

// WF-05: the leaderboard PAGE's rate limit (proxy) answers a branded page with
// Retry-After, never raw JSON; API routes keep their JSON 429.
let limited = false;
mock.module("@/lib/api/limit", { namedExports: { limitRoute: async () => limited ? NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": "54" } }) : null } });
let passed = 0;
const check = (label: string, ok: unknown) => { assert.ok(ok, label); passed++; };

async function main() {
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  const { NextRequest } = await import("next/server");
  const { proxy } = await import("./proxy");
  const { tooManyRequestsPage } = await import("./lib/api/tooManyPage");
  const event = { waitUntil: () => undefined } as unknown as Parameters<typeof proxy>[1];
  const page = () => proxy(new NextRequest("https://fanfunnel.test/leaderboard/someone", { headers: { accept: "text/html" } }), event);
  check("under the limit the page passes through", (await page()).headers.get("x-middleware-next") === "1");
  limited = true;
  const res = await page();
  const html = await res.text();
  check("over the limit: 429 with Retry-After, no-store", res.status === 429 && res.headers.get("retry-after") === "54" && res.headers.get("cache-control") === "no-store");
  check("…as an HTML page, not JSON", /^text\/html/.test(res.headers.get("content-type") ?? "") && html.startsWith("<!doctype html>") && !html.includes('"rate_limited"'));
  check("…that names the wait and reassures", /Too many requests/.test(html) && /Try again in <span class="wait">54 seconds<\/span>/.test(html) && /Nothing was spent/.test(html) && /noindex/.test(html));
  check("…with no script (CSP-safe) and no interpolated input", !/<script/i.test(html));
  check("minutes for long waits, a floor of 1 s, a cap of an hour", /2 minutes/.test(tooManyRequestsPage(120)) && /1 seconds/.test(tooManyRequestsPage(0)) && /60 minutes/.test(tooManyRequestsPage(99_999)) && /1 seconds/.test(tooManyRequestsPage(Number.NaN)));
  console.log(`proxy leaderboard limit page: ${passed} checks passed`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
