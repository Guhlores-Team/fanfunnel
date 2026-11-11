// b7 server fixes, cheap HTTP checks (demo mode):
//  WA-09 /api/cron/retention without the scheduler's bearer is a 401 (never
//        a 503 that tells a stranger the deployment cannot run its cron).
//  WF-05 a flooded leaderboard PAGE gets a branded "try again in N s" page
//        with Retry-After; WF-03 the API's 429 carries Retry-After too.
//  RS-04 every /api route is private, no-store unless it says otherwise:
//        /api/health keeps its own header, the public wheel teaser stays cacheable.
//  WA-08 a path with an empty segment (//admin, what `/\admin` becomes) is a
//        400 from the proxy, not an unmonitored 500.
//  RS-04 an /api answer the page never reads still finishes loading.
// Requests that spend a limit carry their own x-real-ip, so no other journey's
// budget is touched. The closed-link page (WC-13) is proved in fan-devices.mjs.
import { randomBytes, randomUUID } from "node:crypto";
import { attachSink, BASE, goto } from "./harness.mjs";

const ip = () => `198.51.100.${1 + Math.floor(Math.random() * 250)}`;

export async function opsB7Journey(browser, { step, assert }, sink, ctx) {
  const request = ctx.request;

  await step("b7 WA-09: the cron route refuses a call without the scheduler's secret with 401, never 503", async () => {
    const plain = await request.get(BASE + "/api/cron/retention", { headers: { "x-real-ip": ip() } });
    assert(plain.status() === 401, `no bearer → 401 (got ${plain.status()})`);
    assert((await plain.json()).error === "unauthorized", "the body says unauthorized and nothing else");
    assert(/no-store/.test(plain.headers()["cache-control"] ?? ""), "the refusal is no-store");
    const wrong = await request.get(BASE + "/api/cron/retention", { headers: { "x-real-ip": ip(), authorization: "Bearer " + randomBytes(16).toString("hex"), "user-agent": "vercel-cron/1.0" } });
    assert(wrong.status() === 401, `a wrong bearer from the scheduler's user-agent → 401 (got ${wrong.status()})`);
  });

  await step("b7 WF-05/WF-03: a flooded leaderboard page gets a branded wait page; the API 429 carries Retry-After", async () => {
    const addr = ip();
    let last = null;
    for (let i = 0; i < 121; i++) {
      last = await request.get(`${BASE}/leaderboard/demo-creator`, { headers: { "x-real-ip": addr } });
      if (last.status() === 429) break;
    }
    assert(last.status() === 429, `the page is cut off at its budget (last status ${last.status()})`);
    assert(/text\/html/.test(last.headers()["content-type"] ?? ""), "the refusal is a page, not JSON");
    assert(/^\d+$/.test(last.headers()["retry-after"] ?? ""), "the page carries Retry-After in seconds");
    assert(/no-store/.test(last.headers()["cache-control"] ?? ""), "the page is no-store");
    const html = await last.text();
    assert(html.includes("Too many requests") && /Try again in <span class="wait">\d+ (seconds|minutes)<\/span>/.test(html), "the page says how long to wait");
    assert(!/\b(buy|paid|purchase|gamble|bet|lottery)\b/i.test(html), "fan-facing copy stays clean");
    const other = await request.get(`${BASE}/leaderboard/demo-creator`, { headers: { "x-real-ip": ip() + "1" } });
    assert(other.status() !== 429, `another address still gets the page (${other.status()})`);

    // The API side of the same flood (fan-token misses on /api/spin, ATK-04):
    // the 429 that remains for a genuine flood names its wait.
    const apiAddr = ip() + "2";
    let api = null;
    for (let i = 0; i < 121; i++) {
      api = await request.post(BASE + "/api/spin", { headers: { "x-real-ip": apiAddr }, data: { token: randomBytes(24).toString("hex"), requestId: randomUUID(), clientSeed: "b7" } });
      if (api.status() === 429) break;
    }
    assert(api.status() === 429, `the API flood is cut off (last status ${api.status()})`);
    assert(/^\d+$/.test(api.headers()["retry-after"] ?? ""), "the API 429 carries Retry-After");
    assert(/application\/json/.test(api.headers()["content-type"] ?? ""), "the API keeps answering JSON");
  });

  await step("b7 RS-04: /api is private, no-store by default; the shared public reads keep their short CDN TTL", async () => {
    for (const p of ["/api/me", "/api/health", "/api/cron/retention"]) {
      const res = await request.get(BASE + p, { headers: { "x-real-ip": ip() } });
      assert((res.headers()["cache-control"] ?? "") === "private, no-store", `${p} is private, no-store (got "${res.headers()["cache-control"]}")`);
    }
    const teaser = await request.get(BASE + "/api/public/wheel/demo-creator", { headers: { "x-real-ip": ip() } });
    assert(teaser.status() === 200, `the public teaser answers (got ${teaser.status()})`);
    assert(/^public, s-maxage=60/.test(teaser.headers()["cache-control"] ?? ""), `the public teaser stays cacheable (got "${teaser.headers()["cache-control"]}")`);
    const wins = await request.get(BASE + "/api/recent-wins/demo-creator", { headers: { "x-real-ip": ip() } });
    assert(wins.status() === 200 && /^public, s-maxage=10/.test(wins.headers()["cache-control"] ?? ""), `recent wins stay cacheable (${wins.status()}, "${wins.headers()["cache-control"]}")`);
  });

  await step("b7 RS-04: an /api answer the page never reads still finishes loading (its body can be read)", async () => {
    // A no-store response whose body the page ignores stays pending in
    // Chromium; a journey that then reads that body used to wait for ever
    // (the full run hung in play.mjs). src/lib/api/drainResponses.ts reads a
    // clone of every such answer, installed before hydration.
    const page = await ctx.newPage();
    attachSink(page, sink);
    try {
      await goto(page, "/", 400);
      const [res] = await Promise.all([
        page.waitForResponse((r) => new URL(r.url()).pathname === "/api/health", { timeout: 8000 }),
        page.evaluate(async () => (await fetch("/api/health")).ok),
      ]);
      assert(/no-store/.test(res.headers()["cache-control"] ?? ""), "the answer is no-store");
      const body = await Promise.race([res.json(), new Promise((_, reject) => setTimeout(() => reject(new Error("the body read hung for 8 s")), 8000))]);
      assert(body.ok === true, "the unread answer's body is readable");
    } finally {
      await page.close();
    }
  });

  await step("b7 WA-08: a path with an empty segment never reaches a 500 (normalised or refused)", async () => {
    // `next start` normalises repeated slashes to a 308 before the proxy runs;
    // Vercel's router did not and answered 500, which the proxy now refuses
    // with 400 (src/proxy.ts, proxyEncoding.test.ts). Either answer is safe.
    for (const path of ["//admin", "/admin//errors", "/\\admin"]) {
      const res = await request.get(BASE + path, { headers: { "x-real-ip": ip() }, maxRedirects: 0 });
      const location = res.headers()["location"] ?? "";
      assert(res.status() === 400 || (res.status() === 308 && !location.includes("//") && !location.includes("\\")), `${path} → 400 or a clean 308 (got ${res.status()} ${location})`);
    }
  });
}
