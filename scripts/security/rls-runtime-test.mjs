import { fixtureCreatorRpc, fixtureActorContext } from "./actor-context-fixture.mjs";
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
 *   • 0068: a creator cannot pause, un-pause or re-token its fan's link (nor
 *     can the service role un-pause one), cannot attach another creator's spin
 *     or fan to a redemption/message, cannot forge a fan's consent or insert a
 *     fan-sent message, cannot select link tokens (creator_link_tokens serves
 *     them to the owner only); a suspended account or one with an open report
 *     cannot close itself; invitations answer ok for any address and seat
 *     nobody until accepted; a confirmed e-mail change reaches profiles.email
 *   • the hosted schema_version() (0067) is the newest migration file, so a
 *     stale TEST fails before its first retired call; set_redemption_state is
 *     the one fulfilment write (0067) and a session cannot insert an award
 *     (0069); a game needs two prizes to be set on a link, a campaign or a
 *     schedule (0069); a game with play history is never deleted (0065)
 * Exits non-zero on any leak, seed error, or cleanup failure.
 *
 * Safe to run repeatedly and concurrently against one shared TEST project:
 * every user/token carries a per-run id, all reads are scoped to this run's own
 * creator ids, the users (and, by FK cascade, all their rows) are deleted in a
 * `finally`, and users left behind by a killed run (> 1h old) are swept first.
 * It refuses to run against the PRODUCTION project.
 */
import { testOperationalIntegrityRuntime } from "./operational-integrity-runtime-fixture.mjs";
import { createClient } from "@supabase/supabase-js";
import { isLegacyCanaryTestProject, readLegacyCanaryCounts } from "./legacy-canary-counts.mjs";
import { fixtureTotp } from "./totp-fixture.mjs";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { testBingoRuntime } from "./bingo-runtime-fixture.mjs";

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

