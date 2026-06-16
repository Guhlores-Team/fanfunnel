// Login-UI E2E (real Supabase) — closes the auth/session/cookie gap the
// headless DB tests don't touch. Drives the REAL /login page in a browser:
// creates a confirmed + approved creator via the admin API, signs in through
// the form, and asserts the session lands them on a working dashboard. Then
// deletes the user.
//
// Requires the app running at E2E_BASE_URL with the SAME Supabase env the
// browser was built against (the CI workflow handles build + start). Skips
// cleanly when secrets are absent.

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
async function cleanup() {
  if (browser) await browser.close().catch(() => {});
  if (userId) {
    try {
      await admin.auth.admin.deleteUser(userId);
    } catch {
      /* best effort */
    }
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
  page.on("pageerror", (e) => jsErrors.push(String(e)));

  await step("sign in through the real /login form", async () => {
    await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(1000);
    const emailInput = page.locator("input[aria-label='Email address']");
    assert(await emailInput.count(), "real login form is shown (Supabase configured)");
    await emailInput.fill(email);
    await page.locator("input[aria-label='Password']").fill(password);
    await page.locator("button[type='submit']:has-text('Sign in')").first().click();
  });

  await step("session lands on a working dashboard", async () => {
    await page.waitForURL(/\/dashboard(\?|$)/, { timeout: 20000 });
    await page.waitForTimeout(1500);
    const body = await page.locator("body").innerText();
    assert(/creator dashboard|today|wheel|fans/i.test(body), "dashboard rendered for the signed-in creator");
    // Not bounced to the approval-gate page.
    assert(!/\/pending$/.test(new globalThis.URL(page.url()).pathname), "not redirected to /pending");
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
  await cleanup();
  process.exit(exitCode);
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
async function profileExists() {
  const { data } = await admin.from("profiles").select("id").eq("id", userId).maybeSingle();
  return !!data;
}
