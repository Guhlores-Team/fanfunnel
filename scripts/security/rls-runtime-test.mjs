/**
 * Runtime cross-tenant RLS test — PROVES isolation against your live database.
 * The static lint (src/lib/security/rls.test.ts) checks the SQL; this checks the
 * running policies by acting as real authenticated users.
 *
 * Run:  node scripts/security/rls-runtime-test.mjs
 * Needs (from the environment, else .env.local):
 *   NEXT_PUBLIC_SUPABASE_URL
 *   NEXT_PUBLIC_SUPABASE_ANON_KEY   (the browser key — RLS applies to it)
 *   SUPABASE_SERVICE_ROLE_KEY       (to create disposable test users + cleanup)
 * Optional:
 *   RLS_TEST_REQUIRE_REF            (refuse to run unless the URL is this project ref; CI sets it)
 *
 * It creates two throwaway creators (A, B), gives each a fan + wheel via the
 * service role, then signs in AS each (anon key) and asserts:
 *   • A can read its own rows
 *   • A reads ZERO of B's rows (fans, wheels, prizes, spins, grants, profiles)
 *   • A cannot UPDATE or DELETE B's rows
 *   • A cannot promote itself to admin
 *   • RM-6 (0049): a fan's break refuses spins, can't be shortened (not even by
 *     the service role), can't be set or lifted from a creator's session, and a
 *     token reaches only its own fan; fan_take_break is server-only and the
 *     fan's private reminder is unreadable for the creator
 *   • only the service role writes fan_checkins (RM-3); A reads none of B's check-ins
 *   • A cannot read, write or alter B's win-back outreach log (0051)
 *   • an agency seat sees only its org's (scoped) creators, and a non-member
 *     cannot read the org or give itself a seat or org membership (0052)
 *   • anon and A cannot read, write or resolve app_errors (0053)
 * Exits non-zero on any leak, seed error, or cleanup failure.
 *
 * Safe to run repeatedly and concurrently against one shared TEST project:
 * every user/token carries a per-run id, all reads are scoped to this run's own
 * creator ids, the users (and, by FK cascade, all their rows) are deleted in a
 * `finally`, and users left behind by a killed run (> 1h old) are swept first.
 * It refuses to run against the PRODUCTION project.
 */
import { createClient } from "@supabase/supabase-js";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

