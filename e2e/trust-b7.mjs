import { randomUUID } from "node:crypto";
// Trust & safety, batch 7 (TS-01, TS-03, TS-04, TS-06, TS-07, TS-09, TS-12,
// TS-18, WA-17). Every fixture is a fresh fan made through the creator API;
// the demo creator's own name, public page and wheel are restored after each
// refusal check so later journeys see what they expect.
//
// TS-01: the legal pages carry the bumped effective date.
// TS-03: "FanFunnel Support", "Supp0rt", "@FanFunnel", /c/admin are refused on
//        the display name, the board name and the public slug; /c/admin is 404.
// TS-04: links, phone numbers and handles are refused in the tagline, the
//        creator note, prize names (PUT /api/wheel) and board names.
// TS-18: a prize name longer than MAX_PRIZE_LABEL (80) is refused by the route.
// TS-06: no change notice shows while none is announced.
// TS-07/09/12: Terms name team replies and the name rule; Privacy names the
//        push services, the redirect timer key and the child-safety handling.
// WA-17: security.txt carries Canonical and Policy, and the Policy URL resolves.

import { acknowledgeFixtureFan, goto, BASE } from "./harness.mjs";

async function json(res, what) {
  if (!res.ok()) throw new Error(`${what} failed (${res.status()})`);
  return res.json();
}

async function expectRefusal(res, code, what, assert) {
  const body = await res.json().catch(() => null);
  assert(res.status() === 400 && body?.error === code, `${what} → 400 ${code} (got ${res.status()} ${JSON.stringify(body)})`);
}

