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
// TS-06: no change notice shows while none is announced; an admin announces
//        one (Admin › Terms change notice) and the fan page, the public page
//        and the dashboard show it until it is withdrawn; a date under 30 days,
//        an older version or a past date is refused.
// TS-05: the Privacy Policy lists the hashed consent evidence.
// TS-07/09/12: Terms name team replies and the name rule; Privacy names the
//        push services, the redirect timer key and the child-safety handling.
// WA-17: security.txt carries Canonical and Policy, and the Policy URL resolves.

import { acknowledgeFixtureFan, goto, passAgeGate, BASE } from "./harness.mjs";

const NOTICE = { version: "2099-01-31", effectiveDate: "2099-01-31" };
const NOTICE_TEXT = /Our Terms and Privacy Policy change on January 31, 2099\./;
const setNotice = (request, data = NOTICE) => request.post(BASE + "/api/admin/legal-notice", { data });
const clearNotice = (request) => request.post(BASE + "/api/admin/legal-notice", { data: { clear: true } });

/** a11y states with the announced-change notice showing (and the admin card). Each clears the notice after its scan. */
export function trustB7A11yStates(dashAdvisory = []) {
  const announce = (ready = async () => {}) => async (page) => {
    const res = await setNotice(page.request);
    if (!res.ok()) throw new Error(`announce failed (${res.status()})`);
    await page.reload();
    await ready(page);
    await page.getByTestId("legal-change-notice").first().waitFor({ timeout: 8000 });
  };
  const cleanup = async (page) => {
    await clearNotice(page.request);
  };
  return [
    { path: "/c/demo", name: "trust-b7 terms change notice (link-in-bio)", prep: announce(), cleanup },
    { path: "/spin/demo", name: "trust-b7 terms change notice (fan page)", prep: announce(passAgeGate), cleanup },
    { path: "/dashboard", name: "trust-b7 terms change notice (dashboard)", prep: announce(), cleanup, advisory: dashAdvisory },
    {
      path: "/admin",
      name: "trust-b7 admin Terms change notice card",
      prep: async (page) => {
        const card = page.getByRole("region", { name: "Terms change notice", exact: true });
        await card.getByText("No change is announced.", { exact: true }).waitFor({ timeout: 8000 });
        await card.scrollIntoViewIfNeeded();
      },
      advisory: dashAdvisory,
    },
  ];
}

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
    assert(/evidence of that confirmation: one-way scrambled \(hashed\) forms of the IP address/.test(privacy), "TS-05: the consent evidence is listed");
    assert((await page.locator("#report-abuse").count()) === 1, "the security.txt Policy anchor exists");
    assert(!/\b(buy|paid|purchase|gamble|bet|lottery)\b/i.test(privacy), "public-text rule on the Privacy Policy");
  });

  await step("trust-b7 TS-06: an admin announces a Terms change; fan pages and the dashboard show it until it is withdrawn", async () => {
    const fan = await json(await post("/api/passes", { requestId: randomUUID(), name: `Notice Fan ${tag}`, spins: 1 }), "create fan");
    await json(await acknowledgeFixtureFan(ctx.request, fan.token), "ack");
    // Refusals first: nothing is stored by any of them.
    const soon = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
    await expectRefusal(await setNotice(ctx.request, { version: "2099-01-31", effectiveDate: soon }), "too_soon", "10 days' notice", assert);
    await expectRefusal(await setNotice(ctx.request, { version: "2020-01-01", effectiveDate: "2099-01-31" }), "version_not_later", "an older version", assert);
    await expectRefusal(await setNotice(ctx.request, { version: "2099-01-31", effectiveDate: "2020-01-01", sooner: true }), "date_in_past", "a past date", assert);
    await expectRefusal(await setNotice(ctx.request, { version: "soon", effectiveDate: "2099-01-31" }), "invalid_version", "a non-date version", assert);
    const none = await json(await ctx.request.get(BASE + "/api/legal-notice"), "public notice");
    assert(none.notice === null, `refused announcements store nothing (${JSON.stringify(none)})`);
    // Fresh contexts: the fan has no creator session, and nothing is cached.
    const fanCtx = await ctx.browser().newContext({ viewport: { width: 390, height: 844 } });
    const dashCtx = await ctx.browser().newContext({ viewport: { width: 1280, height: 900 } });
    try {
      const announced = await json(await setNotice(ctx.request), "announce");
      assert(announced.notice?.version === NOTICE.version && announced.notice?.effectiveDate === NOTICE.effectiveDate, "the notice is stored");
      assert(["not_configured", "none"].includes(announced.mail?.status), `the demo never e-mails and says so (${JSON.stringify(announced.mail)})`);
      const pub = await json(await ctx.request.get(BASE + "/api/legal-notice"), "public notice");
      assert(pub.notice?.effectiveDate === NOTICE.effectiveDate && Object.keys(pub.notice).every((k) => ["version", "effectiveDate", "summary"].includes(k)), "the public read carries only the version and the date");
      const fanPage = await fanCtx.newPage();
      await goto(fanPage, `/spin/${fan.token}`, 800);
      const fanNotice = fanPage.getByTestId("legal-change-notice").first();
      await fanNotice.waitFor({ timeout: 8000 });
      assert(NOTICE_TEXT.test(await fanNotice.innerText()), "the fan page footer shows the date");
      assert((await fanNotice.getByRole("link", { name: "/terms" }).getAttribute("href")) === "/terms", "…and links the current text");
      await goto(fanPage, "/c/demo", 600);
      await fanPage.getByTestId("legal-change-notice").first().waitFor({ timeout: 8000 });
      const dash = await dashCtx.newPage();
      await goto(dash, "/dashboard", 1200);
      const dashNotice = dash.getByTestId("legal-change-notice").first();
      await dashNotice.waitFor({ timeout: 8000 });
      assert(NOTICE_TEXT.test(await dashNotice.innerText()), "the dashboard shows the date");
      // The admin card reads it back and withdraws it.
      await goto(dash, "/admin", 1200);
      const card = dash.getByRole("region", { name: "Terms change notice", exact: true });
      await card.getByText("Announced: version 2099-01-31 takes effect on January 31, 2099.", { exact: true }).waitFor({ timeout: 8000 });
      await card.getByRole("button", { name: "Withdraw" }).click();
      await card.getByText("No change is announced.", { exact: true }).waitFor({ timeout: 8000 });
      assert(/withdrawn/.test(await card.getByTestId("admin-legal-notice-status").innerText()), "the card confirms the withdrawal");
      const after = await json(await ctx.request.get(BASE + "/api/legal-notice"), "public notice");
      assert(after.notice === null, "the public read is empty again");
      await goto(fanPage, `/spin/${fan.token}`, 800);
      assert((await fanPage.getByTestId("legal-change-notice").count()) === 0, "the fan page no longer shows it");
      // Announce through the form, too (the path an admin uses).
      await card.getByLabel("New version (YYYY-MM-DD)").fill(NOTICE.version);
      await card.getByLabel("Takes effect on (YYYY-MM-DD)").fill(soon);
      await card.getByRole("button", { name: "Announce" }).click();
      await card.getByText(/needs at least 30 days' notice/).waitFor({ timeout: 8000 });
      await card.getByLabel("Takes effect on (YYYY-MM-DD)").fill(NOTICE.effectiveDate);
      await card.getByRole("button", { name: "Announce" }).click();
      await card.getByText("Announced: version 2099-01-31 takes effect on January 31, 2099.", { exact: true }).waitFor({ timeout: 8000 });
      assert(/creators were NOT e-mailed|no active creators/.test(await card.getByTestId("admin-legal-notice-status").innerText()), "the card says honestly whether creators were e-mailed");
      const audit = await json(await ctx.request.get(BASE + "/api/admin/audit"), "audit");
      assert(JSON.stringify(audit).includes("legal.notice"), "the announcement is in Activity");
    } finally {
      await clearNotice(ctx.request);
      await fanCtx.close();
      await dashCtx.close();
    }
    const cleared = await json(await ctx.request.get(BASE + "/api/legal-notice"), "public notice");
    assert(cleared.notice === null, "no notice is left behind for later journeys");
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
