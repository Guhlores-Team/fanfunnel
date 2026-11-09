// b6 operations in the browser (demo mode):
//  OPS-02 /api/health answers 200 {ok:true, mode:"demo"} and is never cached.
//  OPS-08/09/10 System health names the maintenance job's last run, which
//      services are configured (names only) and the rate-limit store fallback.
//  OPS-04 Admin › Look up a win: a fresh win's verify link shows its prize,
//      delivery state and fan-data state, never a fan token; a cross-site
//      request to the lookup route is refused (403); the Activity filter and
//      its "looked up a win" entry. The creator-gets-403 NEGATIVE needs real
//      accounts: src/app/api/admin/lookup/route.test.ts proves it.
import { randomUUID } from "node:crypto";
import { acknowledgeFixtureFan, attachSink, BASE, goto } from "./harness.mjs";

export async function opsB6Journey(browser, { step, assert }, sink, ctx) {
  const request = ctx.request;

  await step("b6 OPS-02: /api/health is 200 {ok:true} in demo and never cached", async () => {
    const res = await request.get(BASE + "/api/health");
    assert(res.status() === 200, `health → 200 (got ${res.status()})`);
    const body = await res.json();
    assert(body.ok === true && body.mode === "demo" && Object.keys(body).length === 2, `health body has no detail (${JSON.stringify(body)})`);
    assert(/no-store/.test(res.headers()["cache-control"] ?? ""), "health is no-store");
  });

  await step("b6 OPS-08/09/10: System health shows the maintenance line, configured services and store fallback", async () => {
    const page = await ctx.newPage();
    attachSink(page, sink);
    try {
      await goto(page, "/admin", 600);
      const panel = page.getByRole("region", { name: "System health", exact: true });
      const line = panel.getByTestId("maintenance-line");
      await line.waitFor({ timeout: 10000 });
      assert(/^Maintenance job: (no run recorded|last ran .+)\./.test(await line.innerText()), "maintenance line names the last run");
      assert((await line.getAttribute("data-stale")) === "false", "demo never reports a stale job");
      const flags = panel.getByRole("list", { name: "Configured services" }).getByRole("listitem");
      assert(await flags.count() === 6, "six services listed");
      assert(/^Alert e-mails: (ON|OFF)$/.test(await panel.getByTestId("ops-flag-alertEmail").innerText()), "alert e-mails ON/OFF");
      for (const name of ["CRON_SECRET", "HEARTBEAT_URL", "VAPID key pair"]) {
        assert(/: (configured|not set)$/.test(await panel.getByText(name, { exact: false }).first().innerText()), `${name} is yes/no`);
      }
      assert(/^Rate-limit store: /.test(await panel.getByTestId("rate-limit-fallback").innerText()), "store fallback line");
    } finally {
      await page.close();
    }
  });

  await step("b6 OPS-04: Look up a win shows a fresh win's facts and never a fan token", async () => {
    const pass = await (await request.post(BASE + "/api/passes", { data: { requestId: randomUUID(), name: "Ops Lookup Fan", spins: 1 } })).json();
    assert(typeof pass?.token === "string", "a fan to win");
    assert((await acknowledgeFixtureFan(request, pass.token)).ok(), "age gate acknowledged");
    const spin = await (await request.post(BASE + "/api/spin", { data: { requestId: randomUUID(), token: pass.token, clientSeed: "ops-b6" } })).json();
    assert(typeof spin?.shareId === "string" && typeof spin?.prize?.label === "string", "a win to look up");

    const api = await request.post(BASE + "/api/admin/lookup", { data: { query: `${BASE}/verify/${spin.shareId}` } });
    const raw = await api.text();
    assert(api.status() === 200, `lookup → 200 (got ${api.status()})`);
    assert(!raw.includes(pass.token) && !raw.includes("Ops Lookup Fan"), "the answer never carries the fan's token or name");

    const page = await ctx.newPage();
    attachSink(page, sink);
    try {
      await goto(page, "/admin", 600);
      const panel = page.getByRole("region", { name: "Look up a win", exact: true });
      await panel.getByLabel("Verify link or share id").fill(`${BASE}/verify/${spin.shareId}`);
      await panel.getByRole("button", { name: "Look up" }).click();
      const result = panel.getByTestId("admin-lookup-result");
      await result.waitFor({ timeout: 10000 });
      const text = await result.innerText();
      assert(text.includes(spin.prize.label), "shows the prize");
      assert(/Kept \(the fan has not deleted it\)/.test(text), "shows the fan kept their data");
      assert(!text.includes(pass.token) && !text.includes("Ops Lookup Fan"), "the page never shows the token or name");
      await panel.getByLabel("Verify link or share id").fill("not a link at all");
      await panel.getByRole("button", { name: "Look up" }).click();
      await panel.getByText("That doesn't look like a verify link or share id.", { exact: false }).waitFor({ timeout: 5000 });
    } finally {
      await page.close();
    }
  });

  await step("b6 OPS-04 (negative): a cross-site request to the lookup is refused with 403", async () => {
    const res = await request.post(BASE + "/api/admin/lookup", {
      headers: { origin: "https://evil.example", cookie: "sb-e2e-auth-token=1" },
      data: { query: "abc123def456abc123" },
    });
    assert(res.status() === 403, `cross-site lookup → 403 (got ${res.status()})`);
    const body = await res.json().catch(() => ({}));
    assert(body.win === undefined, "no win in a refusal");
  });

  await step("b6 OPS-04: the Activity filter finds the lookup and says when nothing matches", async () => {
    const page = await ctx.newPage();
    attachSink(page, sink);
    try {
      await goto(page, "/admin", 600);
      const panel = page.getByRole("region", { name: "Activity", exact: true });
      const search = panel.getByRole("searchbox", { name: "Filter by action" });
      await search.fill("lookup");
      await panel.getByRole("button", { name: "Filter" }).click();
      await panel.getByText("looked up a win", { exact: false }).first().waitFor({ timeout: 10000 });
      const items = panel.locator("ol > li");
      const n = await items.count();
      assert(n >= 1, "at least the lookup above");
      for (let i = 0; i < n; i++) assert(/looked up a win/.test(await items.nth(i).innerText()), "only lookups are listed");
      await search.fill("zzzz nothing");
      await panel.getByRole("button", { name: "Filter" }).click();
      await panel.getByText("No activity matches this filter.").waitFor({ timeout: 10000 });
      await panel.getByRole("button", { name: "Clear" }).click();
      await panel.locator("ol > li").first().waitFor({ timeout: 10000 });
    } finally {
      await page.close();
    }
  });
}
