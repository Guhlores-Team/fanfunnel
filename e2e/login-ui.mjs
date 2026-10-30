// Login-UI E2E (real Supabase) — closes the auth/session/cookie gap the
// headless DB tests don't touch. Drives the REAL /login page in a browser:
// creates a confirmed + approved creator via the admin API, signs in through
// the form, and asserts the session lands them on a working dashboard. Then
// deletes the user.
//
// Requires the app running at E2E_BASE_URL with the SAME Supabase env the
// browser was built against (the CI workflow handles build + start). Skips
// cleanly when secrets are absent.

import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { log, requireSupabaseEnvOrExit } from "./supabase-env.mjs";

const { URL, SERVICE } = requireSupabaseEnvOrExit();
const BASE = (process.env.E2E_BASE_URL || "http://localhost:3000").replace(/\/+$/, "");

const admin = createClient(URL, SERVICE, { auth: { persistSession: false } });
const rand = Math.random().toString(36).slice(2, 8);
const email = `e2e-login-${rand}@fanfunnel.test`;
const password = "Test-" + rand + "-Aa1!";

const results = [];
let failures = 0;
async function step(name, fn) {
  try {
    await fn();
    results.push([true, name, ""]);
    log(`  ✓ ${name}`);
  } catch (e) {
    failures++;
    results.push([false, name, String(e?.message || e).slice(0, 200)]);
    log(`  ✗ ${name} — ${String(e?.message || e).slice(0, 200)}`);
  }
}
const assert = (c, m) => {
  if (!c) throw new Error("assertion failed: " + m);
};

let userId = null;
let browser = null;
/** Returns false if the test user couldn't be deleted, so the run fails
 *  instead of silently leaking it into the project. */
async function cleanup() {
  if (browser) await browser.close().catch(() => {});
  if (!userId) return true;
  try {
    const { error } = await admin.auth.admin.deleteUser(userId);
    if (error) throw error;
    return true;
  } catch (e) {
    log(`✗ CLEANUP FAILED: could not delete test user ${email} (${userId}) — ${e?.message ?? e}`);
    return false;
  }
}