// Fixed TEST boundary also protects the later count-only rollout snapshot.
if (!isLegacyCanaryTestProject(URL_)) {
  console.error("✗ Refusing to run: the fixed FanFunnel TEST project is required.");
  process.exit(1);
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
const seededFactorIds = [];
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

const creatorFixtureClients=new Map();
async function makeCreator(tag) {
  const { id, email } = await makeUser(tag);
  const session=await signedClient(email);creatorFixtureClients.set(id,session);
  // Seed one wheel + prize + fan + pass + grant + spin for this creator.
  const wheel = must(await admin.from("wheels").insert({ creator_id: id, title: `${tag} wheel` }).select("id").single(), `seed ${tag} wheel`);
  const prize = must(await admin.from("prizes").insert({ wheel_id: wheel.id, label: `${tag} prize`, rarity: "common", weight: 10 }).select("id").single(), `seed ${tag} prize`);
  const fan = must(await admin.from("fans").insert({ creator_id: id, display_name: `${tag} fan`, acked_at:new Date().toISOString(),acked_terms_version:"2026-10-27" }).select("id").single(), `seed ${tag} fan`);
  const grant=must(await fixtureCreatorRpc(admin,session,"create_pass_grant",{p_request:randomUUID(),p_creator:id,p_fan:fan.id,p_wheel:wheel.id,p_name:`${tag} fan`,p_spins:5,p_bonus:0,p_amount:1000,p_campaign:null}),`seed ${tag} atomic grant`);
  if(grant.status!=="granted")throw Error(`seed ${tag} grant refused: ${grant.status}`);
  const result={id,email,wheelId:wheel.id,prizeId:prize.id,fanId:fan.id,passId:grant.passId,fanName:`${tag} fan`,token:grant.token,requestId:grant.grantId};
  await recordRuntimeSpin(result);
  return result;
}

const canonicalProof=(v)=>v===null||typeof v!=="object"?JSON.stringify(v):Array.isArray(v)?`[${v.map(canonicalProof).join(",")}]`:`{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${canonicalProof(v[k])}`).join(",")}}`;
const sha=(s)=>createHash("sha256").update(s).digest("hex");
// Synthetic deterministic single-prize fixture, committed through the SAME
// service-only economic RPC the application uses. No split seed/credit writes.
async function recordRuntimeSpin(creator,expected={delivery:"manual"}) {
  const request=randomUUID(),binding=sha(request);
  const ready=must(await admin.rpc("prepare_spin_attempt",{p_attempt:request,p_token:creator.token,p_request_hash:binding}),"prepare runtime spin");
  if(ready.status!=="ready")throw Error(`runtime spin not ready: ${ready.status}`);
  const c=ready.context,p=c.prizes.find(p=>p.id===creator.prizeId),hh=c.happyHourMultiplier??1;
  const snapshot={v:3,rules:"focus-v1",game:"wheel",prizes:c.prizes.filter(p=>p.stock==null||p.stock>0).map(p=>({id:p.id,label:p.label,emoji:p.emoji,rarity:p.rarity,w:Math.round(p.weight*(["rare","epic","legendary"].includes(p.rarity)?hh:1)),baseW:p.weight})).sort((a,b)=>a.id.localeCompare(b.id)),modifiers:{happyHour:{multiplier:hh},pity:{counter:c.pityCounter,threshold:10},focus:null,chase:null}};
  const nextSeed=randomUUID().replaceAll("-","").repeat(2);
  const spin={id:request,creator_id:c.creatorId,fan_id:c.fanId,fan_pass_id:c.passId,wheel_id:c.wheelId,campaign_id:c.campaignId,prize_id:p.id,prize_label:p.label,prize_rarity:p.rarity,prize_image_url:p.image_url,server_seed:c.serverSeed,server_seed_hash:c.serverSeedHash,nonce:c.nonce,client_seed:"runtime",fair_version:3,pool_snapshot:snapshot,pool_hash:sha(canonicalProof(snapshot)),fair_trace:{excluded:[],won:p.id},next_pity_counter:["rare","epic","legendary"].includes(p.rarity)?0:c.pityCounter+1,focus_consumed:false,chase_consumed:false,chase_completed:false,next_focus_spins_left:null,next_chase_counter:null,response_prize:{id:p.id,label:p.label,rarity:p.rarity,weight:p.weight},response_prize_index:c.prizes.findIndex(x=>x.id===p.id),response_show_stock:c.wheel.show_stock===true};
  const result=must(await admin.rpc("commit_spin_attempt",{p_attempt:request,p_token:creator.token,p_request_hash:binding,p_context:{contextHash:c.contextHash},p_spin:spin,p_expected_reward:expected,p_next_seed:{seed:nextSeed,hash:sha(nextSeed)}}),"commit runtime spin");
  if(result.status!=="committed")throw Error(`runtime spin refused: ${result.status}`);
  // This synthetic fixture's initial delivery is an explicit value disclosure,
  // matching the application's post-decryption logging boundary.
  if(expected.delivery!=="manual"){
    const logged=await admin.rpc("record_fan_reward_views",{p_spins:[request],p_token:creator.token});
    if(logged.error||logged.data!==1)throw Error("runtime instant disclosure was not logged");
  }
  return {request,binding,result};
}

async function signedClient(email) {
  const c = createClient(URL_, ANON, { auth: { autoRefreshToken: false, persistSession: false } });
  const { error } = await c.auth.signInWithPassword({ email, password: PW });
  if (error) throw error;
  return c;
}

// The pending-only index intentionally allows immutable historical rows.
// Seed only this run's existing pending fixture instead of relying on the old
// global (org_id,email) upsert constraint.
async function seedPendingInvite(orgId,email) {
  const prior=await admin.from("org_invites").select("id").eq("org_id",orgId).eq("email",email).eq("status","pending").maybeSingle();
  if(prior.error)throw Error("pending invite fixture lookup failed");
  return prior.data ?? must(await admin.from("org_invites").insert({org_id:orgId,email,status:"pending"}).select("id").single(),"seed pending invite");
}

async function main() {
  let cleanupFailed = false;
  try {
    await sweepStaleUsers();

    // 0067: schema_version() names the migration level the hosted project was
    // built to. The expectations below are written for the newest migration
    // file, so a TEST that is behind (or ahead) fails here, before its first
    // retired call. Service-role only (0068 and 0069 re-state the grant).
    const expectedSchema = Math.max(...readdirSync(new URL("../../supabase/migrations/", import.meta.url)).filter((f) => /^\d{4}_.*\.sql$/.test(f)).map((f) => Number(f.slice(0, 4))));
    const schema = await admin.rpc("schema_version");
    if (schema.error || schema.data !== expectedSchema) throw new Error(`schema_version(): TEST reports ${schema.error?.message ?? schema.data}, the migration files expect ${expectedSchema}`);
    console.log(`TEST schema_version() = ${schema.data} (the newest migration file).`);
    check((await createClient(URL_, ANON, { auth: { persistSession: false } }).rpc("schema_version")).error?.code === "42501", "anon cannot execute schema_version");

    console.log(`Creating two throwaway creators (run ${RUN})…`);
    const A = await makeCreator("a");
    const B = await makeCreator("b");

    const a = await signedClient(A.email);
    const b = await signedClient(B.email);
    console.log("\nActing as Creator A — asserting isolation from B:");

    // A sees its own rows.
    const ownFans = await a.from("fans").select("id").eq("creator_id", A.id);
    check((ownFans.data?.length ?? 0) === 1, "A can read its OWN fan");

    // Approval is a database boundary. A valid session cannot bypass the
    // review gate by calling PostgREST/RPCs directly after status changes.
    for (const approval of ["pending", "rejected"]) {
      must(await admin.from("profiles").update({ approval_status: approval }).eq("id", A.id).select("id").single(), "set A approval fixture");
      try {
        const noWheel = await a.from("wheels").insert({ creator_id: A.id, title: "unapproved write" }).select("id");
        check(!!noWheel.error && (noWheel.data?.length ?? 0) === 0, `${approval} approval prevents own wheel writes`);
        const noEdit = await a.from("wheels").update({ title: "unapproved edit" }).eq("id", A.wheelId).select("id");
        check((noEdit.data?.length ?? 0) === 0, `${approval} approval prevents own wheel edits`);
        const noPush = await a.from("push_subscriptions").insert({ user_id: A.id, endpoint: `https://fcm.googleapis.com/fcm/send/approval-${RUN}-${approval}`, p256dh: "key", auth: "auth" }).select("id");
        check(!!noPush.error && (noPush.data?.length ?? 0) === 0, `${approval} approval prevents push registration`);
        const noOrg = await a.rpc("org_create", { p_name: "unapproved org" });
        check(!!noOrg.error, `${approval} approval prevents org creation`);
        const noImport = await a.rpc("import_fans", { p_rows: [{ fan_id: randomUUID(), pass_id: randomUUID(), token: `approval-import-${RUN}-${approval}`, wheel_id: A.wheelId, campaign_id: null, name: "unapproved import", spins: 1, amount_cents: 0 }] });
        check(noImport.error?.code==="42501", `${approval} cannot execute the retired import API`);
        const deniedRows=[{name:"Unapproved durable import",spins:1,amountCents:0,campaignId:null,wheelId:A.wheelId,error:null}];
        const noDurableImport=await fixtureCreatorRpc(admin,creatorFixtureClients.get(A.id),"import_fans_durable",{p_batch:randomUUID(),p_creator:A.id,p_actor:A.id,p_request_hash:sha(canonicalProof(["fan-import-v1",deniedRows])),p_rows:deniedRows});
        check(!noDurableImport.error&&noDurableImport.data?.status==="unavailable",`${approval} actor cannot import through the durable service gateway`);
        const leakedImport=await admin.from("fans").select("id").eq("creator_id",A.id).eq("display_name","Unapproved durable import");
        check(!leakedImport.error&&leakedImport.data?.length===0,`${approval} durable import denial creates no fan`);
      } finally {
        must(await admin.from("profiles").update({ approval_status: "approved" }).eq("id", A.id).select("id").single(), "restore A approval");
      }
    }
    const approvedAgain = await a.rpc("can_act_for", { target_creator: A.id, perm: "edit_wheel" });
    check(approvedAgain.data === true, "approved creator retains own editing permission");

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
    // 0065: the lifecycle RPCs answer not_found for another creator's game.
    check((await a.rpc("archive_wheel", { p_wheel: B.wheelId })).data === "not_found", "A cannot archive B's wheel through archive_wheel");
    check((await a.rpc("delete_wheel", { p_wheel: B.wheelId })).data === "not_found", "A cannot delete B's wheel through delete_wheel");
    // 0065: a game with play history (A's wheel carries a spin and a link) is
    // never deleted, not even by its owner; it can only be archived.
    check((await a.rpc("delete_wheel", { p_wheel: A.wheelId })).data === "has_history", "0065 delete_wheel refuses a game with play history");
    check(((await admin.from("wheels").select("id").eq("id", A.wheelId)).data?.length ?? 0) === 1, "A's wheel still exists after the refused delete");
    // 0065: a link's own game is written only through set_fan_pass_game, even on
    // A's own link, and no session can delete a redemption (its award cost).
    const pinPatch = await a.from("fan_passes").update({ pinned_wheel_id: A.wheelId }).eq("id", A.passId).select("id");
    check(pinPatch.error?.code === "42501", `A cannot PATCH its own link's game past set_fan_pass_game (${pinPatch.error?.code ?? "accepted"})`);
    const redemptionDelete = await a.from("redemptions").delete().eq("creator_id", A.id).select("id");
    check(redemptionDelete.error?.code === "42501", `A cannot delete its own redemptions (${redemptionDelete.error?.code ?? "accepted"})`);
    // Confirm with the service role that B's rows really are untouched.
    const { data: bFanAfter } = await admin.from("fans").select("display_name").eq("id", B.fanId).maybeSingle();
    check(bFanAfter?.display_name === B.fanName, `B's fan is unchanged (got ${bFanAfter?.display_name})`);
    const { data: bWheelAfter } = await admin.from("wheels").select("id").eq("id", B.wheelId);
    check((bWheelAfter?.length ?? 0) === 1, "B's wheel still exists");

    // 0061: a happy hour may only boost its own creator's game. The RLS
    // with-check refuses a creator session, the BEFORE trigger refuses every
    // role, and a creator's own wheel still accepts one.
    const hhWindow = { starts_at: new Date().toISOString(), ends_at: new Date(Date.now() + 3_600_000).toISOString() };
    const forgedHappyHour = await a.from("happy_hours").insert({ creator_id: A.id, wheel_id: B.wheelId, multiplier: 5, ...hhWindow }).select("id");
    check(!!forgedHappyHour.error && (forgedHappyHour.data?.length ?? 0) === 0, "A cannot attach a happy hour to B's wheel (RLS with-check)");
    const serviceForgedHappyHour = await admin.from("happy_hours").insert({ creator_id: A.id, wheel_id: B.wheelId, multiplier: 5, ...hhWindow }).select("id");
    check(serviceForgedHappyHour.error?.code === "42501", `not even the service role can attach a happy hour to another creator's wheel (got ${serviceForgedHappyHour.error?.code ?? "no error"})`);
    const { data: bHappyHours } = await admin.from("happy_hours").select("id").eq("wheel_id", B.wheelId);
    check((bHappyHours?.length ?? 0) === 0, `B's wheel carries no foreign happy hour (got ${bHappyHours?.length ?? 0})`);
    const ownHappyHour = await a.from("happy_hours").insert({ creator_id: A.id, wheel_id: A.wheelId, multiplier: 2, ...hhWindow }).select("id");
    check(!ownHappyHour.error && (ownHappyHour.data?.length ?? 0) === 1, `A can still schedule a happy hour on its own wheel (${ownHappyHour.error?.message ?? "ok"})`);

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

    // 0064: the safety-report queue is admin(aal2)-only, webhook signing secrets
    // are server-only, hooks are capped, and the queue/inbox RPCs stay inside
    // the caller's tenant and refuse anon.
    const report = must(await admin.from("creator_reports").insert({ creator_id: B.id, fan_id: B.fanId, reason: "Other", detail: "runtime 0064" }).select("id").single(), "seed a report about B");
    check(((await a.from("creator_reports").select("id")).data?.length ?? 0) === 0, "a creator reads no safety reports");
    const selfResolve = await b.from("creator_reports").update({ status: "dismissed", resolution_note: "not me" }).eq("id", report.id).select("id");
    check((selfResolve.data?.length ?? 0) === 0, "the reported creator cannot dismiss its own report");
    const { data: reportAfter } = await admin.from("creator_reports").select("status, resolved_by").eq("id", report.id).maybeSingle();
    check(reportAfter?.status === "open" && reportAfter?.resolved_by === null, `the report is still open and unreviewed (got ${reportAfter?.status})`);
    // 0064: a review is stamped by the database (resolved_at from the row's
    // status change, never from the request) and the pre-0064 statuses are gone.
    check((await admin.from("creator_reports").update({ status: "actioned" }).eq("id", report.id)).error?.code === "23514", "0064 the retired review statuses are refused");
    const dismissed = must(await admin.from("creator_reports").update({ status: "dismissed", resolution_note: "runtime 0064", resolved_at: "2000-01-01T00:00:00Z" }).eq("id", report.id).select("status, resolved_at").single(), "0064 the server dismisses the report");
    check(dismissed.status === "dismissed" && !!dismissed.resolved_at && Date.parse(dismissed.resolved_at) > Date.parse("2001-01-01T00:00:00Z"), `0064 the database stamps resolved_at itself (got ${dismissed.resolved_at})`);
    check(!!(await a.from("webhook_secrets").select("secret")).error, "a creator cannot read webhook_secrets");
    check(!!(await a.from("webhook_secrets").insert({ creator_id: A.id, secret: "a".repeat(64) })).error, "a creator cannot write its own webhook secret");
    for (let i = 0; i < 5; i++) must(await a.from("webhooks").insert({ creator_id: A.id, url: `https://93.184.216.34/rls-${RUN}-${i}`, event: "all" }).select("id").single(), `A's hook ${i + 1}`);
    check(!!(await a.from("webhooks").insert({ creator_id: A.id, url: `https://93.184.216.34/rls-${RUN}-6`, event: "all" })).error, "a sixth webhook is refused");
    check(!!(await a.from("webhooks").insert({ creator_id: B.id, url: `https://93.184.216.34/rls-${RUN}-x`, event: "all" })).error, "A cannot add a webhook to B");
    const aQueue = await a.rpc("creator_redemption_queue", { p_limit: 100 });
    check(!aQueue.error && (aQueue.data ?? []).length > 0 && !(aQueue.data ?? []).some((r) => r.prize_label === "b prize"), "A's fulfilment queue holds its own wins and none of B's");
    const aThreads = await a.rpc("creator_inbox_threads", { p_limit: 100 });
    check(!aThreads.error && !(aThreads.data ?? []).some((t) => t.fan_id === B.fanId), "A's inbox threads hold none of B's fans");
    const anonRpc = createClient(URL_, ANON, { auth: { persistSession: false } });
    check(!!(await anonRpc.rpc("creator_redemption_queue", {})).error, "anon cannot call creator_redemption_queue");
    check(!!(await anonRpc.rpc("creator_inbox_threads", {})).error, "anon cannot call creator_inbox_threads");

    // Non-vacuous own/cross-tenant promise fixtures, using only service RPCs.
    must(await admin.from("prizes").update({boostable:true,stock:1}).eq("id",B.prizeId).select("id").single(),"prepare B boostable finite target");
    must(await admin.from("focus_creator_config").insert({creator_id:B.id,chase_enabled:true}).select("creator_id").single(),"enable chase for disposable B only");
    for(const kind of ["focus","chase"]) {
      const pack=must(await admin.from("campaign_packs").insert({creator_id:B.id,label:`runtime ${kind}`,spins:10,pack_kind:kind,focus_spins:5,chase_within:5}).select("id").single(),`seed ${kind} pack`);
      const granted=must(await fixtureCreatorRpc(admin,creatorFixtureClients.get(B.id),"grant_focus_pack",{p_request:randomUUID(),p_creator:B.id,p_fan:B.fanId,p_pass:B.passId,p_pack:pack.id,p_prize:B.prizeId}),`grant real ${kind} fixture`);
      check(granted.status==="granted",`real ${kind} RPC creates owned metadata`);
      // 0062: cancel_fan_focus(p_context, …) needs the actor's 'grant' context
      // like the grant above; the 4-argument form is retired for every role.
      const released=must(await fixtureCreatorRpc(admin,creatorFixtureClients.get(B.id),"cancel_fan_focus",{p_creator:B.id,p_fan:B.fanId,p_focus:granted.focus.id,p_actor:B.id}),`release ${kind} fixture`);
      check(released.status==="released",`real ${kind} promise is released through the actor-context gateway (got ${released.status})`);
    }
    must(await admin.from("prizes").update({stock:null}).eq("id",B.prizeId).select("id").single(),"restore B unlimited fixture");
    const ownConfig=await b.from("focus_creator_config").select("creator_id").eq("creator_id",B.id);
    check(!ownConfig.error&&ownConfig.data?.length===1,"B reads its server-controlled rollout metadata");
    const otherConfig=await a.from("focus_creator_config").select("creator_id").eq("creator_id",B.id);
    check(!otherConfig.error&&otherConfig.data?.length===0,"A reads no B rollout settings");
    check((await b.from("focus_creator_config").update({chase_enabled:false}).eq("creator_id",B.id)).error?.code==="42501","creator cannot change rollout settings");
    const csvRows=[{name:"CSV runtime",spins:2,amountCents:100,campaignId:null,wheelId:null,error:null}];
    const csv=must(await fixtureCreatorRpc(admin,creatorFixtureClients.get(B.id),"import_fans_durable",{p_batch:randomUUID(),p_creator:B.id,p_request_hash:sha(canonicalProof(["fan-import-v1",csvRows])),p_rows:csvRows}),"seed real durable import metadata");
    check(csv.status==="imported"&&csv.items[0].token,"CSV RPC creates real owned ledger metadata");
    //0059: attempts and promise metadata follow tenant RLS; secret context is
    // never readable by creators. Every external economic RPC is service-only.
    for(const table of ["fan_focus","chase_reservations","spin_attempts","fan_import_batches","fan_import_items","creator_request_journal"]) {
      const cols=table==="fan_import_items"?"batch_id,ordinal":"id";
      const own=await b.from(table).select(cols).eq("creator_id",B.id);
      check(!own.error && own.data?.length>0,`B can read its nonempty ${table} metadata`);
      const cross=await a.from(table).select(cols).eq("creator_id",B.id);
      check(!cross.error && cross.data?.length===0,`A reads none of B's ${table}`);
      const write=await a.from(table).insert({creator_id:A.id});
      check(write.error?.code==="42501",`creator cannot directly insert ${table}`);
      const anonRead=await createClient(URL_,ANON,{auth:{persistSession:false}}).from(table).select(cols);
      check(!!anonRead.error || anonRead.data?.length===0,`anon cannot read ${table}`);
    }
    check(!!(await a.from("spin_attempts").select("context,result,token_hash,request_hash")).error,"attempt future-seed context/bindings remain server-only");
    check(!!(await a.from("creator_request_journal").select("request_hash,grant_id,batch_id")).error,"creator journal private bindings remain server-only");
    check(!!(await a.from("fan_import_batches").select("request_hash")).error,"CSV raw-content hash stays server-only");
    check(!!(await a.from("fan_passes").select("next_server_seed")).error,"unrevealed next seed is not creator-readable");
    const actorFence=must(await fixtureCreatorRpc(admin,creatorFixtureClients.get(B.id),"reconcile_creator_request",{p_request:randomUUID(),p_creator:null,p_actor:B.id,p_kind:"pass",p_cancel:true,p_authorized:false}),"record B actor cancellation fence");
    check(actorFence.status==="cancelled","a signed actor can withdraw an opaque own intent without guessing its target");
    const ownFences=await b.from("actor_request_cancellations").select("id").eq("actor_id",B.id);
    const otherFences=await a.from("actor_request_cancellations").select("id").eq("actor_id",B.id);
    check(!ownFences.error&&ownFences.data?.length>0,"B reads its own actor fence metadata");
    check(!otherFences.error&&otherFences.data?.length===0,"A cannot read B actor fence metadata");
    check((await a.from("actor_request_cancellations").insert({actor_id:A.id,id:randomUUID(),kind:"pass"})).error?.code==="42501","creator cannot directly write cancellation fences");
    const anonFences=await createClient(URL_,ANON,{auth:{persistSession:false}}).from("actor_request_cancellations").select("id");
    check(!!anonFences.error||anonFences.data?.length===0,"anon cannot read cancellation fences");
    const binding={p_attempt:randomUUID(),p_token:B.token,p_request_hash:sha("denial")};
    for(const [fn,args] of [
      ["record_fan_reward_views",{p_spins:[randomUUID()],p_token:B.token}],
      ["prepare_spin_attempt",binding],["get_spin_attempt_status",binding],["cancel_spin_attempt",{...binding,p_error:"no_prizes"}],
      ["commit_spin_attempt",{...binding,p_context:{},p_spin:{},p_expected_reward:{},p_next_seed:{}}],
      ["grant_focus_pack",{p_request:randomUUID(),p_creator:B.id,p_fan:B.fanId,p_pass:B.passId,p_pack:randomUUID(),p_prize:B.prizeId}],
      ["cancel_fan_focus",{p_creator:B.id,p_fan:B.fanId,p_focus:randomUUID()}],
      ["cancel_fan_focus",{p_creator:B.id,p_fan:B.fanId,p_focus:randomUUID(),p_actor:A.id}],["get_fan_focus_state",{p_token:B.token}],
      ["grant_pass_spins",{p_request:randomUUID(),p_creator:B.id,p_fan:B.fanId,p_pass:B.passId,p_spins:1,p_bonus:0,p_amount:0}],
      ["edit_pass_grant",{p_creator:B.id,p_grant:randomUUID(),p_spins:1,p_bonus:0,p_amount:0}],
      ["edit_pass_grant",{p_request:randomUUID(),p_creator:B.id,p_grant:randomUUID(),p_patch:{spins:1},p_actor:A.id}],
      ["create_pass_grant",{p_request:randomUUID(),p_creator:B.id,p_fan:B.fanId,p_wheel:B.wheelId,p_name:"forged",p_spins:1,p_bonus:0,p_amount:0,p_campaign:null}],
      ["award_fan_referral",{p_creator:B.id,p_fan:B.fanId}],["ensure_pass_commitment",{p_token:B.token}],
      ["import_fans_durable",{p_batch:randomUUID(),p_creator:B.id,p_request_hash:sha("denial"),p_rows:[]}],
      ["reconcile_creator_request",{p_request:B.requestId,p_creator:B.id,p_actor:B.id,p_kind:"pass",p_cancel:false,p_authorized:true}],
      // 0065: the atomic first-admin bootstrap and the per-link game pin are service-only.
      ["bootstrap_first_admin",{p_user:A.id,p_email:"a@example.test"}],
      ["set_fan_pass_game",{p_context:randomUUID(),p_creator:B.id,p_pass:B.passId,p_wheel:B.wheelId,p_actor:A.id}],
    ]) {
      check((await a.rpc(fn,args)).error?.code==="42501",`authenticated cannot execute ${fn}`);
      check((await createClient(URL_,ANON,{auth:{persistSession:false}}).rpc(fn,args)).error?.code==="42501",`anon cannot execute ${fn}`);
    }
    for(const [fn,args] of [["import_fans",{p_rows:[]}],["claim_spin",{p_token:B.token}],["credit_pass_spins",{p_fan_id:B.fanId,p_spins:1}],["finalize_reward_spin",{p_spin:{},p_expected:{}}],["reserve_reward_code",{p_prize:B.prizeId,p_spin:randomUUID()}],["release_reward_code",{p_spin:randomUUID()}]])check(!!(await admin.rpc(fn,args)).error,`service cannot execute retired ${fn}`);
    check((await admin.rpc("edit_pass_grant",{p_creator:B.id,p_grant:randomUUID(),p_spins:1,p_bonus:0,p_amount:0})).error?.code==="42501","service cannot bypass edit journal through retired positional API");
    check((await admin.rpc("cancel_fan_focus",{p_creator:B.id,p_fan:B.fanId,p_focus:randomUUID()})).error?.code==="42501","service cannot release promises through retired actorless cancellation API");
    // 0062 retired every pre-context creator gateway for the service role too
    // (the service JWT is never actor assurance); 0066 retired the last
    // pre-0059 spin RPC. Each call names exactly the old signature.
    for(const [fn,args] of [
      ["cancel_fan_focus",{p_creator:B.id,p_fan:B.fanId,p_focus:randomUUID(),p_actor:B.id}],
      ["grant_focus_pack",{p_request:randomUUID(),p_creator:B.id,p_fan:B.fanId,p_pass:B.passId,p_pack:randomUUID(),p_prize:B.prizeId}],
      ["grant_pass_spins",{p_request:randomUUID(),p_creator:B.id,p_fan:B.fanId,p_pass:B.passId,p_spins:1,p_bonus:0,p_amount:0}],
      ["create_pass_grant",{p_request:randomUUID(),p_creator:B.id,p_fan:B.fanId,p_wheel:B.wheelId,p_name:"forged",p_spins:1,p_bonus:0,p_amount:0,p_campaign:null}],
      ["edit_pass_grant",{p_request:randomUUID(),p_creator:B.id,p_grant:randomUUID(),p_patch:{spins:1},p_actor:B.id}],
      ["import_fans_durable",{p_batch:randomUUID(),p_creator:B.id,p_request_hash:sha("denial"),p_rows:[]}],
      ["reconcile_creator_request",{p_request:randomUUID(),p_creator:B.id,p_actor:B.id,p_kind:"pass",p_cancel:false,p_authorized:false}],
      ["save_game_wheel",{p_wheel:B.wheelId,p_creator:B.id,p_prizes:[],p_config:{},p_actor:B.id}],
      ["rollback_claimed_spin",{p_token:B.token,p_prize_id:B.prizeId}],
    ])check((await admin.rpc(fn,args)).error?.code==="42501",`service cannot execute the pre-0062 ${fn} signature`);
    check((await a.rpc("import_fans",{p_rows:[]})).error?.code==="42501","authenticated cannot bypass durable imports through the legacy API");
    check((await createClient(URL_,ANON,{auth:{persistSession:false}}).rpc("import_fans",{p_rows:[]})).error?.code==="42501","anon cannot bypass durable imports through the legacy API");

    //0060: feature metadata comes from server-owned profiles. Exercise real
    // table writes so create/duplicate/template/import cannot bypass the gate.
    const originalGameFeatures=must(await admin.from("profiles").select("features").eq("id",B.id).single(),"read disposable B feature state").features;
    const setBGameFeatures=async scratch=>must(await admin.from("profiles").update({features:{...originalGameFeatures,wheel:true,scratch,bingo:true}}).eq("id",B.id).select("id").single(),"set disposable B game feature");
    await setBGameFeatures(false);
    const scratchSettings={creator_id:B.id,title:"runtime scratch",game_kind:"scratch",game_config:{style:"classic"},game_ready:true};
    check((await b.from("wheels").insert(scratchSettings)).error?.code==="42501","B cannot create scratch while its server feature is disabled");
    check((await admin.from("wheels").insert(scratchSettings)).error?.code==="42501","service cannot bypass disabled scratch feature by direct insertion");
    check((await b.from("wheel_templates").insert({creator_id:B.id,name:"disabled scratch template",game_kind:"scratch",game_config:{style:"classic"}})).error?.code==="42501","template/import metadata cannot bypass disabled scratch feature");
    const selfFeature=await b.from("profiles").update({features:{wheel:true,scratch:true,bingo:true}}).eq("id",B.id).select("id");
    check(!selfFeature.data?.length,"creator cannot self-enable game feature flags");
    await setBGameFeatures(true);
    const scratchWheel=must(await b.from("wheels").insert(scratchSettings).select("id,game_kind").single(),"B creates feature-enabled scratch game");
    check(scratchWheel.game_kind==="scratch","approved enabled B creates an actual scratch metadata row");
    const ownScratch=await b.from("wheels").select("id,game_kind").eq("id",scratchWheel.id);
    const otherScratch=await a.from("wheels").select("id,game_kind").eq("id",scratchWheel.id);
    check(!ownScratch.error&&ownScratch.data?.length===1,"B reads its own nonempty scratch metadata");
    check(!otherScratch.error&&otherScratch.data?.length===0,"A reads no B scratch metadata");
    check((await a.from("wheels").insert(scratchSettings)).error?.code==="42501","A cannot create scratch for another creator even when that creator is enabled");
    check(!!(await createClient(URL_,ANON,{auth:{persistSession:false}}).from("wheels").insert(scratchSettings)).error,"anon cannot create scratch games");
    check((await b.from("wheels").insert({...scratchSettings,game_config:{style:"classic",secret:"not allowed"}})).error?.code==="22023","extra game configuration fields are refused");
    check((await admin.from("wheels").insert({...scratchSettings,game_kind:"bingo",game_config:{size:3,linePrizeId:B.prizeId}})).error?.code==="22023","unconfigured Bingo cannot publish even if its feature flag is true");
    check((await b.from("wheels").update({game_kind:"scratch",game_config:{style:"classic"}}).eq("id",B.wheelId)).error?.code==="22023","first credited play locks game kind against direct table conversion");
    await setBGameFeatures(false);
    must(await b.from("wheels").update({title:"grandfathered scratch",game_config:{style:"classic"}}).eq("id",scratchWheel.id).select("id").single(),"same-kind scratch metadata survives feature removal");
    check((await admin.from("wheels").insert({...scratchSettings,title:"duplicate existing scratch"})).error?.code==="42501","duplicating grandfathered scratch cannot mint a disabled new game");
    for(const client of [a,createClient(URL_,ANON,{auth:{persistSession:false}}),admin]){
      check((await client.rpc("_game_feature_allowed",{p_creator:B.id,p_kind:"scratch"})).error?.code==="42501","API roles cannot execute the private game permission helper");
      // 0065: the pin-aware ranking helper is private like its 0061 form.
      check((await client.rpc("_creator_default_wheel",{p_creator:B.id,p_campaign:null,p_pinned:B.wheelId})).error?.code==="42501","API roles cannot execute the private game resolver");
    }
    must(await admin.from("profiles").update({features:originalGameFeatures}).eq("id",B.id).select("id").single(),"restore disposable B features");

    await testBingoRuntime({admin,a,anonymous:createClient(URL_,ANON,{auth:{persistSession:false}}),actorA:A.id,makeUser,signedClient,must,check});

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
    await testOperationalIntegrityRuntime({ a, anonymous: anonClient, check });
    const anonIcon = await anonClient.rpc("set_pwa_icon_mode", { p_mode: "avatar" });
    check(!!anonIcon.error, "anon cannot execute set_pwa_icon_mode");

    // RM-6 (0049): the fan's break. The server (service role) starts it from
    // the fan's link token; nobody can shorten it; a creator can't touch it.
    console.log("\nRM-6: a fan's break");
    const DAY = 86_400_000;
    const inDays = (d) => new Date(Date.now() + d * DAY).toISOString();
    const took = await admin.rpc("fan_take_break", { p_token: A.token, p_until: inDays(7) });
    check(!took.error && typeof took.data === "string", `the server starts A's fan's break (${took.error?.message ?? "ok"})`);
    const refused = await admin.rpc("prepare_spin_attempt", {p_attempt:randomUUID(),p_token:A.token,p_request_hash:sha("runtime-break")});
    check(!refused.error && refused.data?.status==="declined" && refused.data?.error==="on_break", "atomic spin preparation refuses a fan on a break without debit");
    const other = await recordRuntimeSpin(B);
    check(other.result.status==="committed", "B's fan without a break still commits a fully atomic spin");
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
    // 0068: a scoped seat sees no e-mail or revenue; the owner still does.
    check((sStats.data ?? []).every((r) => r.email === null && r.revenue === null), "0068 the chatter seat's org stats carry no e-mail or revenue");
    const ownStats = await (await signedClient(OWN.email)).rpc("org_account_stats", { p_org: org.id });
    check(!ownStats.error && ownStats.data?.length === 2, `the org owner's stats list both of its creators (${ownStats.error?.message ?? `got ${ownStats.data?.length}`})`);
    check((ownStats.data ?? []).every((r) => r.email === A.email || r.email === C.email), "0068 the owner's org stats still carry its creators' e-mail");
    const sPromote = await s.from("org_members").update({ role: "owner" }).eq("id", seat.id).select("id");
    check((sPromote.data?.length ?? 0) === 0, "the seat cannot promote its own seat");
    const sScope = await s.from("org_member_creators").insert({ member_id: seat.id, creator_id: B.id }).select("member_id");
    check(!!sScope.error || (sScope.data?.length ?? 0) === 0, "the seat cannot widen its own scope");

    // An existing seat and a valid JWT do not override approval of either
    // the caller or the target creator. Restore every fixture before proceeding.
    for (const approval of ["pending", "rejected"]) {
      must(await admin.from("profiles").update({ approval_status: approval }).eq("id", SEAT.id).select("id").single(), "set seat approval fixture");
      try {
        const noSeatFans = await s.from("fans").select("id").eq("creator_id", A.id);
        check((noSeatFans.data?.length ?? 0) === 0, `${approval} approval prevents seat access`);
        const noSeatChat = await s.rpc("can_act_for", { target_creator: A.id, perm: "chat" });
        check(noSeatChat.data === false, `${approval} approval prevents seat chat permission`);
      } finally {
        must(await admin.from("profiles").update({ approval_status: "approved" }).eq("id", SEAT.id).select("id").single(), "restore seat approval");
      }
      must(await admin.from("profiles").update({ approval_status: approval }).eq("id", A.id).select("id").single(), "set target approval fixture");
      try {
        const noTarget = await s.from("fans").select("id").eq("creator_id", A.id);
        check((noTarget.data?.length ?? 0) === 0, `${approval} approval prevents access to an unapproved target`);
      } finally {
        must(await admin.from("profiles").update({ approval_status: "approved" }).eq("id", A.id).select("id").single(), "restore target approval");
      }
      const inv = await seedPendingInvite(org.id,B.email);
      must(await admin.from("profiles").update({ approval_status: approval }).eq("id", B.id).select("id").single(), "set invitee approval fixture");
      try {
        const noAccept = await b.rpc("org_invite_respond", { p_invite: inv.id, p_accept: true });
        check(noAccept.data === "inactive", `${approval} approval prevents invitation acceptance`);
        const noDecline = await b.rpc("org_invite_respond", { p_invite: inv.id, p_accept: false });
        check(noDecline.data === "inactive", `${approval} approval prevents invitation changes`);
      } finally {
        must(await admin.from("profiles").update({ approval_status: "approved", org_id: null }).eq("id", B.id).select("id").single(), "restore invitee approval");
      }
    }
    const seatRestored = await s.rpc("can_act_for", { target_creator: A.id, perm: "chat" });
    check(seatRestored.data === true, "approved scoped seat retains rightful chat permission");

    // Delegated agency access fails closed when the agency's owner loses
    // approval/activity, even if this seat remains approved and signed in.
    for (const state of ["pending", "rejected", "suspended"]) {
      must(await admin.from("profiles").update({ approval_status: state === "suspended" ? "approved" : state, is_active: state !== "suspended" }).eq("id", OWN.id).select("id").single(), "set agency owner eligibility fixture");
      try {
        const noOwnerFans = await s.from("fans").select("id").eq("creator_id", A.id);
        check((noOwnerFans.data?.length ?? 0) === 0, `${state} agency owner prevents delegated seat access`);
        const noOwnerChat = await s.rpc("can_act_for", { target_creator: A.id, perm: "chat" });
        check(noOwnerChat.data === false, `${state} agency owner prevents delegated chat permission`);
        const ownerInv = await seedPendingInvite(org.id,B.email);
        const noOwnerAccept = await b.rpc("org_invite_respond", { p_invite: ownerInv.id, p_accept: true });
        check(noOwnerAccept.data === "inactive", `${state} agency owner prevents invitation acceptance`);
      } finally {
        must(await admin.from("profiles").update({ approval_status: "approved", is_active: true }).eq("id", OWN.id).select("id").single(), "restore agency owner eligibility");
      }
    }
    const ownerRestoredSeat = await s.rpc("can_act_for", { target_creator: A.id, perm: "chat" });
    check(ownerRestoredSeat.data === true, "eligible agency owner restores rightful scoped seat access");

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
      // 0062 keeps the last active admin: this needs another active admin on
      // TEST, and a silent failure would leave A an admin for cleanup to trip on.
      must(await admin.from("profiles").update({ role: "creator" }).eq("id", A.id).select("id").single(), "demote A after the aal1 check");
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

    // Instant reward metadata is tenant-scoped; values and fingerprints remain server-only.
    {
      const rewardPrize = must(await admin.from("prizes").select("id").eq("wheel_id", B.wheelId).limit(1).single(), "B reward prize");
      must(await admin.from("prize_rewards").insert({prize_id: rewardPrize.id, creator_id:B.id, kind:"text", cipher:"runtime-cipher", iv:"runtime-iv"}).select("prize_id").single(), "B encrypted reward");
      const ownerMetadata = await b.from("prize_rewards").select("prize_id, kind").eq("prize_id",rewardPrize.id);
      check(!ownerMetadata.error && ownerMetadata.data?.length===1,"B reads own reward metadata");
      const crossMetadata = await a.from("prize_rewards").select("prize_id, kind").eq("prize_id",rewardPrize.id);
      check(!crossMetadata.error && crossMetadata.data?.length===0,"A reads none of B's reward metadata");
      for(const table of ["prize_rewards","prize_reward_codes","spin_rewards"]) {
        const secret = await a.from(table).select("cipher, iv");
        check(!!secret.error,`creator cannot select ciphertext or IV from ${table}`);
        const anonymous = await anonClient.from(table).select("*");
        check(!!anonymous.error || anonymous.data?.length===0,`anon cannot read ${table}`);
      }
      check(!!(await admin.rpc("scrub_fan_reward_values",{p_fan:B.fanId})).error,"even the service API cannot invoke the trigger-only erasure helper");
      const fingerprint = await a.from("prize_reward_codes").select("fingerprint");
      check(!!fingerprint.error,"code fingerprints are not creator-readable");
      const forged = await a.from("prize_rewards").insert({prize_id:rewardPrize.id,creator_id:A.id,kind:"text",cipher:"forged",iv:"x"});
      check(!!forged.error,"A cannot insert a forged reward onto B's prize");
      for(const [fn,args] of [
        ["finalize_reward_spin",{p_spin:{},p_expected:{}}],
        ["save_wheel_prizes",{p_wheel:B.wheelId,p_creator:B.id,p_prizes:[]}],
        ["scrub_fan_reward_values",{p_fan:B.fanId}],
        ["reserve_reward_code",{p_prize:rewardPrize.id,p_spin:randomUUID()}],
        ["release_reward_code",{p_spin:randomUUID()}],
        ["record_reward_view",{p_spin:randomUUID()}],
        ["record_fan_reward_view",{p_spin:randomUUID(),p_token:B.token}],
        ["add_reward_codes",{p_prize:rewardPrize.id,p_creator:B.id,p_codes:[]}],
        ["set_prize_delivery",{p_prize:rewardPrize.id,p_creator:B.id,p_kind:"manual"}],
      ]) {
        check(!!(await a.rpc(fn,args)).error,`creator cannot execute ${fn}`);
        check(!!(await anonClient.rpc(fn,args)).error,`anon cannot execute ${fn}`);
      }
      const erasedFingerprint=createHash("sha256").update(`erase-${RUN}`).digest("hex");
      const encryptedCode={cipher:"runtime-code",iv:"runtime-code-iv",key_version:1,hint:"1234",fingerprint:erasedFingerprint};
      must(await admin.rpc("add_reward_codes",{p_prize:rewardPrize.id,p_creator:B.id,p_codes:[encryptedCode]}),"seed delivered erasure code");
      const candidate=must(await admin.from("prize_reward_codes").select("id,cipher,iv,key_version").eq("prize_id",rewardPrize.id).is("spin_id",null).single(),"erasure code candidate");
      const erasure=await recordRuntimeSpin(B,{delivery:"codes",codeId:candidate.id,cipher:candidate.cipher,iv:candidate.iv,keyVersion:candidate.key_version});
      const erasureSpin=erasure.request;
      check(erasure.result.status==="committed","erasure fixture records a real atomic instant win");
      const beforeErase=await admin.from("spins").select("id").eq("creator_id",B.id);
      must(await admin.from("fans").delete().eq("id",B.fanId).select("id"),"delete reward fan");
      const afterErase=await admin.from("spins").select("id").eq("creator_id",B.id);
      check(!afterErase.error && afterErase.data?.length===beforeErase.data?.length,"fan erasure retains financial spin rows");
      const receipt=must(await admin.from("spin_rewards").select("kind,cipher,iv,erased_at,views").eq("spin_id",erasureSpin).single(),"retained anonymous receipt");
      check(receipt.kind==="code" && receipt.cipher===null && receipt.iv===null && receipt.erased_at && receipt.views===1,"fan deletion erases delivered values but retains anonymous Auto metadata");
      const tombstone=must(await admin.from("prize_reward_codes").select("cipher,iv,hint,fingerprint,erased_at,spin_id").eq("id",candidate.id).single(),"consumed code tombstone");
      check(tombstone.cipher===null && tombstone.iv===null && tombstone.hint===null && tombstone.erased_at && tombstone.fingerprint===erasedFingerprint && tombstone.spin_id===erasureSpin,"erasure keeps only the consumed fingerprint and no coupon value");
      const repeated=await admin.rpc("add_reward_codes",{p_prize:rewardPrize.id,p_creator:B.id,p_codes:[encryptedCode]});
      check(!repeated.error && repeated.data===0,"re-uploading an erased delivered coupon cannot restock it");
      const erasedIntent=must(await fixtureCreatorRpc(admin,creatorFixtureClients.get(B.id),"reconcile_creator_request",{p_request:B.requestId,p_creator:B.id,p_actor:B.id,p_kind:"pass",p_authorized:true}),"reconcile erased creator intent");
      check(erasedIntent.status==="gone"&&!erasedIntent.receipt,"erased fan leaves a terminal creator receipt without resurrecting a link");
      const lateCreate=must(await fixtureCreatorRpc(admin,creatorFixtureClients.get(B.id),"create_pass_grant",{p_request:B.requestId,p_creator:B.id,p_fan:B.fanId,p_wheel:B.wheelId,p_name:"b fan",p_spins:5,p_bonus:0,p_amount:1000,p_campaign:null,p_actor:B.id}),"late erased creator replay");
      check(lateCreate.status==="gone","late same-key bootstrap refuses to recreate an erased fan");
    }
    //0058: metadata-only fixtures. Never creates, lists or removes Storage bytes.
    // All no-FK work rows are scoped to this run's disposable creators and
    // explicitly deleted in finally before their Auth users are removed.
    console.log("\n0058 theme/media + durable work isolation…");
    must(await admin.from("profiles").update({is_active:true,approval_status:"approved"}).in("id",[A.id,B.id]).select("id"),"eligible0058 creators");
    const mediaA=randomUUID(),mediaB=randomUUID(),objectA=randomUUID(),objectB=randomUUID(),dispatchA=randomUUID(),dispatchB=randomUUID();
    const objectPath=(owner,id)=>`${owner}/${id}.webp`;
    must(await admin.from("creator_media").insert([
      {id:mediaA,creator_id:A.id,path:objectPath(A.id,mediaA),width:1,height:1,sfw_attested_at:new Date().toISOString()},
      {id:mediaB,creator_id:B.id,path:objectPath(B.id,mediaB),width:1,height:1,sfw_attested_at:new Date().toISOString()},
    ]).select("id"),"0058 own/foreign media metadata");
    for(const [owner,id] of [[A.id,objectA],[B.id,objectB]]) {
      must(await admin.rpc("creator_storage_register_upload",{p_id:id,p_owner:owner,p_bucket:"avatars",p_path:objectPath(owner,id)}),"0058 durable upload metadata");
    }
    must(await admin.from("creator_storage_deletions").insert([A.id,B.id].map(owner=>({owner_id:owner,state:"paused",was_role:"creator",was_active:true,actor_id:owner,action:"account.self_close",link_hashes:[]}))).select("owner_id"),"0058 retained deletion metadata");
    must(await admin.from("creator_storage_dispatches").insert([
      {id:dispatchA,owner_id:A.id,attempt_id:randomUUID(),kind:"auth"},
      {id:dispatchB,owner_id:B.id,attempt_id:randomUUID(),kind:"auth"},
    ]).select("id"),"0058 dispatch metadata");
    const ownMedia=await a.from("creator_media").select("id").eq("id",mediaA);
    check(!ownMedia.error&&ownMedia.data?.length===1,"0058 A reads own media metadata");
    const foreignMedia=await a.from("creator_media").select("id").eq("id",mediaB);
    check(!foreignMedia.error&&foreignMedia.data?.length===0,"0058 A cannot read B media metadata");
    const anonMedia=await anonClient.from("creator_media").select("id").in("id",[mediaA,mediaB]);
    check(!!anonMedia.error||anonMedia.data?.length===0,"0058 anon cannot read private media metadata");
    check(!!(await a.from("creator_media").insert({creator_id:B.id,path:objectPath(B.id,randomUUID()),width:1,height:1,sfw_attested_at:new Date().toISOString()})).error,"0058 creator cannot forge a media insert");
    check(!!(await a.from("creator_media").update({path:objectPath(A.id,randomUUID())}).eq("id",mediaA)).error,"0058 creator cannot rewrite media paths");
    const captionOwn=await a.from("creator_media").update({caption:"own0058"}).eq("id",mediaA).select("id");
    check(!captionOwn.error&&captionOwn.data?.length===1,"0058 approved creator can edit own caption");
    const captionForeign=await a.from("creator_media").update({caption:"foreign0058"}).eq("id",mediaB).select("id");
    check(captionForeign.data?.length===0,"0058 creator cannot edit another media caption");
    check(!!(await a.from("creator_media").delete().eq("id",mediaA)).error,"0058 direct media DELETE cannot discard durable retry references");
    const ownTheme=await a.rpc("set_creator_theme",{p_theme:{font:"syne",background:"photo",bg_media_id:mediaA}});
    check(!ownTheme.error&&ownTheme.data?.bg_media_id===mediaA,"0058 creator may select own background photo");
    check(!!(await a.rpc("set_creator_theme",{p_theme:{font:"syne",background:"photo",bg_media_id:mediaB}})).error,"0058 creator cannot select another creator's photo");
    check(!!(await a.rpc("set_creator_theme",{p_theme:{font:"url(https://example.invalid)"}})).error,"0058 arbitrary CSS is refused");
    check(!!(await anonClient.rpc("set_creator_theme",{p_theme:{font:"syne"}})).error,"0058 anon cannot set a theme");
    for(const status of ["pending","rejected"]) {
      must(await admin.from("profiles").update({approval_status:status}).eq("id",A.id).select("id"),"0058 approval refusal fixture");
      try {
        const deniedTheme=await a.rpc("set_creator_theme",{p_theme:{font:"playfair"}});
        check(deniedTheme.error||deniedTheme.data===null,`0058 ${status} creator cannot change theme`);
        const deniedCaption=await a.from("creator_media").update({caption:"unapproved"}).eq("id",mediaA).select("id");
        check(deniedCaption.data?.length===0,`0058 ${status} creator cannot edit media`);
      } finally {must(await admin.from("profiles").update({approval_status:"approved"}).eq("id",A.id).select("id"),"restore0058 approval");}
    }
    for(const [table,ownId,foreignId,key,payload] of [
      ["creator_storage_objects",objectA,objectB,"id",{id:randomUUID(),owner_id:B.id,bucket:"avatars",path:objectPath(B.id,randomUUID()),upload_state:"stored"}],
      ["creator_storage_deletions",A.id,B.id,"owner_id",{owner_id:randomUUID(),state:"paused",was_role:"creator",was_active:true,action:"account.self_close"}],
      ["creator_storage_dispatches",dispatchA,dispatchB,"id",{id:randomUUID(),owner_id:B.id,attempt_id:randomUUID(),kind:"auth"}],
    ]) {
      const own=await a.from(table).select(key).eq(key,ownId),foreign=await a.from(table).select(key).eq(key,foreignId),anonymous=await anonClient.from(table).select(key).in(key,[ownId,foreignId]);
      check(!own.error&&own.data?.length===1,`0058 creator reads own ${table}`);
      check(!foreign.error&&foreign.data?.length===0,`0058 creator reads none of another owner ${table}`);
      check(!!anonymous.error||anonymous.data?.length===0,`0058 anon cannot read ${table}`);
      check(!!(await a.from(table).insert(payload)).error,`0058 creator cannot insert ${table}`);
      check(!!(await a.from(table).update({owner_id:B.id}).eq(key,ownId)).error,`0058 creator cannot mutate ${table}`);
      check(!!(await a.from(table).delete().eq(key,ownId)).error,`0058 creator cannot delete ${table}`);
      if(table==="creator_storage_deletions") check(!!(await a.from(table).update({restore_allowed:true}).eq(key,ownId)).error,"0058 creator cannot re-arm a restoration fence");
    }
    for(const [fn,args] of [
      ["creator_storage_register_upload",{p_id:randomUUID(),p_owner:B.id,p_bucket:"avatars",p_path:objectPath(B.id,randomUUID())}],
      ["creator_storage_finish_upload",{p_id:objectB,p_outcome:"publish"}],
      ["creator_storage_queue_remove",{p_owner:B.id,p_objects:[{id:mediaB,path:objectPath(B.id,mediaB)}],p_actor:A.id,p_admin:true}],
      ["creator_storage_complete_remove",{p_id:objectB}],
      ["creator_storage_account",{p_operation:"begin",p_owner:B.id,p_actor:A.id,p_action:"account.delete"}],
      ["creator_storage_prune",{p_days:1}],
      ["creator_storage_manifest",{p_owner:B.id,p_attempt:randomUUID(),p_worker:randomUUID(),p_bucket:"avatars",p_paths:[objectPath(B.id,objectB)]}],
      ["creator_storage_dispatch",{p_operation:"begin",p_id:randomUUID(),p_owner:B.id,p_kind:"remove",p_object:objectB}],
      ["creator_storage_publish_media",{p_id:objectB,p_caption:"forged",p_width:1,p_height:1}],
      ["creator_storage_work_claim",{p_limit:20}],
    ]) for(const [role,client] of [["creator",a],["anon",anonClient]]) {
      const denied=await client.rpc(fn,args);
      check(denied.error?.code==="42501",`0058 ${role} has no EXECUTE privilege on ${fn}`);
    }
    const retainedB=must(await admin.from("creator_media").select("caption,path").eq("id",mediaB).single(),"0058 foreign row remains");
    check(retainedB.caption===null&&retainedB.path===objectPath(B.id,mediaB),"0058 foreign media remains unchanged after all forged calls");

    // The 0052 fixture above left the agency owner and the seat suspended;
    // every consent, seat and agency-authority check from here needs the
    // owner eligible again (_owns_org and can_act_for both require it).
    must(await admin.from("profiles").update({ is_active: true, approval_status: "approved" }).in("id", [OWN.id, SEAT.id]).select("id"), "re-activate the agency owner and seat");
    // 0062 consent deadlines: only this run's recipient/org are changed.
    const recipient=await makeUser("expiry");
    const recipientClient=await signedClient(recipient.email);
    const ownerClient=await signedClient(OWN.email);
    const sent=await ownerClient.rpc("org_invite_creator",{p_org:org.id,p_email:recipient.email});
    check(!sent.error&&sent.data==="ok","0062 owner sends a seven-day consent invitation");
    const firstInvite=must(await admin.from("org_invites").select("id,created_at,expires_at").eq("org_id",org.id).eq("email",recipient.email).eq("status","pending").single(),"0062 invitation metadata");
    check(Date.parse(firstInvite.expires_at)-Date.parse(firstInvite.created_at)===7*86400000,"0062 pending lifetime is exactly seven days");
    check(!!(await ownerClient.from("org_invites").update({expires_at:new Date(Date.now()+365*86400000).toISOString()}).eq("id",firstInvite.id)).error,"0062 owner cannot extend expiry with a direct update");
    must(await admin.from("org_invites").update({expires_at:new Date(Date.now()-1000).toISOString()}).eq("id",firstInvite.id).select("id").single(),"0062 expire this run's fixture");
    const expired=await recipientClient.rpc("org_invite_respond",{p_invite:firstInvite.id,p_accept:true});
    check(!expired.error&&expired.data==="expired","0062 an expired invitation cannot join an agency");
    const notJoined=must(await admin.from("profiles").select("org_id").eq("id",recipient.id).single(),"0062 recipient remains independent");
    check(notJoined.org_id===null,"0062 expired acceptance leaves membership unchanged");
    const reissued=await ownerClient.rpc("org_invite_creator",{p_org:org.id,p_email:recipient.email});
    check(!reissued.error&&reissued.data==="ok","0062 owner can send a fresh invitation after expiry");
    const freshInvite=must(await admin.from("org_invites").select("id").eq("org_id",org.id).eq("email",recipient.email).eq("status","pending").single(),"0062 fresh invitation");
    check(freshInvite.id!==firstInvite.id,"0062 expired invitation ID is never reused");
    check((await recipientClient.rpc("org_invite_respond",{p_invite:firstInvite.id,p_accept:true})).data==="expired","0062 replay of the stale ID cannot accept the new invitation");
    const accepted=await recipientClient.rpc("org_invite_respond",{p_invite:freshInvite.id,p_accept:true});
    check(!accepted.error&&accepted.data==="ok","0062 recipient can explicitly accept the fresh consent");
    for(const client of [a,anonClient])for(const fn of ["_session_mfa_satisfied","_serialize_active_admins","_preserve_active_admin"]){
      const denied=await client.rpc(fn);
      check(fn === "_session_mfa_satisfied" ? denied.error?.code === "42501" : !!denied.error,"0062 hidden session/trigger helpers are not directly executable");
    }

    // 0062 actual Auth factor state, never user/app metadata. A is both a
    // creator and an explicit manager only in this disposable fixture.
    must(await admin.from("org_members").upsert({org_id:org.id,profile_id:A.id,role:"manager"},{onConflict:"org_id,profile_id"}).select("id").single(),"0062 manager fixture");
    check((await a.rpc("can_act_for",{target_creator:C.id,perm:"grant"})).data===true,"0062 unenrolled creator retains ordinary agency access");
    // The economic intent below is A (the org's manager) granting to C's fan:
    // A's own fan is on the RM-6 break above, which the grant core refuses.
    const beforeEnrollmentContext=await fixtureActorContext(a,C.id,"grant");
    const enrolled=await a.auth.mfa.enroll({factorType:"totp",friendlyName:"RLS0062"});
    check(!enrolled.error&&!!enrolled.data?.id&&!!enrolled.data?.totp?.secret,"0062 TEST supports actual TOTP enrollment");
    if(enrolled.error||!enrolled.data?.id||!enrolled.data?.totp?.secret)throw Error("0062 TOTP fixture enrollment failed");
    seededFactorIds.push({userId:A.id,id:enrolled.data.id});
    const remaining=30000-Date.now()%30000;
    if(remaining<2000)await new Promise(resolve=>setTimeout(resolve,remaining+100));
    const verified=await a.auth.mfa.challengeAndVerify({factorId:enrolled.data.id,code:fixtureTotp(enrolled.data.totp.secret)});
    check(!verified.error,"0062 actual authenticator challenge succeeds");
    if(verified.error)throw Error("0062 TOTP fixture verification failed");
    const authUser=await a.auth.getUser();
    check(authUser.data.user?.factors?.some(f=>f.id===enrolled.data.id&&f.status==="verified"),"0062 Auth reports a verified factor");
    const low=await signedClient(A.email);
    const lowAssurance=await low.auth.mfa.getAuthenticatorAssuranceLevel();
    check(lowAssurance.data?.currentLevel==="aal1"&&lowAssurance.data?.nextLevel==="aal2","0062 a fresh password session still needs its factor");
    const ownLow=await low.from("wheels").select("id").eq("id",A.wheelId);
    check(!ownLow.error&&ownLow.data?.length===0,"0062 enrolled aal1 session reads no business wheel");
    const lowInsert=await low.from("wheels").insert({creator_id:A.id,title:"MFA refused fixture"}).select("id");
    check(!!lowInsert.error&&(!lowInsert.data||lowInsert.data.length===0),"0062 enrolled aal1 session cannot create business data");
    const beforeName=must(await admin.from("profiles").select("display_name").eq("id",A.id).single(),"0062 name before MFA refusal");
    await low.rpc("set_display_name",{p_name:"forbidden MFA rename"});
    const afterName=must(await admin.from("profiles").select("display_name").eq("id",A.id).single(),"0062 name after MFA refusal");
    check(beforeName.display_name===afterName.display_name,"0062 enrolled aal1 cannot bypass with a self-setting RPC");
    check((await low.rpc("can_act_for",{target_creator:C.id,perm:"grant"})).data===false,"0062 enrolled aal1 loses agency authority too");
    check((await low.rpc("can_act_for",{target_creator:A.id,perm:"edit_wheel"})).data===false,"0062 enrolled aal1 loses own mutation authority");
    const ownHigh=await a.from("wheels").select("id").eq("id",A.wheelId);
    check(!ownHigh.error&&ownHigh.data?.length===1,"0062 challenged aal2 creator regains own business read");
    const lowQueue=await low.rpc("creator_redemption_queue",{p_limit:100}),lowThreads=await low.rpc("creator_inbox_threads",{p_limit:100}),lowHooks=await low.from("webhooks").select("id");
    check(!lowQueue.error&&lowQueue.data?.length===0&&!lowThreads.error&&lowThreads.data?.length===0,"0064 enrolled aal1 session reads no fulfilment queue or inbox thread");
    check(!lowHooks.error&&lowHooks.data?.length===0,"0064 enrolled aal1 session reads no webhook");
    const highQueue=await a.rpc("creator_redemption_queue",{p_limit:100});
    check(!highQueue.error&&(highQueue.data?.length??0)>0,"0064 challenged aal2 creator regains own fulfilment queue");
    check((await a.rpc("can_act_for",{target_creator:C.id,perm:"grant"})).data===true,"0062 challenged aal2 manager regains rightful agency authority");
    const serviceIntent={p_request:randomUUID(),p_creator:C.id,p_actor:A.id,p_fan:C.fanId,p_pass:C.passId,p_spins:1,p_bonus:0,p_amount:0,p_campaign:null};
    const sessionRace=await admin.rpc("grant_pass_spins",{...serviceIntent,p_context:beforeEnrollmentContext});
    check(!sessionRace.error&&sessionRace.data?.status==="unavailable","0062 newly verified factor refuses prior aal1 service capability");
    const serviceLow=await fixtureCreatorRpc(admin,low,"grant_pass_spins",{...serviceIntent,p_request:randomUUID()});
    check(!serviceLow.error&&serviceLow.data?.status==="unavailable","0062 actual password session cannot enter service economic gateway");
    const highRequest=randomUUID();
    const serviceHigh=await fixtureCreatorRpc(admin,a,"grant_pass_spins",{...serviceIntent,p_request:highRequest});
    check(!serviceHigh.error&&serviceHigh.data?.status==="granted","0062 challenged actual aal2 reaches real service economic gateway");
    const highRetry=await fixtureCreatorRpc(admin,a,"grant_pass_spins",{...serviceIntent,p_request:highRequest});
    check(!highRetry.error&&highRetry.data?.status==="granted"&&highRetry.data?.replayed===true,"0062 fresh context retains economic UUID and cannot award twice");
    const publicFanState=await admin.rpc("get_fan_focus_state",{p_token:A.token});
    check(!publicFanState.error&&publicFanState.data?.status==="ok","0062 token-bound fan state remains independent of creator login assurance");

    const code = (r) => r.error?.code ?? (r.data?.length ? "accepted" : "no-op");
    // 0067: a won prize's status, note and due date are patched through
    // set_redemption_state on the caller's own session (can_act_for 'fulfil'
    // or is_admin, checked on auth.uid()); 0068 took the EXECUTE grant away
    // from the service role, anon never had it, and the stock-unit
    // bookkeeping is written only inside that RPC. A is aal2 here.
    console.log("\n0067 fulfilment writes:");
    const aRedemption = must(await admin.from("redemptions").select("id").eq("creator_id", A.id).limit(1).single(), "0067 A's award");
    const ownPatch = await a.rpc("set_redemption_state", { p_redemption: aRedemption.id, p_creator: A.id, p_patch: { notes: "runtime 0067" } });
    check(!ownPatch.error && ownPatch.data?.status === "ok", `0067 the creator patches its own award through set_redemption_state (${ownPatch.error?.message ?? ownPatch.data?.status})`);
    const otherPatch = await b.rpc("set_redemption_state", { p_redemption: aRedemption.id, p_creator: A.id, p_patch: { status: "cancelled" } });
    check(!otherPatch.error && otherPatch.data?.status === "forbidden", `0067 another creator cannot cancel A's award (${otherPatch.error?.message ?? otherPatch.data?.status})`);
    check((await admin.rpc("set_redemption_state", { p_redemption: aRedemption.id, p_creator: A.id, p_patch: { notes: "x" } })).error?.code === "42501", "0068 the service role holds no EXECUTE on set_redemption_state");
    check((await anonClient.rpc("set_redemption_state", { p_redemption: aRedemption.id, p_creator: A.id, p_patch: { notes: "x" } })).error?.code === "42501", "anon cannot execute set_redemption_state");
    const unitWrite = await a.from("redemptions").update({ stock_unit: "held" }).eq("id", aRedemption.id).select("id");
    check(unitWrite.error?.code === "42501", `0067 a stock unit is moved only by set_redemption_state (${code(unitWrite)})`);
    const patched = must(await admin.from("redemptions").select("notes, status, stock_unit").eq("id", aRedemption.id).single(), "0067 the award after the patches");
    check(patched.notes === "runtime 0067" && patched.status !== "cancelled" && patched.stock_unit === null, `0067 only the owner's note landed (status ${patched.status}, unit ${patched.stock_unit})`);
    check((await a.rpc("schema_version")).error?.code === "42501", "0067 a creator cannot execute schema_version");

    // 0069: a game needs at least 2 prizes to be set on a link, pinned to a
    // campaign or scheduled, for every role. A's seeded wheel has one prize;
    // a second game of A's with two is the playable comparison.
    console.log("\n0069 minimum prizes:");
    const twoWheel = must(await admin.from("wheels").insert({ creator_id: A.id, title: "a two-prize game" }).select("id").single(), "0069 seed A's two-prize game");
    must(await admin.from("prizes").insert([1, 2].map((n) => ({ wheel_id: twoWheel.id, label: `a two ${n}`, rarity: "common", weight: 10 }))).select("id"), "0069 seed its prizes");
    const setGame = (wheel) => fixtureCreatorRpc(admin, a, "set_fan_pass_game", { p_creator: A.id, p_pass: A.passId, p_wheel: wheel, p_actor: A.id });
    const pinOne = await setGame(A.wheelId);
    check(!pinOne.error && pinOne.data?.status === "game_not_playable", `0069 a link cannot be set to a one-prize game (${pinOne.error?.message ?? pinOne.data?.status})`);
    const pinTwo = await setGame(twoWheel.id);
    check(!pinTwo.error && pinTwo.data?.status === "ok" && pinTwo.data?.pinnedWheelId === twoWheel.id, `0069 a link is set to a two-prize game (${pinTwo.error?.message ?? pinTwo.data?.status})`);
    const unpin = await setGame(null);
    check(!unpin.error && unpin.data?.status === "ok" && unpin.data?.pinnedWheelId === null, `0069 the link follows the live game again (${unpin.error?.message ?? unpin.data?.status})`);
    const campaignOnOne = await a.from("campaigns").insert({ creator_id: A.id, name: `rls ${RUN} one`, pinned_wheel_id: A.wheelId }).select("id");
    check(campaignOnOne.error?.code === "22023", `0069 a campaign cannot pin a one-prize game (${code(campaignOnOne)})`);
    const campaignOnB = await a.from("campaigns").insert({ creator_id: A.id, name: `rls ${RUN} b`, pinned_wheel_id: B.wheelId }).select("id");
    check(campaignOnB.error?.code === "42501", `0069 a campaign cannot pin another creator's game (${code(campaignOnB)})`);
    const serviceCampaignOnOne = await admin.from("campaigns").insert({ creator_id: A.id, name: `rls ${RUN} svc`, pinned_wheel_id: A.wheelId }).select("id");
    check(serviceCampaignOnOne.error?.code === "22023", `0069 not even the service role pins a one-prize game (${code(serviceCampaignOnOne)})`);
    const campaignOnTwo = await a.from("campaigns").insert({ creator_id: A.id, name: `rls ${RUN} two`, pinned_wheel_id: twoWheel.id }).select("id");
    check(!campaignOnTwo.error && campaignOnTwo.data?.length === 1, `0069 a campaign pins a two-prize game (${campaignOnTwo.error?.message ?? "ok"})`);
    const scheduleOne = await a.from("wheels").update({ active_from: new Date().toISOString() }).eq("id", A.wheelId).select("id");
    check(scheduleOne.error?.code === "22023", `0069 a one-prize game cannot be scheduled (${code(scheduleOne)})`);
    const scheduleTwo = await a.from("wheels").update({ active_from: new Date().toISOString() }).eq("id", twoWheel.id).select("id");
    check(!scheduleTwo.error && scheduleTwo.data?.length === 1, `0069 a two-prize game is scheduled (${scheduleTwo.error?.message ?? "ok"})`);
    check(((await admin.from("campaigns").select("id").eq("creator_id", A.id)).data?.length ?? 0) === 1, "0069 only the two-prize campaign landed");

    // 0068: tenant boundaries, fan consent and deletion traces, on the hosted
    // project's real grants. Every negative is a direct PostgREST write that
    // the route layer never makes; the database alone must refuse it.
    console.log("\n0068 tenant boundaries, consent and link tokens:");
    const creatorPause = await a.from("fan_passes").update({ self_excluded_at: new Date().toISOString(), is_active: false }).eq("id", A.passId).select("id");
    check(creatorPause.error?.code === "42501", `0068 a creator cannot pause its fan's link (${code(creatorPause)})`);
    const creatorToken = await a.from("fan_passes").update({ token: `abcd-${RUN}` }).eq("id", A.passId).select("id");
    check(creatorToken.error?.code === "42501", `0068 a creator cannot rewrite a link token (${code(creatorToken)})`);
    const tokenRead = await a.from("fan_passes").select("token").eq("id", A.passId);
    check(tokenRead.error?.code === "42501", `0068 a session cannot select link tokens (${code(tokenRead)})`);
    const servedOwn = await a.rpc("creator_link_tokens", { p_creator: A.id });
    check(!servedOwn.error && (servedOwn.data ?? []).some((r) => r.token === A.token), "0068 creator_link_tokens serves the owner its own links");
    const servedOther = await b.rpc("creator_link_tokens", { p_creator: A.id });
    check(!servedOther.error && (servedOther.data ?? []).length === 0, "0068 creator_link_tokens serves another creator none of A's links");
    const resolvedOther = await b.rpc("creator_link_pass", { p_token: A.token });
    check(!resolvedOther.error && (resolvedOther.data ?? []).length === 0, "0068 another creator cannot resolve A's token to its pass");
    const bSpin = must(await admin.from("spins").select("id").eq("creator_id", B.id).limit(1).single(), "0068 B's spin");
    const aSpin = must(await admin.from("spins").select("id").eq("creator_id", A.id).limit(1).single(), "0068 A's spin");
    // 0069 revoked INSERT on redemptions from authenticated: a session cannot
    // insert an award at all (forged or its own), refused at the privilege
    // before the 0068 tenant guard is reached; anon reaches no table (0068);
    // the guard itself still refuses the forged row for the service role.
    const forgedRedemption = await a.from("redemptions").insert({ spin_id: bSpin.id, creator_id: A.id }).select("id");
    check(forgedRedemption.error?.code === "42501", `0069 a creator cannot insert a redemption on another creator's spin (${code(forgedRedemption)})`);
    const ownRedemption = await a.from("redemptions").insert({ spin_id: aSpin.id, creator_id: A.id }).select("id");
    check(ownRedemption.error?.code === "42501", `0069 a creator cannot insert a redemption even on its own spin (${code(ownRedemption)})`);
    const anonRedemption = await anonClient.from("redemptions").insert({ spin_id: aSpin.id, creator_id: A.id }).select("id");
    check(anonRedemption.error?.code === "42501", `0068 anon cannot insert a redemption (${code(anonRedemption)})`);
    const serviceForgedRedemption = await admin.from("redemptions").insert({ spin_id: bSpin.id, creator_id: A.id }).select("id");
    check(serviceForgedRedemption.error?.code === "42501", `0068 not even the service role attaches another creator's spin to a redemption (${code(serviceForgedRedemption)})`);
    check(((await admin.from("redemptions").select("id").eq("spin_id", bSpin.id).eq("creator_id", A.id)).data?.length ?? 0) === 0, "0068 no forged redemption landed");
    // B's fan was erased by the reward fixture above, so C's fan is the
    // cross-tenant target: A may act for C as the org's manager, but the row
    // names A as the creator, and the guard checks the row, not the actor.
    const forgedMessage = await a.from("messages").insert({ creator_id: A.id, fan_id: C.fanId, sender: "creator", body: "hi" }).select("id");
    check(forgedMessage.error?.code === "42501", `0068 a creator cannot message another creator's fan (${code(forgedMessage)})`);
    const fanSent = await a.from("messages").insert({ creator_id: A.id, fan_id: A.fanId, sender: "fan", body: "forged" }).select("id");
    check(fanSent.error?.code === "42501", `0068 a creator cannot insert a fan-sent message (${code(fanSent)})`);
    const forgedConsent = await a.from("fans").update({ leaderboard_opt_in: true, handle: `forged-${RUN}` }).eq("id", A.fanId).select("id");
    check(forgedConsent.error?.code === "42501", `0068 a creator cannot forge a fan's consent (${code(forgedConsent)})`);
    const ownNotes = await a.from("fans").update({ notes: "vip" }).eq("id", A.fanId).select("id");
    check(!ownNotes.error && ownNotes.data?.length === 1, `0068 a creator still edits its fan's notes (${ownNotes.error?.message ?? "ok"})`);
    const servicePause = await admin.from("fan_passes").update({ self_excluded_at: new Date().toISOString(), is_active: false }).eq("id", A.passId).select("id");
    check(!servicePause.error && servicePause.data?.length === 1, `0068 the fan path (service role) pauses the link (${servicePause.error?.message ?? "ok"})`);
    const creatorUnpause = await a.from("fan_passes").update({ self_excluded_at: null, is_active: true }).eq("id", A.passId).select("id");
    check(creatorUnpause.error?.code === "42501", `0068 a creator cannot un-pause a link (${code(creatorUnpause)})`);
    const serviceUnpause = await admin.from("fan_passes").update({ self_excluded_at: null }).eq("id", A.passId).select("id");
    check(serviceUnpause.error?.code === "42501", `0068 not even the service role un-pauses a link (${code(serviceUnpause)})`);
    // Self-close refusals answer without starting a deletion (no side effects).
    must(await admin.from("profiles").update({ is_active: false }).eq("id", A.id).select("id").single(), "0068 suspend A");
    const suspendedClose = await admin.rpc("creator_storage_account", { p_operation: "begin", p_owner: A.id, p_actor: A.id, p_action: "account.self_close" });
    check(!suspendedClose.error && suspendedClose.data?.error === "suspended", `0068 a suspended account cannot close itself (${JSON.stringify(suspendedClose.data ?? suspendedClose.error?.message)})`);
    must(await admin.from("profiles").update({ is_active: true }).eq("id", A.id).select("id").single(), "0068 restore A");
    const openReport = must(await admin.from("creator_reports").insert({ creator_id: A.id, fan_id: A.fanId, reason: "Other", detail: `runtime 0068 ${RUN}` }).select("id, creator_snapshot").single(), "0068 seed a report about A");
    check(openReport.creator_snapshot?.display_name !== undefined && !("email" in (openReport.creator_snapshot ?? {})), "0068 a report carries a non-PII snapshot of the account from the start");
    const reportedClose = await admin.rpc("creator_storage_account", { p_operation: "begin", p_owner: A.id, p_actor: A.id, p_action: "account.self_close" });
    check(!reportedClose.error && reportedClose.data?.error === "reports_open", `0068 an account with an open report cannot close itself (${JSON.stringify(reportedClose.data ?? reportedClose.error?.message)})`);
    // The 0058 fixture above seeded a paused deletion row for A; a refused
    // self-close must leave it paused (a started job would be 'pending').
    const aJobs = await admin.from("creator_storage_deletions").select("state").eq("owner_id", A.id);
    check(!aJobs.error && (aJobs.data ?? []).every((j) => j.state === "paused"), `0068 a refused self-close starts no deletion job (${(aJobs.data ?? []).map((j) => j.state).join(",") || "none"})`);
    must(await admin.from("creator_reports").delete().eq("id", openReport.id).select("id").single(), "0068 remove the seeded report");
    // Invitations: uniform answers, consent before a seat, e-mail sync.
    const unknownInvite = await ownerClient.rpc("org_invite_creator", { p_org: org.id, p_email: `nobody-${RUN}@fanfunnel.test` });
    check(!unknownInvite.error && unknownInvite.data === "ok", `0068 an invitation to an unknown address answers ok (${unknownInvite.data ?? unknownInvite.error?.message})`);
    const badInvite = await ownerClient.rpc("org_invite_creator", { p_org: org.id, p_email: "not an address" });
    check(badInvite.data === "invalid_email", `0068 a malformed address is refused (${badInvite.data ?? badInvite.error?.message})`);
    const seatInvite = await ownerClient.rpc("org_add_member", { p_org: org.id, p_email: B.email, p_role: "chatter" });
    check(!seatInvite.error && seatInvite.data === "ok", `0068 org_add_member sends a seat invitation (${seatInvite.data ?? seatInvite.error?.message})`);
    check(((await admin.from("org_members").select("id").eq("org_id", org.id).eq("profile_id", B.id)).data?.length ?? 0) === 0, "0068 org_add_member seats nobody without acceptance");
    const seatInviteRow = must(await admin.from("org_invites").select("id, role").eq("org_id", org.id).eq("email", B.email).eq("status", "pending").single(), "0068 the pending seat invitation");
    check(seatInviteRow.role === "chatter", "0068 the invitation carries the seat role");
    const seatAccepted = await b.rpc("org_invite_respond", { p_invite: seatInviteRow.id, p_accept: true });
    check(!seatAccepted.error && seatAccepted.data === "ok", `0068 the invitee accepts the seat (${seatAccepted.data ?? seatAccepted.error?.message})`);
    const bSeat = await admin.from("org_members").select("role").eq("org_id", org.id).eq("profile_id", B.id);
    check(bSeat.data?.[0]?.role === "chatter", "0068 acceptance creates exactly the invited seat");
    check(((await admin.from("profiles").select("org_id").eq("id", B.id).single()).data?.org_id ?? null) === null, "0068 a seat invitation never moves the account into the org");
    const renamed = `rlstest+${RUN}-b-renamed@fanfunnel.test`;
    const renamedUser = await admin.auth.admin.updateUserById(B.id, { email: renamed, email_confirm: true });
    check(!renamedUser.error, `0068 rename B's auth e-mail (${renamedUser.error?.message ?? "ok"})`);
    const renamedProfile = must(await admin.from("profiles").select("email").eq("id", B.id).single(), "0068 B's profile after the rename");
    check(renamedProfile.email === renamed, `0068 a confirmed e-mail change reaches profiles.email (${renamedProfile.email})`);
  } finally {
    // Always clean up, even if an error was thrown above, so no disposable
    // users or seeded tenant data (FK-cascaded from the user) are left behind.
    for (const id of seededErrorIds) {
      const { error } = await admin.from("app_errors").delete().eq("id", id);
      if (error) { cleanupFailed = true; console.error("  ✗ Failed to delete seeded app_error", id, "—", error.message); }
    }
    // Durable work deliberately has no Auth/profile FK. Delete only rows
    // belonging to this run's users, even if a preceding assertion threw.
    if (createdUserIds.length) for (const table of ["creator_storage_dispatches","creator_storage_objects","creator_storage_deletions"]) {
      const {error}=await admin.from(table).delete().in("owner_id",createdUserIds);
      if(error){cleanupFailed=true;console.error("  ✗ Failed to delete this run's durable metadata",table,"—",error.message);}
    }
    for(const factor of seededFactorIds){
      const removed=await admin.auth.admin.mfa.deleteFactor(factor);
      if(removed.error){cleanupFailed=true;console.error("  ✗ Failed to remove this run's disposable MFA factor");}
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
  // Only after all prior assertions and successful fixture cleanup: these are
  // actual remaining TEST rows, not disposable fixture inventory/key evidence.
  const legacyCounts = await readLegacyCanaryCounts({ projectUrl: URL_, clientFactory: () => admin });
  console.log("LEGACY_CANARY_COUNTS " + JSON.stringify(legacyCounts));
  if (legacyCounts.status !== "available") {
    console.error("✗ Legacy canary counts unavailable; rollout evidence is incomplete. Do not deploy.");
    process.exit(1);
  }
  console.log("\n✓ RLS runtime test passed — tenants are isolated.");
}

main().catch((e) => { console.error("✗ Test error:", e.message ?? e); process.exit(1); });
