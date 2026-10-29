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
  const fan = must(await admin.from("fans").insert({ creator_id: id, display_name: `${tag} fan`, acked_at:new Date().toISOString(),acked_terms_version:"2026-10-27" }).select("id").single(), `seed ${tag} fan`);
  const grant=must(await admin.rpc("create_pass_grant",{p_request:randomUUID(),p_creator:id,p_fan:fan.id,p_wheel:wheel.id,p_name:`${tag} fan`,p_spins:5,p_bonus:0,p_amount:1000,p_campaign:null}),`seed ${tag} atomic grant`);
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
        const noDurableImport=await admin.rpc("import_fans_durable",{p_batch:randomUUID(),p_creator:A.id,p_actor:A.id,p_request_hash:sha(canonicalProof(["fan-import-v1",deniedRows])),p_rows:deniedRows});
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

    // Non-vacuous own/cross-tenant promise fixtures, using only service RPCs.
    must(await admin.from("prizes").update({boostable:true,stock:1}).eq("id",B.prizeId).select("id").single(),"prepare B boostable finite target");
    must(await admin.from("focus_creator_config").insert({creator_id:B.id,chase_enabled:true}).select("creator_id").single(),"enable chase for disposable B only");
    for(const kind of ["focus","chase"]) {
      const pack=must(await admin.from("campaign_packs").insert({creator_id:B.id,label:`runtime ${kind}`,spins:10,pack_kind:kind,focus_spins:5,chase_within:5}).select("id").single(),`seed ${kind} pack`);
      const granted=must(await admin.rpc("grant_focus_pack",{p_request:randomUUID(),p_creator:B.id,p_fan:B.fanId,p_pass:B.passId,p_pack:pack.id,p_prize:B.prizeId}),`grant real ${kind} fixture`);
      check(granted.status==="granted",`real ${kind} RPC creates owned metadata`);
      must(await admin.rpc("cancel_fan_focus",{p_creator:B.id,p_fan:B.fanId,p_focus:granted.focus.id,p_actor:B.id}),`release ${kind} fixture`);
    }
    must(await admin.from("prizes").update({stock:null}).eq("id",B.prizeId).select("id").single(),"restore B unlimited fixture");
    const ownConfig=await b.from("focus_creator_config").select("creator_id").eq("creator_id",B.id);
    check(!ownConfig.error&&ownConfig.data?.length===1,"B reads its server-controlled rollout metadata");
    const otherConfig=await a.from("focus_creator_config").select("creator_id").eq("creator_id",B.id);
    check(!otherConfig.error&&otherConfig.data?.length===0,"A reads no B rollout settings");
    check((await b.from("focus_creator_config").update({chase_enabled:false}).eq("creator_id",B.id)).error?.code==="42501","creator cannot change rollout settings");
    const csvRows=[{name:"CSV runtime",spins:2,amountCents:100,campaignId:null,wheelId:null,error:null}];
    const csv=must(await admin.rpc("import_fans_durable",{p_batch:randomUUID(),p_creator:B.id,p_request_hash:sha(canonicalProof(["fan-import-v1",csvRows])),p_rows:csvRows}),"seed real durable import metadata");
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
    const actorFence=must(await admin.rpc("reconcile_creator_request",{p_request:randomUUID(),p_creator:null,p_actor:B.id,p_kind:"pass",p_cancel:true,p_authorized:false}),"record B actor cancellation fence");
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
    ]) {
      check((await a.rpc(fn,args)).error?.code==="42501",`authenticated cannot execute ${fn}`);
      check((await createClient(URL_,ANON,{auth:{persistSession:false}}).rpc(fn,args)).error?.code==="42501",`anon cannot execute ${fn}`);
    }
    for(const [fn,args] of [["import_fans",{p_rows:[]}],["claim_spin",{p_token:B.token}],["credit_pass_spins",{p_fan_id:B.fanId,p_spins:1}],["finalize_reward_spin",{p_spin:{},p_expected:{}}],["reserve_reward_code",{p_prize:B.prizeId,p_spin:randomUUID()}],["release_reward_code",{p_spin:randomUUID()}]])check(!!(await admin.rpc(fn,args)).error,`service cannot execute retired ${fn}`);
    check((await admin.rpc("edit_pass_grant",{p_creator:B.id,p_grant:randomUUID(),p_spins:1,p_bonus:0,p_amount:0})).error?.code==="42501","service cannot bypass edit journal through retired positional API");
    check((await admin.rpc("cancel_fan_focus",{p_creator:B.id,p_fan:B.fanId,p_focus:randomUUID()})).error?.code==="42501","service cannot release promises through retired actorless cancellation API");
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
    check((await admin.from("wheels").insert({...scratchSettings,game_kind:"bingo",game_config:{size:3,linePrizeId:B.prizeId}})).error?.code==="22023","0060 refuses bingo even if its feature flag is true");
    check((await b.from("wheels").update({game_kind:"scratch",game_config:{style:"classic"}}).eq("id",B.wheelId)).error?.code==="22023","first credited play locks game kind against direct table conversion");
    await setBGameFeatures(false);
    must(await b.from("wheels").update({title:"grandfathered scratch",game_config:{style:"classic"}}).eq("id",scratchWheel.id).select("id").single(),"same-kind scratch metadata survives feature removal");
    check((await admin.from("wheels").insert({...scratchSettings,title:"duplicate existing scratch"})).error?.code==="42501","duplicating grandfathered scratch cannot mint a disabled new game");
    for(const client of [a,createClient(URL_,ANON,{auth:{persistSession:false}}),admin])check((await client.rpc("_game_feature_allowed",{p_creator:B.id,p_kind:"scratch"})).error?.code==="42501","API roles cannot execute the private game permission helper");
    must(await admin.from("profiles").update({features:originalGameFeatures}).eq("id",B.id).select("id").single(),"restore disposable B features");

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
    const ownStats = await (await signedClient(OWN.email)).rpc("org_account_stats", { p_org: org.id });
    check(!ownStats.error && ownStats.data?.length === 2, `the org owner's stats list both of its creators (${ownStats.error?.message ?? `got ${ownStats.data?.length}`})`);
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
      const inv = must(await admin.from("org_invites").upsert({ org_id: org.id, email: B.email, status: "pending" }, { onConflict: "org_id,email" }).select("id").single(), "seed approval invite");
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
        const ownerInv = must(await admin.from("org_invites").upsert({ org_id: org.id, email: B.email, status: "pending" }, { onConflict: "org_id,email" }).select("id").single(), "seed ineligible owner invite");
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
      const erasedIntent=must(await admin.rpc("reconcile_creator_request",{p_request:B.requestId,p_creator:B.id,p_actor:B.id,p_kind:"pass",p_authorized:true}),"reconcile erased creator intent");
      check(erasedIntent.status==="gone"&&!erasedIntent.receipt,"erased fan leaves a terminal creator receipt without resurrecting a link");
      const lateCreate=must(await admin.rpc("create_pass_grant",{p_request:B.requestId,p_creator:B.id,p_fan:B.fanId,p_wheel:B.wheelId,p_name:"b fan",p_spins:5,p_bonus:0,p_amount:1000,p_campaign:null,p_actor:B.id}),"late erased creator replay");
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
