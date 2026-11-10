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
// The flows that need a real mailbox or session (resend 429, the reset
// route's current-password and two-factor steps) are unit-tested next to the
// code and listed as TEST manual checks in docs/ACCOUNT_SECURITY.md.
import { BASE, goto } from "./harness.mjs";

const TOKEN = "e2e-token-hash-0123456789";
const titleOf = async (page) => page.title();

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
    const r = await request.post(`${BASE}/auth/confirm/verify`, { form: { token_hash: TOKEN, type: "recovery", next: "/reset-password" }, maxRedirects: 0 });
    assert(r.status() === 303, `POST answers 303 (${r.status()})`);
    assert(r.headers().location === `${BASE}/login`, `demo: no accounts, so sign-in (${r.headers().location})`);
    const g = await request.get(`${BASE}/auth/confirm/verify?token_hash=${TOKEN}&type=recovery`, { maxRedirects: 0 });
    assert([301, 302, 307, 308].includes(g.status()) && /\/auth\/confirm\?token_hash=/.test(g.headers().location ?? ""), "a GET on the verify route only shows the landing page");
    const cb = await request.get(`${BASE}/auth/callback?token_hash=${TOKEN}&type=invite`, { maxRedirects: 0 });
    assert([302, 307].includes(cb.status()) && cb.headers().location === `${BASE}/auth/confirm?token_hash=${TOKEN}&type=invite&next=%2Fset-password`, `callback forwards a token_hash unspent (${cb.status()} ${cb.headers().location})`);
    const bad = await request.get(`${BASE}/auth/confirm?token_hash=%3Cscript%3E&type=recovery`, { maxRedirects: 0 });
    assert([302, 303, 307, 308].includes(bad.status()) && /\/login\?error=auth_link&type=recovery&reason=malformed$/.test(bad.headers().location ?? ""), `a malformed link → the typed explanation (${bad.status()} ${bad.headers().location})`);
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
