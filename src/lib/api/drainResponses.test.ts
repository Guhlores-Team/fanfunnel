import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { drainApiResponse, installApiResponseDrain, shouldDrainApiResponse } from "./drainResponses";

// RS-04 follow-up: an unread no-store /api answer never finishes loading in
// Chromium (a full e2e run hung on one). The page's fetch is wrapped once so a
// clone of such an answer is read to the end; the caller's Response is untouched.
let passed = 0;
const check = (label: string, ok: unknown) => { assert.ok(ok, label); passed++; };
const ORIGIN = "https://app.example";

function answer(url: string, init: { status?: number; headers?: Record<string, string>; body?: string | null } = {}) {
  const res = new Response(init.body === undefined ? JSON.stringify({ ok: true }) : init.body, {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", "cache-control": "private, no-store", ...(init.headers ?? {}) },
  });
  Object.defineProperty(res, "url", { value: url });
  let clones = 0;
  const clone = res.clone.bind(res);
  res.clone = () => { clones++; return clone(); };
  return { res, clones: () => clones };
}

async function main() {
  check("a same-origin no-store JSON /api answer is drained", shouldDrainApiResponse(answer(ORIGIN + "/api/fan/reminder").res, ORIGIN));
  for (const [label, a] of [
    ["another origin", answer("https://other.example/api/x")],
    ["a page or RSC request", answer(ORIGIN + "/dashboard?_rsc=1")],
    ["a path that only looks like /api", answer(ORIGIN + "/apiary/x")],
    ["a cacheable public read", answer(ORIGIN + "/api/public/wheel/x", { headers: { "cache-control": "public, s-maxage=60" } })],
    ["a download", answer(ORIGIN + "/api/account/export", { headers: { "content-disposition": 'attachment; filename="x.json"' } })],
    ["a non-JSON body", answer(ORIGIN + "/api/x", { headers: { "content-type": "text/event-stream" } })],
    ["a 204", answer(ORIGIN + "/api/x", { status: 204, body: null })],
    ["an unknown url", answer("")],
  ] as const) {
    check(`${label} is left alone`, !shouldDrainApiResponse(a.res, ORIGIN) && !drainApiResponse(a.res, ORIGIN) && a.clones() === 0);
  }

  const a = answer(ORIGIN + "/api/fan/reminder", { body: JSON.stringify({ reminder: 20 }) });
  check("draining reads a clone…", drainApiResponse(a.res, ORIGIN) && a.clones() === 1 && !a.res.bodyUsed);
  check("…and the caller can still read its own body afterwards", (await a.res.json()).reminder === 20);
  const used = answer(ORIGIN + "/api/me");
  await used.res.text();
  check("a body the caller already read is not cloned (and nothing throws)", !drainApiResponse(used.res, ORIGIN) && used.clones() === 0);
  const locked = answer(ORIGIN + "/api/me");
  locked.res.body!.getReader();
  check("a body the caller is reading right now never throws", drainApiResponse(locked.res, ORIGIN) === false);

  // The wrapper: same promise, same Response, installed once.
  const served: ReturnType<typeof answer>[] = [];
  const calls: unknown[][] = [];
  const base = function (this: unknown, ...args: unknown[]) { calls.push([this, ...args]); const next = answer(String(args[0]).startsWith("http") ? String(args[0]) : ORIGIN + String(args[0])); served.push(next); return Promise.resolve(next.res); };
  const host: { fetch: typeof fetch; location: { origin: string } } = { fetch: base as unknown as typeof fetch, location: { origin: ORIGIN } };
  check("install wraps fetch", installApiResponseDrain(host) && host.fetch !== (base as unknown));
  const wrappedOnce = host.fetch;
  check("installing again is a no-op", !installApiResponseDrain(host) && host.fetch === wrappedOnce);
  const init = { method: "POST" };
  const res = await host.fetch("/api/fan/reminder", init);
  check("the caller gets the original Response, unread", res === served[0].res && !res.bodyUsed);
  check("arguments and `this` pass through unchanged", calls[0][0] === host && calls[0][1] === "/api/fan/reminder" && calls[0][2] === init);
  check("the answer was drained through a clone before the caller touched it", served[0].clones() === 1 && (await res.json()).ok === true);
  await host.fetch("/dashboard");
  check("other requests are not cloned", served[1].clones() === 0);
  const failing: { fetch: typeof fetch; location: { origin: string } } = { fetch: (async () => { throw new TypeError("offline"); }) as typeof fetch, location: { origin: ORIGIN } };
  installApiResponseDrain(failing);
  check("a failed fetch rejects for the caller exactly as before", await failing.fetch("/api/me").then(() => false, (e) => e instanceof TypeError && e.message === "offline"));
  check("without fetch or an origin nothing is installed", !installApiResponseDrain({}) && !installApiResponseDrain({ fetch: base as unknown as typeof fetch }));

  const hook = readFileSync(new URL("../../instrumentation-client.ts", import.meta.url), "utf8");
  check("the client instrumentation hook installs it (before hydration, on every page)", /installApiResponseDrain\(\)/.test(hook));
  const src = readFileSync(new URL("./drainResponses.ts", import.meta.url), "utf8");
  check("the module is browser-safe (no imports)", !/^import /m.test(src));
  console.log(`api response drain: ${passed} checks passed`);
}
main().catch((e) => { console.error(e); process.exit(1); });
