// b7 auth journeys (demo mode: no Supabase, so these are the parts of the
// sign-in family that do not need an account):
//  WU-02/WA-05 an e-mail link GET renders a Continue page and spends nothing;
//              only the form's POST verifies; /auth/callback forwards a
//              token_hash to the landing page unspent.
//  WU-03       a failed link explains itself per type on /login, never "same
//              browser"; an expired invitation offers a new one; a used
//              confirmation says "sign in".
//  WU-04       the first e-mail change link lands on "step 1 of 2 done".
//  WU-01/WG-01 /login?suspended=1 explains; a suspended creator reaches the
//              dashboard and sees the banner instead of a login loop.
//  WC-08/WU-18 /signup opens sign-up mode (no fan-worded 404).
//  WU-13/WA-07 every auth page has its own title.
//  RS-10       POST /auth/signout refuses a cross-site form.
//  WU-14       /mfa in the demo (no accounts) goes to the dashboard.
// Review A1–A9 (second pass), the parts the demo can show:
//  A2  POST /auth/confirm/verify refuses a cross-site form, a foreign Origin
//      and a request with neither header (back to the Continue page, token
//      unspent, no cookie); the real Continue button passes in Chromium, and
//      a real cross-site auto-submitting form does not.
//  A3  the verify POST is rate-limited per client and a refusal says "still
//      good, try again"; the busy / blocked-account copy renders.
//  A5  the Continue button disables itself after the first tap (one POST),
//      and the plain form still works with JavaScript off.
//  A6  the dashboard shows why a failed e-mail change link changed nothing.
//  INFO /signup keeps a same-site next; a legacy ?error=…&error_code=
//      otp_expired gets the expired copy.
// What the demo CANNOT show (no Supabase, so no session exists here): the
// link-session rule on a real session (A1), the switched-account notice (A4),
// the proxy's redirect of a signed-in visitor (A6), the forgot-password and
// resend answers (A7, A8) and the reset limits (A9). Those run in unit tests
// with the real routes and clients against an in-memory Auth server
// (src/lib/auth/linkFlow.test.ts and the tests next to each file); what only
// the hosted TEST project can prove is asserted by
// scripts/security/link-session-runtime-test.mjs and listed as TEST manual
// checks in docs/ACCOUNT_SECURITY.md.
import { BASE, goto } from "./harness.mjs";

const TOKEN = "e2e-token-hash-0123456789";
const titleOf = async (page) => page.title();
// What a browser sends with the Continue page's own form POST.
const OWN_PAGE = { "sec-fetch-site": "same-origin", origin: BASE };
const LINK = { token_hash: TOKEN, type: "recovery", next: "/reset-password" };
const LANDING = `/auth/confirm?token_hash=${TOKEN}&type=recovery&next=%2Freset-password`;