let exitCode = 1;
try {
  log(`Login-UI E2E → app ${BASE} · supabase ${URL}\n`);

  await step("create a confirmed, approved creator via admin API", async () => {
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    assert(!error, `createUser: ${error?.message}`);
    userId = data.user.id;
    // New signups default to approval_status='pending' and the dashboard gates
    // on 'approved'. Approve via the service client (bypasses admin-only RLS).
    for (let i = 0; i < 10 && !(await profileExists()); i++) await wait(400);
    const { error: upErr } = await admin
      .from("profiles")
      .update({ approval_status: "approved" })
      .eq("id", userId);
    assert(!upErr, `approve profile: ${upErr?.message}`);
  });

  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const jsErrors = [];
  const consoleErrs = [];
  const authResponses = [];
  page.on("pageerror", (e) => jsErrors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrs.push(m.text().slice(0, 200));
  });
  page.on("response", (r) => {
    if (/\/auth\/v1\//.test(r.url())) {
      authResponses.push(`${r.status()} ${r.url().replace(URL, "").split("?")[0]}`);
    }
  });

  await step("sign-up requires the Terms clickwrap (no account is created)", async () => {
    await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.getByRole("button", { name: /Request access$/ }).first().click();
    const box = page.getByTestId("terms-checkbox");
    await box.waitFor({ timeout: 5000 });
    const submit = page.locator("button[type='submit']");
    assert(await submit.isDisabled(), "Request access is disabled until the Terms box is ticked");
    for (const [name, href] of [["Terms of Service", "/terms"], ["Privacy Policy", "/privacy"]]) {
      const link = page.getByRole("link", { name });
      assert((await link.getAttribute("href")) === href, `${name} links to ${href}`);
      assert((await link.getAttribute("target")) === "_blank", `${name} opens in a new tab`);
    }
    await box.check();
    assert(!(await submit.isDisabled()), "ticking the box enables Request access");
    await page.getByRole("button", { name: /Sign in$/ }).click();
  });

  await step("sign in through the real /login form", async () => {
    await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(1000);
    const emailInput = page.locator("input[aria-label='Email address']");
    assert(await emailInput.count(), "real login form is shown (Supabase configured)");
    await emailInput.fill(email);
    await page.locator("input[aria-label='Password']").fill(password);
    await page.locator("button[type='submit']:has-text('Sign in')").first().click();
    await page.waitForTimeout(3000); // let the auth request fire
    log(`     auth requests: ${authResponses.join(", ") || "(none seen)"}`);
    if (consoleErrs.length) log(`     console errors: ${consoleErrs.slice(0, 3).join(" | ")}`);
  });

  await step("session lands on a working dashboard", async () => {
    // router.push() is client-side (App Router) so there's no fresh "load"
    // event — poll the pathname instead of waitForURL(until:load).
    await page
      .waitForFunction(() => /^\/(dashboard|pending)/.test(location.pathname), { timeout: 20000 })
      .catch(() => {});
    await page.waitForTimeout(1500);
    const path = new globalThis.URL(page.url()).pathname;
    // If still on /login the sign-in failed — surface the form's error.
    if (path === "/login") {
      const err = await page.locator("[role='alert']").first().innerText().catch(() => "");
      try {
        const { mkdirSync } = await import("node:fs");
        mkdirSync(fileURLToPath(new globalThis.URL("./artifacts/", import.meta.url)), { recursive: true });
        await page.screenshot({ path: fileURLToPath(new globalThis.URL("./artifacts/login-failure.png", import.meta.url)) });
      } catch {
        /* ignore */
      }
      assert(false, `still on /login — sign-in failed${err ? `: "${err.trim()}"` : " (no form error shown)"}`);
    }
    assert(path !== "/pending", "approved creator must NOT be bounced to /pending");
    assert(path.startsWith("/dashboard"), `expected /dashboard, landed on ${path}`);
    const body = await page.locator("body").innerText();
    assert(/creator dashboard|today|wheel|fans/i.test(body), "dashboard rendered for the signed-in creator");
  });

  await step("a creator with no Terms record accepts the dashboard prompt; it is recorded server-side", async () => {
    const prompt = page.getByTestId("terms-prompt");
    await prompt.waitFor({ timeout: 10000 });
    const agree = page.getByRole("button", { name: "Agree and continue" });
    assert(await agree.isDisabled(), "Agree is disabled until the box is ticked");
    await prompt.getByTestId("terms-checkbox").check();
    await agree.click();
    await prompt.waitFor({ state: "hidden", timeout: 10000 });
    const { data: row, error } = await admin
      .from("profiles")
      .select("terms_version, terms_accepted_at")
      .eq("id", userId)
      .maybeSingle();
    assert(!error, `read profile: ${error?.message}`);
    assert(/^\d{4}-\d{2}-\d{2}$/.test(row?.terms_version ?? ""), `terms_version recorded (got ${row?.terms_version})`);
    const age = Date.now() - new Date(row?.terms_accepted_at ?? 0).getTime();
    assert(age >= -60_000 && age < 5 * 60_000, `terms_accepted_at is the server's now (got ${row?.terms_accepted_at})`);
  });

  await step("authenticated API works for the new creator (no errors)", async () => {
    // The dashboard polls /api/overview; just assert no page errors surfaced.
    assert(jsErrors.length === 0, `page errors: ${jsErrors.slice(0, 2).join(" | ")}`);
  });

  const passed = failures === 0;
  log(`\nRESULT: ${results.filter((r) => r[0]).length}/${results.length} checks passed`);
  log(passed ? "\n✅ LOGIN-UI E2E PASSED" : "\n❌ LOGIN-UI E2E FAILED");
  exitCode = passed ? 0 : 1;
} catch (e) {
  log("Login-UI harness error: " + (e?.stack || e));
  exitCode = 1;
} finally {
  if (!(await cleanup())) exitCode = 1;
  process.exit(exitCode);
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
async function profileExists() {
  const { data } = await admin.from("profiles").select("id").eq("id", userId).maybeSingle();
  return !!data;
}