export async function trustB7Journey(page, { step, assert }, ctx) {
  const tag = Math.random().toString(36).slice(2, 7);
  const post = (path, data) => ctx.request.post(BASE + path, { data });
  const put = (path, data) => ctx.request.put(BASE + path, { data });

  await step("trust-b7 TS-03/TS-04: the display name refuses impersonation and contact details", async () => {
    const account = await json(await ctx.request.get(BASE + "/api/account"), "account");
    const original = typeof account.displayName === "string" && account.displayName ? account.displayName : "Demo Creator";
    try {
      await expectRefusal(await put("/api/account/profile", { displayName: "FanFunnel Support" }), "name_reserved", "FanFunnel Support", assert);
      await expectRefusal(await put("/api/account/profile", { displayName: "Fanfunne1 Supp0rt" }), "name_reserved", "leet brand", assert);
      await expectRefusal(await put("/api/account/profile", { displayName: "Admin" }), "name_reserved", "Admin", assert);
      await expectRefusal(await put("/api/account/profile", { displayName: `Jane ${tag} 555-123-4567` }), "contains_phone", "phone in name", assert);
      await expectRefusal(await put("/api/account/profile", { displayName: `Jane ${tag} t.me/jane` }), "contains_link", "link in name", assert);
      const ok = await put("/api/account/profile", { displayName: `Jane ${tag}` });
      assert(ok.ok(), `an ordinary name still saves (${ok.status()})`);
    } finally {
      await put("/api/account/profile", { displayName: original });
    }
  });

  await step("trust-b7 TS-03/TS-04: the public page refuses a reserved slug and contact details in tagline and note", async () => {
    const saved = await json(await ctx.request.get(BASE + "/api/public-profile"), "public profile");
    try {
      for (const slug of ["admin", "fanfunnel", "FanFunnel Support", "supp0rt", "official-team"]) {
        await expectRefusal(await put("/api/public-profile", { slug }), "slug_reserved", `slug "${slug}"`, assert);
      }
      await expectRefusal(await put("/api/public-profile", { tagline: "DM me on telegram t.me/xxx" }), "contains_link", "tagline link", assert);
      await expectRefusal(await put("/api/public-profile", { tagline: "call +1 555 123 4567" }), "contains_phone", "tagline phone", assert);
      await expectRefusal(await put("/api/public-profile", { tagline: "ig: janedoe" }), "contains_handle", "tagline handle", assert);
      await expectRefusal(await put("/api/public-profile", { note: "my real page is example dot com" }), "contains_link", "note link", assert);
      await expectRefusal(await put("/api/public-profile", { note: "write to jane@example.com" }), "contains_email", "note e-mail", assert);
      const ok = await put("/api/public-profile", { tagline: `Spin for a surprise ${tag}`, note: "Thanks for being here. Ask me anything in chat." });
      assert(ok.ok(), `ordinary tagline and note still save (${ok.status()})`);
    } finally {
      await put("/api/public-profile", { tagline: saved.tagline ?? "", note: saved.note ?? "" });
    }
    const reserved = await ctx.request.get(BASE + "/c/admin");
    assert(reserved.status() === 404, `/c/admin is nobody's page (${reserved.status()})`);
    const demo = await ctx.request.get(BASE + "/c/demo");
    assert(demo.status() === 200, `/c/demo still serves (${demo.status()})`);
  });

  await step("trust-b7 TS-04/TS-18: prize names refuse links and the 80-character cap is the route's cap", async () => {
    const { wheel } = await json(await ctx.request.get(BASE + "/api/wheel"), "wheel");
    const withLabel = (label, extra = {}) => ({ wheel: { ...wheel, prizes: wheel.prizes.map((p, i) => (i === 0 ? { ...p, label, ...extra } : p)) } });
    await expectRefusal(await put("/api/wheel", withLabel("Pay $20 at cash.app/xyz for VIP")), "contains_link", "prize link", assert);
    await expectRefusal(await put("/api/wheel", withLabel("Text me 555-123-4567")), "contains_phone", "prize phone", assert);
    await expectRefusal(await put("/api/wheel", withLabel("Selfie", { description: "DM @jane on the other app" })), "contains_handle", "description handle", assert);
    const long = await put("/api/wheel", withLabel("x".repeat(81)));
    assert(long.status() === 400, `an 81-character prize name is refused (${long.status()})`);
    const okLen = await put("/api/wheel", withLabel("x".repeat(80)));
    assert(okLen.ok(), `an 80-character prize name saves (${okLen.status()})`);
    const restored = await put("/api/wheel", { wheel });
    assert(restored.ok(), `the demo wheel is restored (${restored.status()})`);
  });

  await step("trust-b7 TS-03/TS-04: board names refuse FanFunnel, staff words and web addresses", async () => {
    const fan = await json(await post("/api/passes", { requestId: randomUUID(), name: `Board Fan ${tag}`, spins: 1 }), "create fan");
    await json(await acknowledgeFixtureFan(ctx.request, fan.token), "ack");
    for (const handle of ["FanFunnel", "fan_funnel", "Supp0rt", "admin_1", "Official.Team"]) {
      await expectRefusal(await post("/api/leaderboard/opt-in", { token: fan.token, optIn: true, handle }), "handle_reserved", `board name "${handle}"`, assert);
    }
    for (const handle of ["cash.app", "t.me", "jane.onlyfans.com"]) {
      await expectRefusal(await post("/api/leaderboard/opt-in", { token: fan.token, optIn: true, handle }), "handle_not_allowed", `board name "${handle}"`, assert);
    }
    const ok = await post("/api/leaderboard/opt-in", { token: fan.token, optIn: true, handle: `gamer_${tag}` });
    assert(ok.ok(), `an ordinary board name still works (${ok.status()})`);
    await goto(page, `/spin/${fan.token}`, 800);
    assert((await page.getByTestId("legal-change-notice").count()) === 0, "TS-06: no change notice while none is announced");
  });

  await step("trust-b7 TS-01/TS-07/TS-09/TS-12: the legal pages say what the code does", async () => {
    await goto(page, "/terms", 500);
    const terms = await page.locator("main").innerText();
    assert(/Last updated November 11, 2026/.test(terms), "TS-01: Terms carry the bumped date");
    assert(/answered by the creator or by the people they have authorised/.test(terms), "TS-07: Terms disclose team replies");
    assert(/may not present you as FanFunnel, its staff or another creator/.test(terms), "TS-03: Terms state the name rule");
    assert(/show a notice on the spin page and in the dashboard/.test(terms), "TS-06: the notice promise matches the mechanism");
    assert(!/\b(buy|paid|purchase|gamble|bet|lottery)\b/i.test(terms.replace("laws on lotteries, sweepstakes, contests and promotions", "")), "public-text rule on the Terms");
    await goto(page, "/privacy", 500);
    const privacy = await page.locator("main").innerText();
    assert(/Last updated November 11, 2026/.test(privacy), "TS-01: Privacy carries the bumped date");
    assert(/Browser push services \(Google, Apple, Mozilla\)/.test(privacy), "TS-09: push services are named as processors");
    assert(/ff-auth-redirect-at/.test(privacy), "TS-09: the sign-in redirect timer is in the storage list");
    assert(/National Center for Missing & Exploited Children/.test(privacy), "TS-12: child-safety handling is stated");
    assert((await page.locator("#report-abuse").count()) === 1, "the security.txt Policy anchor exists");
    assert(!/\b(buy|paid|purchase|gamble|bet|lottery)\b/i.test(privacy), "public-text rule on the Privacy Policy");
  });

  await step("trust-b7 WA-17: security.txt carries Canonical and Policy, and Policy resolves", async () => {
    const res = await ctx.request.get(BASE + "/.well-known/security.txt");
    assert(res.ok() && /^text\/plain/.test(res.headers()["content-type"] ?? ""), "security.txt is served as text");
    const text = await res.text();
    const canonical = /^Canonical: (https:\/\/\S+\/\.well-known\/security\.txt)$/m.exec(text);
    const policy = /^Policy: (https:\/\/\S+)$/m.exec(text);
    assert(canonical && policy, `Canonical and Policy fields present:\n${text}`);
    assert(/^Contact: mailto:/m.test(text) && /^Expires: /m.test(text), "Contact and Expires still present");
    const policyPath = new URL(policy[1]).pathname + new URL(policy[1]).hash;
    const page2 = await ctx.request.get(BASE + policyPath.replace(/#.*$/, ""));
    assert(page2.ok(), `the Policy page serves here too (${policyPath} → ${page2.status()})`);
  });
}