export async function authB7Journey(browser, { step, assert }, sink, ctx) {
  const request = ctx.request;

  await step("b7 auth WU-02: GET /auth/confirm renders a Continue page and spends nothing", async () => {
    const r = await request.get(`${BASE}/auth/confirm?token_hash=${TOKEN}&type=recovery&next=/reset-password`, { maxRedirects: 0 });
    assert(r.status() === 200, `landing page answers 200 (${r.status()})`);
    assert(!r.headers()["set-cookie"], "no session cookie is written by the GET");
    const html = await r.text();
    assert(html.includes('action="/auth/confirm/verify"') && html.includes('method="post"'), "a form POSTs to the verify route");
    assert(html.includes(`name="token_hash" value="${TOKEN}"`) && html.includes('name="type" value="recovery"') && html.includes('name="next" value="/reset-password"'), "token, type and next travel as hidden fields");
    assert(/Continue to reset my password/.test(html), "the button says what it does");
    assert(!/requestSubmit\(|\.submit\(\)/.test(html), "nothing auto-submits the form");
    const page = await ctx.newPage();
    try {
      await goto(page, `/auth/confirm?token_hash=${TOKEN}&type=invite`, 600);
      assert((await titleOf(page)) === "Continue to FanFunnel", `landing title (${await titleOf(page)})`);
      const button = page.getByRole("button", { name: /Continue and set my password/ });
      await button.waitFor({ timeout: 5000 });
      const box = await button.boundingBox();
      assert(box && box.height >= 44, `the Continue button is a 44 px target (${box?.height})`);
    } finally {
      await page.close();
    }
  });

  await step("b7 auth WU-02: only the POST verifies; in the demo it lands on sign-in", async () => {
    const r = await request.post(`${BASE}/auth/confirm/verify`, { form: LINK, headers: OWN_PAGE, maxRedirects: 0 });
    assert(r.status() === 303, `POST answers 303 (${r.status()})`);
    assert(r.headers().location === `${BASE}/login`, `demo: no accounts, so sign-in (${r.headers().location})`);
    const g = await request.get(`${BASE}/auth/confirm/verify?token_hash=${TOKEN}&type=recovery`, { maxRedirects: 0 });
    assert([301, 302, 307, 308].includes(g.status()) && /\/auth\/confirm\?token_hash=/.test(g.headers().location ?? ""), "a GET on the verify route only shows the landing page");
    const cb = await request.get(`${BASE}/auth/callback?token_hash=${TOKEN}&type=invite`, { maxRedirects: 0 });
    assert([302, 307].includes(cb.status()) && cb.headers().location === `${BASE}/auth/confirm?token_hash=${TOKEN}&type=invite&next=%2Fset-password`, `callback forwards a token_hash unspent (${cb.status()} ${cb.headers().location})`);
    const bad = await request.get(`${BASE}/auth/confirm?token_hash=%3Cscript%3E&type=recovery`, { maxRedirects: 0 });
    assert([302, 303, 307, 308].includes(bad.status()) && /\/login\?error=auth_link&type=recovery&reason=malformed$/.test(bad.headers().location ?? ""), `a malformed link → the typed explanation (${bad.status()} ${bad.headers().location})`);
  });

  await step("b7 auth A2: only this site's own Continue page may spend a link (cross-site, foreign Origin, no headers → refused)", async () => {
    const back = `${BASE}${LANDING}&retry=origin`;
    for (const [label, headers] of [
      ["Sec-Fetch-Site: cross-site", { "sec-fetch-site": "cross-site", origin: "https://evil.example" }],
      ["Sec-Fetch-Site: cross-site with a spoofed matching Origin", { "sec-fetch-site": "cross-site", origin: BASE }],
      ["Sec-Fetch-Site: same-site (a sibling subdomain)", { "sec-fetch-site": "same-site" }],
      ["Sec-Fetch-Site: none", { "sec-fetch-site": "none" }],
      ["Origin: https://evil.example", { origin: "https://evil.example" }],
      ["Origin: null", { origin: "null" }],
      ["no Origin and no Sec-Fetch-Site", {}],
      ["a cross-site form with a session cookie", { "sec-fetch-site": "cross-site", cookie: "sb-x-auth-token=1" }],
    ]) {
      const r = await request.post(`${BASE}/auth/confirm/verify`, { form: LINK, headers, maxRedirects: 0 });
      assert(r.status() === 303 && r.headers().location === back, `${label} → back to the Continue page with the token unspent (${r.status()} ${r.headers().location})`);
      assert(!r.headers()["set-cookie"], `${label} → no cookie is set`);
    }
    for (const [label, headers] of [
      ["Chromium / Firefox / Safari 16.4+ (Sec-Fetch-Site: same-origin + Origin)", OWN_PAGE],
      ["Sec-Fetch-Site: same-origin alone", { "sec-fetch-site": "same-origin" }],
      ["older Safari / Firefox (Origin only, ours)", { origin: BASE }],
    ]) {
      const r = await request.post(`${BASE}/auth/confirm/verify`, { form: LINK, headers, maxRedirects: 0 });
      assert(r.status() === 303 && r.headers().location === `${BASE}/login`, `${label} → accepted (demo: sign-in) (${r.status()} ${r.headers().location})`);
    }
    const page = await ctx.newPage();
    try {
      await goto(page, `${LANDING}&retry=origin`, 600);
      const notice = page.getByTestId("auth-continue-notice");
      await notice.waitFor({ timeout: 5000 });
      assert(/only accept this step from this page/i.test(await notice.innerText()) && /Nothing was used up/.test(await notice.innerText()), "the Continue page says why it is shown again, in fixed words");
      assert((await page.getByTestId("auth-continue-button").count()) === 1, "…with the button still there to press");
    } finally {
      await page.close();
    }
  });

  await step("b7 auth A2/A5: the real Continue button passes in Chromium and submits once; a real cross-site form is refused", async () => {
    const page = await ctx.newPage();
    try {
      // Hold the POST for a moment. The page itself reports the button's state as soon as the first tap
      // disables it, then taps again and submits again, all while the first POST is held (a page in the
      // middle of a form navigation cannot be read from outside reliably, so it reports through a binding).
      let posts = 0;
      const sent = [];
      let inFlight = null;
      await page.route("**/auth/confirm/verify", async (route) => {
        if (route.request().method() === "POST") {
          posts++;
          sent.push(route.request().headers());
          await new Promise((r) => setTimeout(r, 900));
        }
        await route.continue();
      });
      await page.exposeFunction("__authContinueReport", (state) => { inFlight = inFlight ?? state; });
      await goto(page, LANDING, 400);
      await page.waitForFunction(() => document.querySelector('[data-testid="auth-continue"]')?.dataset.enhanced === "1", null, { timeout: 8000 });
      await page.evaluate(() => {
        const b = document.querySelector('[data-testid="auth-continue-button"]');
        const form = document.querySelector('[data-testid="auth-continue"]');
        const obs = new MutationObserver(() => {
          if (!b.disabled) return;
          obs.disconnect();
          setTimeout(() => {
            b.click();
            const swallowed = !form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
            window.__authContinueReport({ disabled: b.disabled, text: b.innerText, busy: b.getAttribute("aria-busy"), swallowed });
          }, 50);
        });
        obs.observe(b, { attributes: true, childList: true, subtree: true, characterData: true });
      });
      await page.getByTestId("auth-continue-button").click({ noWaitAfter: true });
      await page.waitForURL(`${BASE}/login`, { timeout: 10000 });
      assert(inFlight && !inFlight.error, `the page could be read while the first POST was on its way (${JSON.stringify(inFlight)})`);
      assert(inFlight.disabled, "the button is disabled after the first tap");
      assert(/Checking your link/.test(inFlight.text), `the button shows progress after the first tap (${inFlight.text})`);
      assert(inFlight.busy === "true", "…and is marked busy");
      assert(inFlight.swallowed, "a second submit while the first is on its way is swallowed");
      assert(posts === 1, `exactly one POST left the page (${posts})`);
      assert(sent[0]?.origin === BASE, `Chromium sent Origin: ${sent[0]?.origin} with the form POST`);
      await page.unroute("**/auth/confirm/verify");

      // A real cross-site page that auto-submits a form with a token to our verify route.
      await page.route("http://evil.example/**", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: `<!doctype html><form id="f" method="post" action="${BASE}/auth/confirm/verify"><input name="token_hash" value="${TOKEN}"><input name="type" value="recovery"><input name="next" value="/reset-password"></form><script>document.getElementById("f").submit()</script>`,
        })
      );
      await page.goto("http://evil.example/attack", { waitUntil: "domcontentloaded" });
      await page.waitForURL(/\/auth\/confirm\?.*retry=origin/, { timeout: 10000 });
      assert(new URL(page.url()).pathname === "/auth/confirm", `the cross-site POST ended on the Continue page, not signed in (${page.url()})`);
      await page.getByTestId("auth-continue-notice").waitFor({ timeout: 5000 });
      const cookies = await ctx.cookies(BASE);
      assert(!cookies.some((c) => /^sb-.*-auth-token/.test(c.name)), "no session cookie was set by the cross-site form");
    } finally {
      await page.close();
    }
  });

  await step("b7 auth A5: with JavaScript off the Continue form is a plain form and still works", async () => {
    const noJs = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
    try {
      const page = await noJs.newPage();
      await page.goto(BASE + LANDING, { waitUntil: "domcontentloaded" });
      const button = page.getByTestId("auth-continue-button");
      await button.waitFor({ timeout: 5000 });
      assert(/Continue to reset my password/.test(await button.innerText()) && !(await button.isDisabled()), "the button is there and enabled without scripts");
      await button.click();
      await page.waitForURL(`${BASE}/login`, { timeout: 10000 });
    } finally {
      await noJs.close();
    }
  });

  await step("b7 auth A3: the verify POST is rate-limited per client; a refusal and a busy provider say 'still good', a blocked account has its own words", async () => {
    // Its own client address, so the journey's other POSTs never share the budget.
    const ip = `198.51.100.${1 + Math.floor(Math.random() * 250)}`;
    let limitedAt = 0;
    let last = null;
    for (let i = 1; i <= 40 && !limitedAt; i++) {
      last = await request.post(`${BASE}/auth/confirm/verify`, { form: LINK, headers: { ...OWN_PAGE, "x-real-ip": ip }, maxRedirects: 0 });
      if (last.headers().location !== `${BASE}/login`) limitedAt = i;
    }
    assert(limitedAt === 31, `the 31st POST in a minute from one client is refused (refused at ${limitedAt})`);
    assert(last.status() === 303 && last.headers().location === `${BASE}${LANDING}&retry=busy`, `…back to the Continue page with the token unspent (${last.headers().location})`);
    const other = await request.post(`${BASE}/auth/confirm/verify`, { form: LINK, headers: { ...OWN_PAGE, "x-real-ip": "198.51.100.254" }, maxRedirects: 0 });
    assert(other.headers().location === `${BASE}/login`, "another client is unaffected");
    const page = await ctx.newPage();
    try {
      await goto(page, `${LANDING}&retry=busy`, 600);
      const busy = await page.getByTestId("auth-continue-notice").innerText();
      assert(/still good/.test(busy) && /few minutes/.test(busy) && !/already used|expired/i.test(busy), `the Continue page says the link is still good (${busy})`);
      await goto(page, "/login?error=auth_link&type=recovery&reason=busy", 600);
      const notice = await page.getByTestId("auth-link-error").innerText();
      assert(/still good/.test(notice) && !/already used|has expired/i.test(notice), "the sign-in page words a busy failure the same way");
      await goto(page, "/login?error=auth_link&type=invite&reason=banned", 600);
      const banned = page.getByTestId("auth-link-error");
      assert(/can't sign in right now/i.test(await banned.innerText()) && /blocked/.test(await banned.innerText()) && !/already used|has expired/i.test(await banned.innerText()), "a blocked account is told so, not sent for a new link");
      assert((await banned.getByRole("link", { name: /Write to support@/ }).count()) === 1 && (await banned.getByRole("link", { name: /reset link/i }).count()) === 0, "…with the support address and no new-link offer");
    } finally {
      await page.close();
    }
  });

  await step("b7 auth A6: the dashboard says why a failed e-mail change link changed nothing", async () => {
    const page = await ctx.newPage();
    try {
      await goto(page, "/dashboard?auth_link=expired&type=email_change", 1200);
      const notice = page.getByTestId("signed-in-link-notice");
      await notice.waitFor({ timeout: 8000 });
      const text = await notice.innerText();
      assert(/e-mail change link was already used or has expired/i.test(text) && /Nothing was changed/.test(text) && /Settings › Account/.test(text), `the notice explains and points at Settings (${text})`);
      assert(!/sign in below/i.test(text), "…without telling a signed-in visitor to sign in");
      await notice.getByRole("link", { name: "Dismiss" }).click();
      await page.waitForURL(`${BASE}/dashboard`, { timeout: 8000 });
      await page.waitForTimeout(600);
      assert((await page.getByTestId("signed-in-link-notice").count()) === 0, "Dismiss opens the dashboard without the notice");
      await goto(page, "/dashboard?auth_link=busy&type=recovery", 1000);
      assert(/still good/.test(await page.getByTestId("signed-in-link-notice").innerText()), "a failure that decided nothing says the link is still good");
      await goto(page, "/dashboard?auth_link=%3Cscript%3Ealert(1)%3C/script%3E&type=%3Cb%3E", 1000);
      assert((await page.getByTestId("signed-in-link-notice").count()) === 0 && !(await page.content()).includes("<script>alert(1)"), "unknown flag values show nothing and are never echoed");
      await goto(page, "/dashboard?switched=1", 1000);
      assert((await page.getByTestId("account-switched").count()) === 0, "the switched-account sentence needs a session's e-mail; the demo has none, so the flag alone shows nothing");
    } finally {
      await page.close();
    }
  });

  await step("b7 auth WU-03: a failed link explains itself per type, never 'same browser'", async () => {
    const page = await ctx.newPage();
    try {
      await goto(page, "/login?error=auth_link&type=invite&reason=expired", 600);
      const notice = page.getByTestId("auth-link-error");
      await notice.waitFor({ timeout: 5000 });
      const text = await notice.innerText();
      assert(/invitation has expired/i.test(text), "an expired invitation is named");
      assert(await notice.getByRole("link", { name: "Ask for a new invitation" }).count() === 1, "…with a way to ask for a new one");
      assert(!/same browser|same device/i.test(await page.locator("body").innerText()), "no 'same browser' wording");

      await goto(page, "/login?error=auth_link&type=signup&reason=expired", 600);
      const used = await page.getByTestId("auth-link-error").innerText();
      assert(/already used or has expired/.test(used) && /sign in below/i.test(used), "a used confirmation says: already confirmed? sign in");

      await goto(page, "/login?error=auth_link&type=recovery&reason=malformed", 600);
      assert(/incomplete/i.test(await page.getByTestId("auth-link-error").innerText()), "a cut link is explained");
    } finally {
      await page.close();
    }
  });

  await step("b7 auth WU-04: the first e-mail change link is 'step 1 of 2', not the dashboard", async () => {
    const r = await request.get(`${BASE}/auth/callback?message=Confirmation+link+accepted&next=/dashboard`, { maxRedirects: 0 });
    assert([302, 307].includes(r.status()) && r.headers().location === `${BASE}/auth/email-change`, `legacy message → the half-done page (${r.headers().location})`);
    const page = await ctx.newPage();
    try {
      await goto(page, "/auth/email-change", 600);
      await page.getByTestId("email-change-half").waitFor({ timeout: 5000 });
      assert(/Step 1 of 2 done/i.test(await page.getByTestId("email-change-half").innerText()), "says step 1 of 2 and to open the other link");
      assert((await titleOf(page)) === "One more step · FanFunnel", "has its own title");
    } finally {
      await page.close();
    }
  });

  await step("b7 auth WU-01: /login?suspended=1 explains, and a suspended creator keeps the dashboard with the banner", async () => {
    const page = await ctx.newPage();
    try {
      await goto(page, "/login?suspended=1", 600);
      const notice = page.getByTestId("login-suspended");
      await notice.waitFor({ timeout: 5000 });
      assert(/suspended/i.test(await notice.innerText()) && (await notice.getByRole("link", { name: /support@/ }).count()) === 1, "the notice names the support address");
      const set = await request.post(`${BASE}/api/debug/creator-status`, { data: { active: false } });
      assert(set.ok(), `demo creator suspended (${set.status()}; needs NEXT_PUBLIC_ENABLE_DEBUG=1)`);
      try {
        await goto(page, "/dashboard", 1200);
        assert(new URL(page.url()).pathname === "/dashboard", `stays on the dashboard, no login loop (${page.url()})`);
        const banner = page.getByTestId("suspended-banner");
        await banner.waitFor({ timeout: 8000 });
        assert(/suspended/i.test(await banner.innerText()) && /support@/.test(await banner.innerText()), "the banner explains with the support address");
      } finally {
        await request.post(`${BASE}/api/debug/creator-status`, { data: { active: true } });
      }
    } finally {
      await page.close();
    }
  });

  await step("b7 auth WC-08: /signup opens sign-up mode, and every auth page has its own title", async () => {
    const r = await request.get(`${BASE}/signup`, { maxRedirects: 0 });
    assert([302, 307].includes(r.status()) && /\/login\?mode=signup$/.test(r.headers().location ?? ""), `/signup → /login?mode=signup (${r.status()} ${r.headers().location})`);
    const keep = await request.get(`${BASE}/signup?next=/pending`, { maxRedirects: 0 });
    assert(keep.headers().location === `${BASE}/login?mode=signup&next=%2Fpending`, `/signup keeps a same-site next (${keep.headers().location})`);
    const drop = await request.get(`${BASE}/signup?next=https://evil.example/x`, { maxRedirects: 0 });
    assert(drop.headers().location === `${BASE}/login?mode=signup`, `…and drops an off-site one (${drop.headers().location})`);
    const legacy = await request.get(`${BASE}/auth/callback?error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired&type=recovery`, { maxRedirects: 0 });
    assert(legacy.headers().location === `${BASE}/login?error=auth_link&type=recovery&reason=expired`, `a legacy error redirect gets the expired copy, not "incomplete" (${legacy.headers().location})`);
    const page = await ctx.newPage();
    try {
      for (const [path, title] of [
        ["/login", "Sign in · FanFunnel"],
        ["/login?mode=signup", "Create your login · FanFunnel"],
        ["/forgot-password", "Reset your password · FanFunnel"],
        ["/reset-password", "Choose a new password · FanFunnel"],
        ["/set-password", "Set your password · FanFunnel"],
      ]) {
        await goto(page, path, 500);
        assert((await titleOf(page)) === title, `${path} title is "${title}" (saw "${await titleOf(page)}")`);
      }
      await goto(page, "/mfa", 800);
      assert(new URL(page.url()).pathname === "/dashboard", `demo /mfa → dashboard (${page.url()})`);
    } finally {
      await page.close();
    }
  });

  await step("b7 auth RS-10: POST /auth/signout refuses a cross-site form", async () => {
    const evil = await request.post(`${BASE}/auth/signout`, { headers: { origin: "https://evil.example", cookie: "sb-x-auth-token=1" }, maxRedirects: 0 });
    assert(evil.status() === 403, `cross-site → 403 (${evil.status()})`);
    const same = await request.post(`${BASE}/auth/signout`, { headers: { "sec-fetch-site": "same-origin", cookie: "sb-x-auth-token=1" }, maxRedirects: 0 });
    assert(same.status() === 303 && same.headers().location === `${BASE}/login`, `same-origin → 303 /login (${same.status()})`);
  });

  await step("b7 auth: the demo's new-password and forgot pages say there are no accounts", async () => {
    for (const path of ["/reset-password", "/forgot-password"]) {
      const r = await request.get(`${BASE}${path}`);
      assert(r.status() === 200 && /isn.t available here|Reset your password/.test(await r.text()), `${path} renders`);
    }
  });
}
