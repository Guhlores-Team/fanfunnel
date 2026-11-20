/**
 * Runtime check of the e-mail link session rule (review A1) against the TEST
 * Supabase project. The unit tests use synthetic claims and an in-memory Auth
 * server; only the hosted Auth server can say which `amr` method a verified
 * e-mail link really gets, and the whole reset / invitation flow depends on
 * it (src/lib/auth/assurance.ts: openedByRecentLink).
 *
 * Run:  npx tsx scripts/security/link-session-runtime-test.mjs
 *       (plain `node` also works on Node ≥ 22.18, which strips the types of
 *        the imported src/lib/auth/assurance.ts)
 * Needs (from the environment, else .env.local):
 *   NEXT_PUBLIC_SUPABASE_URL
 *   NEXT_PUBLIC_SUPABASE_ANON_KEY   (what the app's verify route uses)
 *   SUPABASE_SERVICE_ROLE_KEY       (to create disposable users, generate
 *                                    links without sending mail, and clean up)
 * Optional:
 *   RLS_TEST_REQUIRE_REF            (refuse unless the URL is this project ref; CI sets it)
 *   LINK_SESSION_TEST_ENV_FILE=off  (do not read .env.local)
 *
 * For a recovery link, a magic link and an invitation it:
 *   1. admin-generates the link (`auth.admin.generateLink`, no e-mail is sent)
 *      and takes its hashed token, the value the templates put in
 *      /auth/confirm?token_hash=…;
 *   2. spends it the way POST /auth/confirm/verify does: verifyOtp({ type,
 *      token_hash }) with the anon key;
 *   3. decodes the session's `amr`, prints it, and asserts the method is one
 *      the app's rule accepts and that openedByRecentLink() (the app's own
 *      function, imported) says yes, and no after one hour;
 *   4. sets a password on that session (what the reset route does once the
 *      rule passes) and signs in with it;
 * and also: a password sign-in is NOT a link session (negative), a token
 * refresh does not extend the hour, a link is single-use and its second use
 * is refused as otp_expired.
 *
 * Safe to run repeatedly and concurrently against the shared TEST project:
 * every address carries a per-run id (linktest+<run>-…@fanfunnel.test), the
 * users are deleted in a `finally`, users left by a killed run (> 1 h old) are
 * swept first, and no table is written directly. It refuses to run against
 * the PRODUCTION project and against anything but the fixed TEST project.
 * Exits non-zero on any failed check or failed cleanup.
 */
import { readFileSync } from "node:fs";
import { isLegacyCanaryTestProject } from "./legacy-canary-counts.mjs";

// LINK_SESSION_TEST_ENV_FILE=off: use the environment only. The unit test of
// this file's refusals sets it, so it can never pick up a developer's real
// keys from .env.local and run against a hosted project.
if (process.env.LINK_SESSION_TEST_ENV_FILE !== "off") {
  try {
    for (const line of readFileSync(new URL("../../.env.local", import.meta.url), "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {}
}

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
if (!URL_ || !ANON || !SERVICE) {
  console.error("✗ Need NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

// This script creates and deletes users, so it must never touch production.
const PROD_REF = "ttlogfmogcccwiraaoae";
if (URL_.toLowerCase().includes(PROD_REF)) {
  console.error(`✗ Refusing to run: NEXT_PUBLIC_SUPABASE_URL points at the PRODUCTION project (${PROD_REF}). Use the TEST project.`);
  process.exit(1);
}
const REQUIRED_REF = process.env.RLS_TEST_REQUIRE_REF?.trim();
if (REQUIRED_REF) {
  let host = "";
  try { host = new URL(URL_).hostname.toLowerCase(); } catch {}
  if (host !== `${REQUIRED_REF.toLowerCase()}.supabase.co`) {
    console.error(`✗ Refusing to run: NEXT_PUBLIC_SUPABASE_URL is not the expected project (${REQUIRED_REF}).`);
    process.exit(1);
  }
}
// The same fixed TEST boundary as the RLS runtime test.
if (!isLegacyCanaryTestProject(URL_)) {
  console.error("✗ Refusing to run: the fixed FanFunnel TEST project is required.");
  process.exit(1);
}

// Loaded only after every refusal above: the checks import the app's rule
// from a .ts file, which needs tsx (or Node ≥ 22.18).
import("./link-session-checks.mjs")
  .then(({ runLinkSessionChecks }) => runLinkSessionChecks({ url: URL_, anonKey: ANON, serviceKey: SERVICE }))
  .then(({ failures, cleanupFailed, methods }) => {
    console.log("\nLINK_SESSION_AMR " + JSON.stringify(methods));
    if (failures > 0) {
      console.error(`\n✗ LINK SESSION RUNTIME TEST FAILED: ${failures} check(s). Password reset and invitations would not work with the current e-mail links. Do not ship.`);
      process.exit(1);
    }
    if (cleanupFailed) {
      console.error("\n✗ Checks passed, but cleanup failed: test users were left behind.");
      process.exit(1);
    }
    console.log("\n✓ Link session runtime test passed: a verified e-mail link opens a session the app's rule accepts.");
  })
  .catch((e) => {
    console.error("✗ Test error:", e?.message ?? e);
    process.exit(1);
  });
