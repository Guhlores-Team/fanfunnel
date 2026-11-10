// The checks of scripts/security/link-session-runtime-test.mjs, without the
// environment handling, so they can also be dry-run against the in-memory
// Auth server (src/lib/auth/linkSessionChecks.test.ts). See that script's
// header for what is asserted and why.
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { amrFromAccessToken, LINK_SESSION_MAX_AGE_MS, LINK_SESSION_METHODS, openedByRecentLink } from "../../src/lib/auth/assurance.ts";

export const LINK_TEST_EMAIL = /^linktest\+[^@]*@fanfunnel\.test$/i;
const STALE_MS = 60 * 60 * 1000;

/**
 * @param {{ url: string, anonKey: string, serviceKey: string, log?: (line: string) => void }} env
 * @returns {Promise<{ failures: number, cleanupFailed: boolean, methods: Record<string, string[]> }>}
 */
export async function runLinkSessionChecks({ url, anonKey, serviceKey, log = console.log }) {
  const noStore = { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } };
  const admin = createClient(url, serviceKey, noStore);
  const fresh = () => createClient(url, anonKey, noStore);
  const RUN = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const createdUserIds = [];
  /** @type {Record<string, string[]>} */
  const methods = {};
  let failures = 0;
  let cleanupFailed = false;
  const check = (cond, msg) => {
    if (cond) log(`  ✓ ${msg}`);
    else { failures++; log(`  ✗ FAIL: ${msg}`); }
  };
  const password = (tag) => `Lt-${tag}-${randomUUID().slice(0, 12)}-9a`;

  // Users left behind by a run that was killed before its `finally`. Only this
  // script's address pattern and only old ones, so a concurrent run is safe.
  async function sweepStaleUsers() {
    const cutoff = Date.now() - STALE_MS;
    for (let page = 1; ; page++) {
      const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
      if (error) { log(`  ⚠ Skipping the stale-user sweep: ${error.message}`); return; }
      const users = data?.users ?? [];
      for (const u of users) {
        if (u.email && LINK_TEST_EMAIL.test(u.email) && Date.parse(u.created_at) < cutoff) {
          const { error: delError } = await admin.auth.admin.deleteUser(u.id);
          log(delError ? `  ⚠ Could not sweep stale user ${u.id}: ${delError.message}` : `  swept stale user ${u.id}`);
        }
      }
      if (users.length < 1000) break;
    }
  }

  /** Admin-generate a link of this type and return its token hash (no e-mail is sent). */
  async function linkFor(type, email) {
    const { data, error } = await admin.auth.admin.generateLink({ type, email });
    if (error) throw new Error(`generateLink(${type}): ${error.message}`);
    const hashed = data?.properties?.hashed_token;
    if (!hashed) throw new Error(`generateLink(${type}) returned no hashed_token`);
    if (data.user?.id && !createdUserIds.includes(data.user.id)) createdUserIds.push(data.user.id);
    return hashed;
  }

  /** What the app's verify route does with a link: verifyOtp({ type, token_hash }). */
  async function openLink(type, email) {
    const hashed = await linkFor(type, email);
    const client = fresh();
    const { data, error } = await client.auth.verifyOtp({ type, token_hash: hashed });
    if (error || !data?.session) throw new Error(`verifyOtp(${type}): ${error?.message ?? "no session"}`);
    return { client, session: data.session, hashed };
  }

  /** The app's rule on this session, with the evidence printed. */
  function assertLinkRule(label, session) {
    const amr = amrFromAccessToken(session.access_token);
    methods[label] = amr.map((e) => e.method);
    log(`  ${label}: amr = ${JSON.stringify(amr)}`);
    check(amr.length > 0 && amr.every((e) => typeof e.method === "string" && e.timestamp > 0), `${label}: the access token carries amr entries with a method and a timestamp`);
    check(amr.some((e) => LINK_SESSION_METHODS.has(e.method)), `${label}: its method (${amr.map((e) => e.method).join(", ") || "none"}) is one the app's rule accepts (${[...LINK_SESSION_METHODS].join(", ")})`);
    check(openedByRecentLink(session.access_token), `${label}: openedByRecentLink() accepts the session (may set a password without the current one)`);
    const newest = Math.max(0, ...amr.filter((e) => LINK_SESSION_METHODS.has(e.method)).map((e) => e.timestamp));
    check(newest > 0 && !openedByRecentLink(session.access_token, newest * 1000 + LINK_SESSION_MAX_AGE_MS + 1000), `${label}: …and stops accepting it one hour after the link was opened`);
    return amr;
  }

  try {
    await sweepStaleUsers();

    // --- recovery: forgot password --------------------------------------
    log("\nRecovery link (forgot password)…");
    const email = `linktest+${RUN}-reset@fanfunnel.test`;
    const oldPassword = password("old");
    const created = await admin.auth.admin.createUser({ email, password: oldPassword, email_confirm: true });
    if (created.error || !created.data?.user) throw new Error(`createUser: ${created.error?.message ?? "no user"}`);
    createdUserIds.push(created.data.user.id);

    const recovery = await openLink("recovery", email);
    const recoveryAmr = assertLinkRule("recovery", recovery.session);
    // The reset route's path for a link session: no current password asked.
    const newPassword = password("new");
    if (openedByRecentLink(recovery.session.access_token)) {
      const { error } = await recovery.client.auth.updateUser({ password: newPassword });
      check(!error, `recovery: the link's session sets a new password${error ? ` (${error.message})` : ""}`);
    } else {
      check(false, "recovery: the app's rule refused the link's session, so the reset screen would demand the forgotten password");
    }
    const withNew = fresh();
    const signedIn = await withNew.auth.signInWithPassword({ email, password: newPassword });
    check(!signedIn.error && !!signedIn.data?.session, "recovery: the new password signs in");
    const withOld = await fresh().auth.signInWithPassword({ email, password: oldPassword });
    check(!!withOld.error, "recovery: the old password no longer does");
    if (signedIn.data?.session) {
      const amr = amrFromAccessToken(signedIn.data.session.access_token);
      log(`  password sign-in: amr = ${JSON.stringify(amr)}`);
      check(amr.some((e) => e.method === "password"), "a password sign-in is recorded as method password");
      check(!openedByRecentLink(signedIn.data.session.access_token), "NEGATIVE: a password sign-in is NOT a link session (must give the current password)");
    }
    // The window counts from the link, not from the last token refresh.
    const refreshed = await recovery.client.auth.refreshSession();
    if (refreshed.error || !refreshed.data?.session) {
      check(false, `recovery: the link's session refreshes (${refreshed.error?.message ?? "no session"})`);
    } else {
      const after = amrFromAccessToken(refreshed.data.session.access_token);
      const stamp = (list) => list.find((e) => LINK_SESSION_METHODS.has(e.method))?.timestamp;
      check(stamp(after) === stamp(recoveryAmr), "a token refresh keeps the link entry's original timestamp (the hour is not extended by refreshing)");
    }
    // Single use: the same token again is refused the way the app expects.
    const again = await fresh().auth.verifyOtp({ type: "recovery", token_hash: recovery.hashed });
    check(!!again.error && !again.data?.session, "the same link a second time opens no session");
    check(again.error?.code === "otp_expired" || again.error?.status === 403, `…and is refused as otp_expired / 403 (got code=${again.error?.code} status=${again.error?.status}), which the app words as "already used or has expired"`);

    // --- magic link -------------------------------------------------------
    log("\nMagic link…");
    const magic = await openLink("magiclink", email);
    assertLinkRule("magiclink", magic.session);

    // --- invite: the invited creator has no password yet -----------------
    log("\nInvitation link…");
    const invitedEmail = `linktest+${RUN}-invite@fanfunnel.test`;
    const invite = await openLink("invite", invitedEmail);
    assertLinkRule("invite", invite.session);
    const firstPassword = password("first");
    if (openedByRecentLink(invite.session.access_token)) {
      const { error } = await invite.client.auth.updateUser({ password: firstPassword });
      check(!error, `invite: the invited account sets its first password${error ? ` (${error.message})` : ""}`);
      const first = await fresh().auth.signInWithPassword({ email: invitedEmail, password: firstPassword });
      check(!first.error && !!first.data?.session, "invite: that password signs in");
    } else {
      check(false, "invite: the app's rule refused the invitation's session, so the invited creator could not set a password");
    }
  } catch (e) {
    failures++;
    log(`  ✗ ERROR: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    log("\nCleaning up test users…");
    for (const id of createdUserIds) {
      try {
        const { error } = await admin.auth.admin.deleteUser(id);
        if (error) throw error;
      } catch (e) {
        cleanupFailed = true;
        log(`  ✗ Failed to delete test user ${id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  return { failures, cleanupFailed, methods };
}