try {
  for (const line of readFileSync(new URL("../../.env.local", import.meta.url), "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {}

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

const admin = createClient(URL_, SERVICE, { auth: { autoRefreshToken: false, persistSession: false } });
const PW = "RlsTest123!";
// Unique per run so concurrent runs (two PRs at once) never collide on an email
// or on the unique fan_passes.token.
const RUN = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
const TEST_EMAIL = /^rlstest\+[^@]*@fanfunnel\.test$/i;
const STALE_MS = 60 * 60 * 1000;
const createdUserIds = [];
const seededErrorIds = [];
let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log("  ✓", msg);
  else { failures++; console.error("  ✗ LEAK:", msg); }
};
// Seeding must succeed, or the "reads 0 of B's rows" checks would pass vacuously.
const must = (res, what) => {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  if (res.data == null) throw new Error(`${what}: no row returned`);
  return res.data;
};

// Delete this script's users left behind by a run that was killed before its
// `finally` (e.g. a cancelled CI job). Only old ones, so a concurrent run's
// users are never touched.
async function sweepStaleUsers() {
  const cutoff = Date.now() - STALE_MS;
  const stale = [];
  for (let page = 1; ; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) { console.error("  ⚠ Skipping stale-user sweep — listUsers:", error.message); return; }
    const users = data?.users ?? [];
    for (const u of users) {
      if (u.email && TEST_EMAIL.test(u.email) && Date.parse(u.created_at) < cutoff) stale.push(u.id);
    }
    if (users.length < 1000) break;
  }
  let swept = 0;
  for (const id of stale) {
    try {
      const { error } = await admin.auth.admin.deleteUser(id);
      if (error) throw error;
      swept++;
    } catch (e) {
      console.error("  ⚠ Could not sweep stale test user", id, "—", e.message ?? e);
    }
  }
  if (swept) console.log(`Swept ${swept} stale test user(s) from earlier killed runs.`);
}

// A throwaway, approved, active account with no tenant data.
async function makeUser(tag) {
  const email = `rlstest+${RUN}-${tag}@fanfunnel.test`;
  const { data, error } = await admin.auth.admin.createUser({
    email, password: PW, email_confirm: true,
  });
  if (error) throw error;
  const id = data.user.id;
  // Register for cleanup before anything else can throw.
  createdUserIds.push(id);
  // The profiles row is created by a database trigger that may not have completed
  // yet; poll until it exists before updating to avoid flaky failures.
  let profileExists = false;
  for (let attempt = 0; attempt < 20; attempt++) {
    const { data: profile } = await admin.from("profiles").select("id").eq("id", id).maybeSingle();
    if (profile) { profileExists = true; break; }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!profileExists) throw new Error(`profiles row for ${id} was not created by trigger in time`);
  must(await admin.from("profiles").update({ approval_status: "approved", is_active: true }).eq("id", id).select("id").single(), `approve ${tag}`);
  return { id, email };
}

async function makeCreator(tag) {
  const { id, email } = await makeUser(tag);
  // Seed one wheel + prize + fan + pass + grant + spin for this creator.
  const wheel = must(await admin.from("wheels").insert({ creator_id: id, title: `${tag} wheel` }).select("id").single(), `seed ${tag} wheel`);
  const prize = must(await admin.from("prizes").insert({ wheel_id: wheel.id, label: `${tag} prize`, rarity: "common", weight: 10 }).select("id").single(), `seed ${tag} prize`);
  const fan = must(await admin.from("fans").insert({ creator_id: id, display_name: `${tag} fan`, spins_remaining: 5 }).select("id").single(), `seed ${tag} fan`);
  const token = `rls-${RUN}-${tag}`;
  const pass = must(await admin.from("fan_passes").insert({ token, creator_id: id, wheel_id: wheel.id, fan_id: fan.id, spins_remaining: 5 }).select("id").single(), `seed ${tag} fan_pass`);
  must(await admin.from("grants").insert({ creator_id: id, fan_id: fan.id, spins: 5, amount_cents: 1000 }).select("id").single(), `seed ${tag} grant`);
  must(await admin.from("spins").insert({ fan_pass_id: pass.id, creator_id: id, wheel_id: wheel.id, fan_id: fan.id, prize_id: prize.id, prize_label: `${tag} prize`, prize_rarity: "common" }).select("id").single(), `seed ${tag} spin`);
  return { id, email, wheelId: wheel.id, fanId: fan.id, fanName: `${tag} fan`, token };
}

async function signedClient(email) {
  const c = createClient(URL_, ANON, { auth: { autoRefreshToken: false, persistSession: false } });
  const { error } = await c.auth.signInWithPassword({ email, password: PW });
  if (error) throw error;
  return c;
}

async function main() {
  let cleanupFailed = false;
  try {
    await sweepStaleUsers();

    console.log(`Creating two throwaway creators (run ${RUN})…`);
    const A = await makeCreator("a");
    const B = await makeCreator("b");

    const a = await signedClient(A.email);
    const b = await signedClient(B.email);
    console.log("\nActing as Creator A — asserting isolation from B:");

    // A sees its own rows.
    const ownFans = await a.from("fans").select("id").eq("creator_id", A.id);
    check((ownFans.data?.length ?? 0) === 1, "A can read its OWN fan");

    // A sees none of B's, across every tenant table.
    for (const [table] of [["fans"], ["wheels"], ["grants"], ["spins"]]) {
      const r = await a.from(table).select("id").eq("creator_id", B.id);
      check((r.data?.length ?? 0) === 0, `A reads 0 of B's ${table} (got ${r.data?.length ?? 0})`);
    }
    // Prizes are scoped via their wheel.
    const bPrizes = await a.from("prizes").select("id").eq("wheel_id", B.wheelId);
    check((bPrizes.data?.length ?? 0) === 0, `A reads 0 of B's prizes (got ${bPrizes.data?.length ?? 0})`);
    // Profiles: A must not read B's profile row.
    const bProfile = await a.from("profiles").select("id").eq("id", B.id);
    check((bProfile.data?.length ?? 0) === 0, `A reads 0 of B's profile (got ${bProfile.data?.length ?? 0})`);

    // A cannot mutate B's rows (RLS should match zero rows → no-op, never error-leak).
    const upd = await a.from("fans").update({ display_name: "HACKED" }).eq("id", B.fanId).select("id");
    check((upd.data?.length ?? 0) === 0, "A cannot UPDATE B's fan");
    const del = await a.from("wheels").delete().eq("id", B.wheelId).select("id");
    check((del.data?.length ?? 0) === 0, "A cannot DELETE B's wheel");
    // Confirm with the service role that B's rows really are untouched.
    const { data: bFanAfter } = await admin.from("fans").select("display_name").eq("id", B.fanId).maybeSingle();
    check(bFanAfter?.display_name === B.fanName, `B's fan is unchanged (got ${bFanAfter?.display_name})`);
    const { data: bWheelAfter } = await admin.from("wheels").select("id").eq("id", B.wheelId);
    check((bWheelAfter?.length ?? 0) === 1, "B's wheel still exists");

    // A cannot PROMOTE itself. The profiles UPDATE policy is admin-only, so a
    // creator setting its own role must match zero rows (RLS no-op), and the
    // role must remain unchanged when re-read with the service role. This pins
    // the auth contract's "a normal user cannot promote themselves" rule.
    const selfPromote = await a
      .from("profiles")
      .update({ role: "admin", is_active: true })
      .eq("id", A.id)
      .select("id");
    check((selfPromote.data?.length ?? 0) === 0, "A cannot self-UPDATE its profile (admin-only)");
    const { data: aRole } = await admin.from("profiles").select("role").eq("id", A.id).maybeSingle();
    check(aRole?.role !== "admin", `A's role is still not admin after self-promote attempt (got ${aRole?.role})`);

    // RM-4 (0046): the home-screen icon setter writes only the caller's row.
    const setIcon = await a.rpc("set_pwa_icon_mode", { p_mode: "avatar" });
    check(!setIcon.error, `A can set its own home-screen icon (${setIcon.error?.message ?? "ok"})`);
    const { data: icons } = await admin.from("profiles").select("id, pwa_icon_mode").in("id", [A.id, B.id]);
    const iconOf = (id) => icons?.find((r) => r.id === id)?.pwa_icon_mode;
    check(iconOf(A.id) === "avatar", `A's icon mode is avatar (got ${iconOf(A.id)})`);
    check(iconOf(B.id) === "neutral", `B's icon mode is untouched by A (got ${iconOf(B.id)})`);
    const directIcon = await a.from("profiles").update({ pwa_icon_mode: "avatar" }).eq("id", B.id).select("id");
    check((directIcon.data?.length ?? 0) === 0, "A cannot UPDATE B's pwa_icon_mode directly");
    const anonClient = createClient(URL_, ANON, { auth: { persistSession: false } });
    const anonIcon = await anonClient.rpc("set_pwa_icon_mode", { p_mode: "avatar" });
    check(!!anonIcon.error, "anon cannot execute set_pwa_icon_mode");

    // RM-6 (0049): the fan's break. The server (service role) starts it from
    // the fan's link token; nobody can shorten it; a creator can't touch it.
    console.log("\nRM-6: a fan's break");
    const DAY = 86_400_000;
    const inDays = (d) => new Date(Date.now() + d * DAY).toISOString();
    const took = await admin.rpc("fan_take_break", { p_token: A.token, p_until: inDays(7) });
    check(!took.error && typeof took.data === "string", `the server starts A's fan's break (${took.error?.message ?? "ok"})`);
    const refused = await admin.rpc("claim_spin", { p_token: A.token });
    check(!refused.error && refused.data === null, `claim_spin refuses a spin during the break (got ${refused.data})`);
    const other = await admin.rpc("claim_spin", { p_token: B.token });
    check(typeof other.data === "number", `B's fan (no break) still spins (got ${other.data}; ${other.error?.message ?? "ok"})`);
    const shorter = await admin.rpc("fan_take_break", { p_token: A.token, p_until: inDays(1) });
    check(!shorter.error && Date.parse(shorter.data) === Date.parse(took.data), "asking for a shorter break keeps the longer one");
    const svcShorten = await admin.from("fans").update({ break_until: new Date().toISOString() }).eq("id", A.fanId).select("id");
    check(!!svcShorten.error, "not even the service role can shorten a break in force");
    const lift = await a.from("fans").update({ break_until: null }).eq("id", A.fanId).select("id");
    check(!!lift.error || (lift.data?.length ?? 0) === 0, "A's session cannot lift its own fan's break");
    const setOnB = await a.from("fans").update({ break_until: inDays(30) }).eq("id", B.fanId).select("id");
    check(!!setOnB.error || (setOnB.data?.length ?? 0) === 0, "A's session cannot set a break on B's fan");
    const { data: breaks } = await admin.from("fans").select("id, break_until").in("id", [A.fanId, B.fanId]);
    const breakOf = (id) => breaks?.find((r) => r.id === id)?.break_until ?? null;
    check(!!breakOf(A.fanId) && Date.parse(breakOf(A.fanId)) === Date.parse(took.data), "A's fan's break is unchanged");
    check(breakOf(B.fanId) === null, `A's token never reached B's fan (got ${breakOf(B.fanId)})`);
    const aTake = await a.rpc("fan_take_break", { p_token: B.token, p_until: inDays(1) });
    check(!!aTake.error, "authenticated cannot execute fan_take_break");
    const anonTake = await anonClient.rpc("fan_take_break", { p_token: B.token, p_until: inDays(1) });
    check(!!anonTake.error, "anon cannot execute fan_take_break");
    must(await admin.from("fan_play_reminders").insert({ fan_id: A.fanId, daily: 50 }).select("fan_id").single(), "seed A's fan's reminder");
    const readRem = await a.from("fan_play_reminders").select("fan_id, daily");
    check((readRem.data?.length ?? 0) === 0, `A cannot read its fan's private reminder (got ${readRem.data?.length ?? 0})`);
    const writeRem = await a.from("fan_play_reminders").insert({ fan_id: A.fanId, daily: 20 }).select("fan_id");
    check(!!writeRem.error || (writeRem.data?.length ?? 0) === 0, "A cannot write a fan's reminder");
    // RM-3 (0050): visits are written only by the server (service role). A
    // creator reads its own fans' visits, never B's, and nobody else can write.
    const today = new Date().toISOString().slice(0, 10);
    must(await admin.from("fan_checkins").insert({ fan_id: A.fanId, creator_id: A.id, day: today }).select("day").single(), "seed A check-in");
    must(await admin.from("fan_checkins").insert({ fan_id: B.fanId, creator_id: B.id, day: today }).select("day").single(), "seed B check-in");
    const ownVisits = await a.from("fan_checkins").select("day").eq("fan_id", A.fanId);
    check((ownVisits.data?.length ?? 0) === 1, `A reads its own fan's check-in (got ${ownVisits.data?.length ?? 0})`);
    const bVisits = await a.from("fan_checkins").select("day").eq("creator_id", B.id);
    check((bVisits.data?.length ?? 0) === 0, `A reads 0 of B's check-ins (got ${bVisits.data?.length ?? 0})`);
    const aInsert = await a.from("fan_checkins").insert({ fan_id: A.fanId, creator_id: A.id, day: "2000-01-01" }).select("day");
    check(!!aInsert.error && (aInsert.data?.length ?? 0) === 0, "A cannot INSERT a check-in (server-only writes)");
    const aForge = await a.from("fan_checkins").insert({ fan_id: B.fanId, creator_id: B.id, day: "2000-01-02" }).select("day");
    check(!!aForge.error, "A cannot INSERT a check-in for B's fan");
    const aMove = await a.from("fan_checkins").update({ day: "2000-01-03" }).eq("fan_id", B.fanId).select("day");
    check((aMove.data?.length ?? 0) === 0, "A cannot UPDATE B's check-in");
    const aDrop = await a.from("fan_checkins").delete().eq("fan_id", B.fanId).select("day");
    check((aDrop.data?.length ?? 0) === 0, "A cannot DELETE B's check-in");
    const anonInsert = await anonClient.from("fan_checkins").insert({ fan_id: A.fanId, creator_id: A.id, day: "2000-01-04" }).select("day");
    check(!!anonInsert.error, "anon cannot INSERT a check-in");
    const anonRead = await anonClient.from("fan_checkins").select("day");
    check((anonRead.data?.length ?? 0) === 0, `anon reads 0 check-ins (got ${anonRead.data?.length ?? 0})`);
    const { data: bAfter } = await admin.from("fan_checkins").select("day").eq("fan_id", B.fanId);
    check(bAfter?.length === 1 && bAfter[0].day === today, "B's check-in is untouched");
    const { data: forged } = await admin.from("fan_checkins").select("day").lt("day", "2001-01-01").in("fan_id", [A.fanId, B.fanId]);
    check((forged?.length ?? 0) === 0, `no forged check-in landed (got ${forged?.length ?? 0})`);
    // RM-5 (0051): the win-back outreach log is tenant-isolated and append-only.
    const nowIso = new Date().toISOString();
    const bOut = must(
      await admin.from("fan_outreach").insert({ creator_id: B.id, fan_id: B.fanId, contacted_at: nowIso }).select("id").single(),
      "seed B outreach",
    );
    const ownOut = await a.from("fan_outreach").insert({ creator_id: A.id, fan_id: A.fanId, contacted_at: nowIso }).select("id");
    check(!ownOut.error && (ownOut.data?.length ?? 0) === 1, `A can log outreach for its OWN fan (${ownOut.error?.message ?? "ok"})`);
    const readBOut = await a.from("fan_outreach").select("id").eq("creator_id", B.id);
    check((readBOut.data?.length ?? 0) === 0, `A reads 0 of B's fan_outreach (got ${readBOut.data?.length ?? 0})`);
    const asB = await a.from("fan_outreach").insert({ creator_id: B.id, fan_id: B.fanId, contacted_at: nowIso }).select("id");
    check(!!asB.error && (asB.data?.length ?? 0) === 0, "A cannot log outreach under B's creator id");
    const forBFan = await a.from("fan_outreach").insert({ creator_id: A.id, fan_id: B.fanId, contacted_at: nowIso }).select("id");
    check(!!forBFan.error && (forBFan.data?.length ?? 0) === 0, "A cannot log outreach for B's fan");
    const updB = await a.from("fan_outreach").update({ snoozed_until: nowIso }).eq("id", bOut.id).select("id");
    check((updB.data?.length ?? 0) === 0, "A cannot UPDATE B's outreach row");
    const updOwn = await a.from("fan_outreach").update({ snoozed_until: nowIso }).eq("creator_id", A.id).select("id");
    check((updOwn.data?.length ?? 0) === 0, "A cannot UPDATE even its own outreach row (append-only)");
    const delOwn = await a.from("fan_outreach").delete().eq("creator_id", A.id).select("id");
    check((delOwn.data?.length ?? 0) === 0, "A cannot DELETE its own outreach row (append-only)");
    const anonOut = await anonClient.from("fan_outreach").select("id");
    check((anonOut.data?.length ?? 0) === 0, `anon reads no fan_outreach rows (got ${anonOut.data?.length ?? 0})`);
    const { data: bOutAfter } = await admin.from("fan_outreach").select("id, snoozed_until").eq("creator_id", B.id);
    check((bOutAfter?.length ?? 0) === 1 && bOutAfter?.[0]?.snoozed_until === null, "B's outreach log is untouched by A");
    // Agency / org isolation (0052, audit A2). The service role builds an org
    // owned by OWN holding creators A and C, with a chatter seat for SEAT
    // scoped to A only. B stays outside the org. Mirrors
    // scripts/db/orgIsolationProbe.mjs.
    console.log("\nAgency org — asserting seats and membership stay inside the org:");
    const C = await makeCreator("c");
    const OWN = await makeUser("own");
    const SEAT = await makeUser("seat");
    const org = must(await admin.from("orgs").insert({ name: `rls ${RUN}`, owner_id: OWN.id }).select("id").single(), "seed org");
    const seat = must(await admin.from("org_members").insert({ org_id: org.id, profile_id: SEAT.id, role: "chatter" }).select("id").single(), "seed seat");
    must(await admin.from("org_member_creators").insert({ member_id: seat.id, creator_id: A.id }).select("member_id").single(), "seed seat scope");
    for (const who of [A, C]) {
      must(await admin.from("profiles").update({ org_id: org.id }).eq("id", who.id).select("id").single(), "put a creator in the org");
    }

    const s = await signedClient(SEAT.email);
    const sOrgs = await s.from("orgs").select("id").eq("id", org.id);
    check(!sOrgs.error && sOrgs.data?.length === 1, `the seat can read its own org (${sOrgs.error?.message ?? `got ${sOrgs.data?.length}`})`);
    const sFansA = await s.from("fans").select("id").eq("creator_id", A.id);
    check((sFansA.data?.length ?? 0) === 1, `the seat reads its scoped creator A's fan (got ${sFansA.data?.length ?? 0})`);
    const sFansB = await s.from("fans").select("id").eq("creator_id", B.id);
    check((sFansB.data?.length ?? 0) === 0, `the seat reads 0 of B's fans; B is outside the org (got ${sFansB.data?.length ?? 0})`);
    const sFansC = await s.from("fans").select("id").eq("creator_id", C.id);
    check((sFansC.data?.length ?? 0) === 0, `the seat reads 0 of C's fans; C is in the org but not in its scope (got ${sFansC.data?.length ?? 0})`);
    const sStats = await s.rpc("org_account_stats", { p_org: org.id });
    const statIds = (sStats.data ?? []).map((r) => r.id);
    check(!sStats.error && statIds.length === 1 && statIds[0] === A.id, `the seat's org stats list only its scoped creator A, not C (${sStats.error?.message ?? statIds.join(",")})`);
    const ownStats = await (await signedClient(OWN.email)).rpc("org_account_stats", { p_org: org.id });
    check(!ownStats.error && ownStats.data?.length === 2, `the org owner's stats list both of its creators (${ownStats.error?.message ?? `got ${ownStats.data?.length}`})`);
    const sPromote = await s.from("org_members").update({ role: "owner" }).eq("id", seat.id).select("id");
    check((sPromote.data?.length ?? 0) === 0, "the seat cannot promote its own seat");
    const sScope = await s.from("org_member_creators").insert({ member_id: seat.id, creator_id: B.id }).select("member_id");
    check(!!sScope.error || (sScope.data?.length ?? 0) === 0, "the seat cannot widen its own scope");

    // B is signed in but holds no seat and is not in the org.
    const bOrgs = await b.from("orgs").select("id").eq("id", org.id);
    check((bOrgs.data?.length ?? 0) === 0, "a non-member reads 0 of the org's rows");
    const bSeats = await b.from("org_members").select("id").eq("org_id", org.id);
    check((bSeats.data?.length ?? 0) === 0, "a non-member reads 0 of the org's seats");
    const bJoin = await b.from("org_members").insert({ org_id: org.id, profile_id: B.id, role: "owner" }).select("id");
    check(!!bJoin.error || (bJoin.data?.length ?? 0) === 0, "a non-member cannot give itself a seat");
    const bRpc = await b.rpc("org_add_member", { p_org: org.id, p_email: B.email, p_role: "owner" });
    check(bRpc.data === "not_owner", `org_add_member refuses a non-owner (got ${bRpc.data ?? bRpc.error?.message})`);
    const bJoinOrg = await b.from("profiles").update({ org_id: org.id }).eq("id", B.id).select("id");
    check((bJoinOrg.data?.length ?? 0) === 0, "a non-member cannot set its own org_id");
    const bStats = await b.rpc("org_account_stats", { p_org: org.id });
    check((bStats.data?.length ?? 0) === 0, `a non-member's org stats are empty (got ${bStats.data?.length ?? 0})`);
    const bFansA = await b.from("fans").select("id").eq("creator_id", A.id);
    check((bFansA.data?.length ?? 0) === 0, "a non-member reads 0 of the org creator's fans");
    const { data: seatsAfter } = await admin.from("org_members").select("profile_id, role").eq("org_id", org.id);
    check(seatsAfter?.length === 1 && seatsAfter[0].profile_id === SEAT.id && seatsAfter[0].role === "chatter", "the org still has exactly the one chatter seat");
    const { data: bOrgAfter } = await admin.from("profiles").select("org_id").eq("id", B.id).maybeSingle();
    check(bOrgAfter?.org_id == null, "B is still outside the org");

    // Suspended accounts (0052): a suspended seat gets nothing and a suspended
    // owner can't manage the org. The sessions above stay valid; only the
    // profile flag changes, exactly as an admin suspension does.
    must(await admin.from("profiles").update({ is_active: false }).in("id", [SEAT.id, OWN.id]).select("id"), "suspend the seat and the owner");
    const sFansAfter = await s.from("fans").select("id").eq("creator_id", A.id);
    check((sFansAfter.data?.length ?? 0) === 0, `a suspended seat reads 0 of its scoped creator's fans (got ${sFansAfter.data?.length ?? 0})`);
    const sOrgsAfter = await s.from("orgs").select("id").eq("id", org.id);
    check((sOrgsAfter.data?.length ?? 0) === 0, "a suspended seat reads 0 of its org's rows");
    const own = await signedClient(OWN.email);
    const ownAdd = await own.rpc("org_add_member", { p_org: org.id, p_email: B.email, p_role: "manager" });
    check(ownAdd.data === "not_owner", `a suspended owner cannot add a seat (got ${ownAdd.data ?? ownAdd.error?.message})`);
    const ownDrop = await own.rpc("org_remove_member", { p_member: seat.id });
    check(ownDrop.data === "not_owner", `a suspended owner cannot remove a seat (got ${ownDrop.data ?? ownDrop.error?.message})`);
    const ownRename = await own.from("orgs").update({ name: "renamed" }).eq("id", org.id).select("id");
    check((ownRename.data?.length ?? 0) === 0, "a suspended owner cannot rename the org");
    const ownStatsSuspended = await own.rpc("org_account_stats", { p_org: org.id });
    check((ownStatsSuspended.data?.length ?? 0) === 0, `a suspended owner's org stats are empty (got ${ownStatsSuspended.data?.length ?? 0})`);
    const { data: seatsSuspended } = await admin.from("org_members").select("id").eq("org_id", org.id);
    check(seatsSuspended?.length === 1, "the org still has exactly the one seat");
    // 0053 error monitoring: app_errors is admin-read/resolve only and written
    // only by the server (service role). Seed one row the way the server does.
    const fp = createHash("sha256").update(`rls-${RUN}`).digest("hex");
    const seeded = await admin.rpc("record_app_error", {
      p_fingerprint: fp, p_environment: "development", p_source: "server", p_message: `rls probe ${RUN}`,
    });
    const errId = seeded.data?.id;
    if (seeded.error || !errId) throw new Error(`seed app_errors: ${seeded.error?.message ?? "no id"}`);
    seededErrorIds.push(errId);
    console.log("\nError monitoring (app_errors) — anon and a normal creator are locked out:");
    const anonErrRead = await anonClient.from("app_errors").select("id").eq("id", errId);
    check((anonErrRead.data?.length ?? 0) === 0, `anon reads 0 app_errors (got ${anonErrRead.data?.length ?? 0})`);
    const anonIns = await anonClient.from("app_errors").insert({ fingerprint: fp.slice(0, 32), environment: "development", source: "client", message: "x" });
    check(!!anonIns.error, "anon cannot INSERT app_errors");
    const anonRec = await anonClient.rpc("record_app_error", { p_fingerprint: fp, p_environment: "development", p_source: "client", p_message: "x" });
    check(!!anonRec.error, "anon cannot execute record_app_error");
    const aRead = await a.from("app_errors").select("id").eq("id", errId);
    check((aRead.data?.length ?? 0) === 0, `creator A reads 0 app_errors (got ${aRead.data?.length ?? 0})`);
    const aIns = await a.from("app_errors").insert({ fingerprint: fp.slice(0, 32), environment: "development", source: "client", message: "x" });
    check(!!aIns.error, "creator A cannot INSERT app_errors");
    const aResolve = await a.from("app_errors").update({ resolved: true }).eq("id", errId).select("id");
    check((aResolve.data?.length ?? 0) === 0, "creator A cannot resolve an app_error");
    const aRec = await a.rpc("record_app_error", { p_fingerprint: fp, p_environment: "development", p_source: "client", p_message: "x" });
    check(!!aRec.error, "creator A cannot execute record_app_error");
    const aClaim = await a.rpc("claim_app_error_alert", { p_limit: 100 });
    check(!!aClaim.error, "creator A cannot execute claim_app_error_alert");
    const aAlerts = await a.from("app_error_alerts").select("id").limit(1);
    check((aAlerts.data?.length ?? 0) === 0, "creator A reads 0 app_error_alerts");
    const { data: errAfter } = await admin.from("app_errors").select("resolved, count").eq("id", errId).maybeSingle();
    check(errAfter?.resolved === false && errAfter?.count === 1, `the app_error is untouched (resolved=${errAfter?.resolved}, count=${errAfter?.count})`);
    // 0054: the activity log and link tombstones are admin-only, the log is
    // append-only through the server, and the self-close / retention functions
    // are server-only. A creator (and anon) get nothing.
    for (const table of ["admin_audit_log", "link_tombstones"]) {
      const r = await a.from(table).select("*").limit(5);
      check((r.data?.length ?? 0) === 0, `A reads 0 rows of ${table} (got ${r.data?.length ?? 0})`);
    }
    const forgedAudit = await a
      .from("admin_audit_log")
      .insert({ actor_id: A.id, action: "account.delete", details: {} })
      .select("id");
    check(!!forgedAudit.error && (forgedAudit.data?.length ?? 0) === 0, "A cannot write the activity log");
    const notices = await a.from("creator_notices").select("creator_id");
    check((notices.data ?? []).every((n) => n.creator_id === A.id), "A reads only its own creator_notices");
    const selfClose = await a.rpc("reserve_self_account_deletion", { p_user: B.id });
    check(!!selfClose.error, "A cannot execute reserve_self_account_deletion");
    const sweep = await a.rpc("run_retention_cleanup", { p_audit_days: 1, p_notice_days: 1, p_tombstone_days: 1, p_app_error_days: 1, p_closed_invite_days: 1 });
    check(!!sweep.error, "A cannot execute run_retention_cleanup");
    const anonSweep = await anonClient.rpc("run_retention_cleanup", { p_audit_days: 1, p_notice_days: 1, p_tombstone_days: 1, p_app_error_days: 1, p_closed_invite_days: 1 });
    check(!!anonSweep.error, "anon cannot execute run_retention_cleanup");
    // A password-only session is aal1, so is_admin() is false even for an admin.
    const aIsAdmin = await a.rpc("is_admin");
    check(aIsAdmin.data !== true, "A's is_admin() is false");

    // An ADMIN on a password-only (aal1) session gets no admin power either:
    // make A an admin server-side, then use A's existing aal1 session.
    must(await admin.from("profiles").update({ role: "admin" }).eq("id", A.id).select("id").single(), "promote A for the aal1 check");
    try {
      const aal1IsAdmin = await a.rpc("is_admin");
      check(aal1IsAdmin.data === false, `an aal1 admin's is_admin() is false (got ${aal1IsAdmin.data})`);
      const aal1Log = await a.from("admin_audit_log").select("id").limit(5);
      check((aal1Log.data?.length ?? 0) === 0, `an aal1 admin reads 0 activity-log rows (got ${aal1Log.data?.length ?? 0})`);
      const aal1Cross = await a.from("fans").select("id").eq("creator_id", B.id);
      check((aal1Cross.data?.length ?? 0) === 0, `an aal1 admin cannot read another creator's fans (got ${aal1Cross.data?.length ?? 0})`);
      const aal1Promote = await a.from("profiles").update({ is_active: true }).eq("id", B.id).select("id");
      check((aal1Promote.data?.length ?? 0) === 0, "an aal1 admin cannot UPDATE another profile");
    } finally {
      await admin.from("profiles").update({ role: "creator" }).eq("id", A.id);
    }
    // 0055: Terms acceptance is server-only. A creator can't record it for
    // another creator (or for itself) through the RPC or a direct UPDATE, and
    // anon can't call the RPC at all. Only /api/account/terms (service role,
    // session user, server version) writes it.
    const termsForB = await a.rpc("record_terms_acceptance", { p_user: B.id, p_version: "2099-01-01" });
    check(!!termsForB.error, "A cannot execute record_terms_acceptance (for B)");
    const termsForA = await a.rpc("record_terms_acceptance", { p_user: A.id, p_version: "2099-01-01" });
    check(!!termsForA.error, "A cannot execute record_terms_acceptance (for itself: no forged version)");
    const anonTerms = await anonClient.rpc("record_terms_acceptance", { p_user: B.id, p_version: "2099-01-01" });
    check(!!anonTerms.error, "anon cannot execute record_terms_acceptance");
    const directTerms = await a
      .from("profiles")
      .update({ terms_version: "2099-01-01", terms_accepted_at: "2000-01-01T00:00:00Z" })
      .in("id", [A.id, B.id])
      .select("id");
    check((directTerms.data?.length ?? 0) === 0, "A cannot UPDATE terms_version / terms_accepted_at directly");
    const { data: termRows } = await admin.from("profiles").select("id, terms_version").in("id", [A.id, B.id]);
    check(
      (termRows ?? []).every((r) => r.terms_version == null),
      `no acceptance was recorded by those attempts (got ${JSON.stringify(termRows)})`
    );

    // Web push (0056): devices are own-only; push_log is service-only.
    {
    const ep = (x) => `https://fcm.googleapis.com/fcm/send/rls-${RUN}-${x}`;
    const bDev = must(
      await admin.from("push_subscriptions").insert({ user_id: B.id, endpoint: ep("b"), p256dh: "k", auth: "a" }).select("id").single(),
      "seed B push device"
    );
    const aIns = await a.from("push_subscriptions").insert({ user_id: A.id, endpoint: ep("a"), p256dh: "k", auth: "a" }).select("id");
    check(!aIns.error && aIns.data?.length === 1, `A can register its own push device (${aIns.error?.message ?? "ok"})`);
    const aList = await a.from("push_subscriptions").select("id, user_id");
    check((aList.data ?? []).every((r) => r.user_id === A.id), `A lists only its own push devices (got ${aList.data?.length ?? 0})`);
    const aForB = await a.from("push_subscriptions").insert({ user_id: B.id, endpoint: ep("forged"), p256dh: "k", auth: "a" }).select("id");
    check(!!aForB.error, "A cannot register a push device for B");
    const aUpdB = await a.from("push_subscriptions").update({ show_details: true }).eq("id", bDev.id).select("id");
    check((aUpdB.data?.length ?? 0) === 0, "A cannot change B's lock-screen setting");
    const aDelB = await a.from("push_subscriptions").delete().eq("id", bDev.id).select("id");
    check((aDelB.data?.length ?? 0) === 0, "A cannot remove B's push device");
    const { data: bDevAfter } = await admin.from("push_subscriptions").select("id, show_details").eq("id", bDev.id).maybeSingle();
    check(bDevAfter?.show_details === false, "B's push device is still there, unchanged");
    const aMove = await a.from("push_subscriptions").update({ user_id: B.id }).eq("user_id", A.id).select("id");
    check(!!aMove.error || (aMove.data?.length ?? 0) === 0, "A cannot move its device to B (only show_details is writable)");
    const aLog = await a.from("push_log").insert({ user_id: A.id, item_id: "forged", tag: "forged" });
    check(!!aLog.error, "A cannot write push_log (service-only)");
    const anonSub = await anonClient.from("push_subscriptions").insert({ user_id: A.id, endpoint: ep("anon"), p256dh: "k", auth: "a" });
    check(!!anonSub.error, "anon cannot register a push device");
    const anonList = await anonClient.from("push_subscriptions").select("id");
    check(!!anonList.error || (anonList.data?.length ?? 0) === 0, "anon cannot list push devices");
    }
  } finally {
    // Always clean up, even if an error was thrown above, so no disposable
    // users or seeded tenant data (FK-cascaded from the user) are left behind.
    for (const id of seededErrorIds) {
      const { error } = await admin.from("app_errors").delete().eq("id", id);
      if (error) { cleanupFailed = true; console.error("  ✗ Failed to delete seeded app_error", id, "—", error.message); }
    }
    console.log("\nCleaning up test users…");
    for (const id of createdUserIds) {
      try {
        const { error } = await admin.auth.admin.deleteUser(id);
        if (error) throw error;
      } catch (e) {
        cleanupFailed = true;
        console.error("  ✗ Failed to delete test user", id, "—", e.message ?? e);
      }
    }
  }

  if (failures > 0) {
    console.error(`\n✗ RLS RUNTIME TEST FAILED — ${failures} leak(s). Do not ship.`);
    process.exit(1);
  }
  if (cleanupFailed) {
    console.error("\n✗ RLS checks passed, but cleanup failed — test users were left behind.");
    process.exit(1);
  }
  console.log("\n✓ RLS runtime test passed — tenants are isolated.");
}

main().catch((e) => { console.error("✗ Test error:", e.message ?? e); process.exit(1); });
