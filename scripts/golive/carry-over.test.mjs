// A38 pure guards for scripts/golive/carry-over.mjs: argument and ref refusals,
// URL-to-project binding, deterministic ids, the planner's mapping, blockers
// and TEST-leak detection, and the generated apply SQL. No database, network
// or hosted project. The disposable-Postgres run is carry-over.db.test.mjs.
//
//   node scripts/golive/carry-over.test.mjs

import assert from "node:assert/strict";
import {
  applySql, buildPlan, CarryError, checkRefs, confirmationPhrase, connectionFromUrl, detId, LIVE_REF, main, parseArgs, TEST_REF,
} from "./carry-over.mjs";

let passed = 0;
const check = (label, ok) => {
  assert.ok(ok, label);
  passed++;
};
const refused = (fn, code) => {
  assert.throws(fn, (e) => e instanceof CarryError && e.code === code, code);
  passed++;
};
const refusedAsync = async (p, code) => {
  await assert.rejects(p, (e) => e instanceof CarryError && e.code === code, code);
  passed++;
};

// ------------------------------------------------------------------- args ---
const base = ["--from-ref", TEST_REF, "--to-ref", LIVE_REF];
const a = parseArgs([...base, "--creators", "Bob@Example.com, alice@example.com"]);
check("creators are lower-cased and sorted", a.creators.join() === "alice@example.com,bob@example.com");
check("dry run is the default", a.apply === false);
check("--apply is explicit", parseArgs([...base, "--creators", "a@b.co", "--apply"]).apply === true);
check("default resume log is per target ref", a.resumeLog === `golive-carry-over-${LIVE_REF}.log.jsonl`);
refused(() => parseArgs(base), "CREATORS_REQUIRED");
refused(() => parseArgs([...base, "--creators", "not-an-email"]), "CREATOR_EMAIL_INVALID");
refused(() => parseArgs([...base, "--creators", "a@b.co,A@b.co"]), "CREATOR_LISTED_TWICE");
refused(() => parseArgs([...base, "--creators", "a@b.co", "--to-db-url", "postgres://x"]), "DB_URL_ON_COMMAND_LINE");
refused(() => parseArgs([...base, "--creators", "a@b.co", "postgresql://postgres:pw@db.x.supabase.co/postgres"]), "DB_URL_ON_COMMAND_LINE");
refused(() => parseArgs([...base, "--creators", "a@b.co", "--force"]), "UNKNOWN_ARGUMENT");
refused(() => parseArgs(["--from-ref", "--to-ref", LIVE_REF, "--creators", "a@b.co"]), "ARG_VALUE_MISSING");

// ------------------------------------------------------------------- refs ---
checkRefs(TEST_REF, LIVE_REF);
passed++;
refused(() => checkRefs(LIVE_REF, LIVE_REF), "REFS_EQUAL");
refused(() => checkRefs(TEST_REF, TEST_REF), "REFS_EQUAL");
refused(() => checkRefs(LIVE_REF, TEST_REF), "TO_REF_NOT_LIVE");
refused(() => checkRefs(TEST_REF, "abcdefghijklmnopqrst"), "TO_REF_NOT_LIVE");
refused(() => checkRefs("abcdefghijklmnopqrst", LIVE_REF), "FROM_REF_NOT_TEST");
refused(() => checkRefs("", LIVE_REF), "REFS_REQUIRED");
refused(() => checkRefs("TTLOG", LIVE_REF), "REF_MALFORMED");

// Refusals happen before any connection is opened.
let connected = 0;
const spy = () => {
  connected++;
  throw new Error("must not connect");
};
await refusedAsync(main(["--from-ref", LIVE_REF, "--to-ref", LIVE_REF, "--creators", "a@b.co"], { connect: spy, log: () => {} }), "REFS_EQUAL");
await refusedAsync(main(["--from-ref", TEST_REF, "--to-ref", TEST_REF, "--creators", "a@b.co", "--apply"], { connect: spy, log: () => {} }), "REFS_EQUAL");
await refusedAsync(main(["--from-ref", LIVE_REF, "--to-ref", TEST_REF, "--creators", "a@b.co", "--apply"], { connect: spy, log: () => {} }), "TO_REF_NOT_LIVE");
check("no connection is attempted for a refused pair", connected === 0);
await refusedAsync(main([...base, "--creators", "a@b.co"], { env: {}, log: () => {} }), "DB_URL_MISSING");

// ------------------------------------------------------------- URL binding ---
const direct = connectionFromUrl(`postgresql://postgres:p%40ss@db.${LIVE_REF}.supabase.co:5432/postgres`, LIVE_REF, "to");
check("direct URL binds and decodes the password", direct.PGHOST === `db.${LIVE_REF}.supabase.co` && direct.PGPASSWORD === "p@ss" && direct.PGSSLMODE === "require");
const pooled = connectionFromUrl(`postgres://postgres.${TEST_REF}:pw@aws-0-eu-west-1.pooler.supabase.com:6543/postgres`, TEST_REF, "from");
check("pooler URL binds by its tenant user", pooled.PGUSER === `postgres.${TEST_REF}` && pooled.PGPORT === "6543");
for (const [label, url, ref] of [
  ["TEST URL given as LIVE", `postgresql://postgres:pw@db.${TEST_REF}.supabase.co:5432/postgres`, LIVE_REF],
  ["pooler with another tenant", `postgres://postgres.${TEST_REF}:pw@aws-0-eu-west-1.pooler.supabase.com:6543/postgres`, LIVE_REF],
  ["look-alike host", `postgresql://postgres:pw@db.${LIVE_REF}.supabase.co.evil.example:5432/postgres`, LIVE_REF],
  ["localhost", "postgresql://postgres:pw@localhost:5432/postgres", LIVE_REF],
  ["direct host with another user", `postgresql://admin:pw@db.${LIVE_REF}.supabase.co:5432/postgres`, LIVE_REF],
]) {
  assert.throws(() => connectionFromUrl(url, ref, "to"), (e) => e.code === "DB_URL_NOT_BOUND_TO_REF", label);
  passed++;
}
refused(() => connectionFromUrl("https://db.x.supabase.co", LIVE_REF, "to"), "DB_URL_MALFORMED");
refused(() => connectionFromUrl("not a url", LIVE_REF, "to"), "DB_URL_MALFORMED");
refused(() => connectionFromUrl(undefined, LIVE_REF, "to"), "DB_URL_MISSING");

// -------------------------------------------------------------------- ids ---
const src1 = "11111111-1111-4111-8111-111111111111";
check("ids are deterministic", detId(LIVE_REF, "wheels", src1) === detId(LIVE_REF, "wheels", src1));
check("ids differ by table, target and source", new Set([detId(LIVE_REF, "wheels", src1), detId(LIVE_REF, "prizes", src1), detId(TEST_REF, "wheels", src1), detId(LIVE_REF, "wheels", src1.replace(/1$/, "2"))]).size === 4);
check("ids are lower-case RFC 4122 shaped (version 8)", /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(detId(LIVE_REF, "wheels", src1)));

// ------------------------------------------------------------------- plan ---
const u = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const S = u(1);
const L = u(901);
const W1 = u(10);
const WB = u(11);
const P = (n, extra = {}) => ({ id: u(100 + n), wheel_id: WB, label: `p${n}`, description: null, rarity: n === 0 ? "rare" : "common", weight: 1, color: null, emoji: null, stock: null, sort_order: n, created_at: "2026-01-01T00:00:00Z", image_url: null, cost_cents: null, delivery: "manual", boostable: false, ...extra });
const profileBase = { display_name: "A", chat_intro: null, chat_outro: null, public_slug: "alice", tip_url: null, public_tagline: null, creator_note: null, leaderboard_enabled: false, onboarding_dismissed: true, notify_new_spin: true, notify_low_balance: true, notify_messages: true, pwa_icon_mode: "avatar", theme: { font: "syne", background: "photo", bg_media_id: u(55) } };
const src = {
  creators: [{ id: S, email: "alice@example.com", role: "creator", is_active: true, approval_status: "approved", avatar_url: `https://${TEST_REF}.supabase.co/storage/v1/object/public/a.webp`, ...profileBase }],
  wheels: [
    { id: W1, creator_id: S, title: "Wheel", subtitle: null, brand_color: "#000", label_color: null, label_size: null, show_stock: false, is_active: true, archived_at: null, created_at: "2026-01-01T00:00:00Z", active_from: null, active_until: null, game_kind: "wheel", game_config: {}, game_ready: true },
    { id: WB, creator_id: S, title: "Bingo", subtitle: null, brand_color: "#000", label_color: null, label_size: null, show_stock: false, is_active: false, archived_at: null, created_at: "2026-01-01T00:00:00Z", active_from: null, active_until: null, game_kind: "bingo", game_config: { size: 3, linePrizeId: u(100) }, game_ready: true },
  ],
  prizes: [P(0), P(1, { delivery: "link" }), P(2, { delivery: "codes", stock: 7, wheel_id: W1 }), P(3, { image_url: `https://${TEST_REF}.supabase.co/x.webp` })],
  campaigns: [{ id: u(20), creator_id: S, name: "C", is_active: true, created_at: "2026-01-01T00:00:00Z", pinned_wheel_id: W1 }],
  campaign_packs: [{ id: u(30), creator_id: S, campaign_id: u(20), label: "pk", spins: 1, amount_cents: 100, bonus_spins: 0, sort_order: 0, created_at: "2026-01-01T00:00:00Z", pack_kind: "spins", focus_multiplier: 2, focus_spins: 10, chase_within: 10 }],
  prize_templates: [],
  wheel_templates: [{ id: u(40), creator_id: S, name: "T", title: "T", subtitle: null, brand_color: "#000", prizes: [{ id: u(100), label: "x" }, { id: u(77), label: "y", imageUrl: "https://elsewhere.example/y.png" }], created_at: "2026-01-01T00:00:00Z", game_kind: "bingo", game_config: { size: 3, linePrizeId: u(77) }, game_ready: false }],
  dm_templates: [{ id: u(50), creator_id: S, title: "hi", body: "hello", created_at: "2026-01-01T00:00:00Z" }],
  focus: [{ creator_id: S, focus_enabled: true, chase_enabled: true }],
  excluded: [{ creator_id: S, counts: { fans: 3 }, reward_codes: 7, archived_games: 1 }],
};
const tgt = (over = {}) => ({ creators: [{ id: L, email: "alice@example.com", role: "creator", is_active: true, approval_status: "approved", features: { bingo: true }, public_slug: null, has_focus_config: false, ...over }], slugOwners: [] });
const opts = { fromRef: TEST_REF, toRef: LIVE_REF, emails: ["alice@example.com"] };
const [plan] = buildPlan(src, tgt(), opts);
check("a complete plan is not blocked", plan.blocked.length === 0);
const pl = plan.payload;
check("profile targets the LIVE id", pl.profile.id === L);
check("photo background falls back and the media id is gone", pl.profile.theme.background === "glow" && !("bg_media_id" in pl.profile.theme) && pl.profile.theme.font === "syne");
check("avatar icon mode falls back to neutral", pl.profile.pwa_icon_mode === "neutral");
check("games are mapped, owned by LIVE and paused", pl.wheels.every((w) => w.creator_id === L && w.is_active === false && w.id === detId(LIVE_REF, "wheels", w.id === detId(LIVE_REF, "wheels", W1) ? W1 : WB)));
check("bingo is inserted unready, then finalized with the mapped line prize", pl.wheels.find((w) => w.game_kind === "bingo").game_ready === false && pl.bingo[0].game_config.linePrizeId === detId(LIVE_REF, "prizes", u(100)) && pl.bingo[0].game_ready === true);
check("prizes point at mapped games", pl.prizes.every((p) => [detId(LIVE_REF, "wheels", W1), detId(LIVE_REF, "wheels", WB)].includes(p.wheel_id)));
check("link prize becomes manual", pl.prizes.find((p) => p.label === "p1").delivery === "manual");
check("code prize arrives with no stock", pl.prizes.find((p) => p.label === "p2").stock === 0);
check("prize images are dropped", pl.prizes.every((p) => p.image_url === null));
check("campaign pin and pack campaign are mapped", pl.campaigns[0].pinned_wheel_id === detId(LIVE_REF, "wheels", W1) && pl.campaign_packs[0].campaign_id === detId(LIVE_REF, "campaigns", u(20)));
check("template prize ids and line prize are remapped consistently", pl.wheel_templates[0].prizes[1].id === pl.wheel_templates[0].game_config.linePrizeId && pl.wheel_templates[0].prizes[0].id === detId(LIVE_REF, "prizes", u(100)) && pl.wheel_templates[0].prizes[1].imageUrl === null);
check("Chase is off", pl.focus.chase_enabled === false && pl.focus.focus_enabled === true);
check("no TEST row id remains in the payload", ![S, W1, WB, u(100), u(20), u(30), u(40), u(50), u(77)].some((id) => JSON.stringify(pl).includes(id)));
check("no TEST project reference remains", !JSON.stringify(pl).includes(TEST_REF));
check("excluded counts are reported", plan.excluded.reward_codes === 7 && plan.excluded.counts.fans === 3);
check("the changes are announced", ["delivery link -> manual", "0 codes", "glow", "arrives paused", "Chase turned off", "avatar not carried"].every((w) => plan.warnings.some((x) => x.includes(w))));

const blockedBy = (over, s = src) => buildPlan(s, over === null ? { creators: [], slugOwners: [] } : tgt(over), opts)[0].blocked.join(" | ");
check("missing LIVE account blocks", /no LIVE account/.test(blockedBy(null)));
check("unapproved LIVE account blocks", /not approved/.test(blockedBy({ approval_status: "pending" })));
check("inactive LIVE account blocks", /not active/.test(blockedBy({ is_active: false })));
check("admin LIVE account blocks", /role is admin/.test(blockedBy({ role: "admin" })));
check("missing game feature blocks", /lacks the bingo feature/.test(blockedBy({ features: {} })));
check("missing TEST account blocks", /no TEST account/.test(blockedBy({}, { ...src, creators: [] })));
const slugTaken = buildPlan(src, { ...tgt(), slugOwners: [{ id: u(999), public_slug: "alice" }] }, opts)[0];
check("a taken public page address blocks", slugTaken.blocked.some((b) => b.includes("alice")));
const leaky = buildPlan({ ...src, creators: [{ ...src.creators[0], tip_url: `https://${TEST_REF}.supabase.co/tip` }] }, tgt(), opts)[0];
check("any remaining TEST reference blocks", leaky.blocked.some((b) => b.includes("references the TEST project")));
const leakId = buildPlan({ ...src, creators: [{ ...src.creators[0], creator_note: `see ${W1}` }] }, tgt(), opts)[0];
check("any remaining TEST row id blocks", leakId.blocked.some((b) => b.includes("TEST row id")));
const bingoBad = buildPlan({ ...src, wheels: src.wheels.map((w) => (w.id === WB ? { ...w, game_config: { size: 3, linePrizeId: u(555) } } : w)) }, tgt(), opts)[0];
check("a bingo line prize outside its game blocks", bingoBad.blocked.some((b) => b.includes("line prize")));
const existingFocus = buildPlan(src, tgt({ has_focus_config: true }), opts)[0];
check("an existing LIVE Focus setting is kept", existingFocus.payload.focus === null);

// -------------------------------------------------------------- apply SQL ---
const sql = applySql(plan);
const tag = /\$(carry_[0-9a-f]{24})\$/.exec(sql)[1];
check("payload is dollar-quoted with a tag absent from the data", !JSON.stringify(pl).includes(tag) && sql.split(`$${tag}$`).length === 3);
check("one transaction with a target re-check", sql.trimStart().startsWith("begin;") && sql.includes("CARRY_TARGET_CHANGED") && sql.indexOf("commit;") > sql.indexOf("insert into public.dm_templates"));
check("inserts never overwrite existing rows", (sql.match(/on conflict \(id\) do nothing/g) ?? []).length === 7 && !/on conflict \(id\) do update/.test(sql));
check("profile update never touches role, approval, features, org or terms", !/\b(role|approval_status|features|org_id|is_active|terms_version|terms_accepted_at|email)\s*=/.test(sql.slice(sql.indexOf("update public.profiles"), sql.indexOf("from carry_payload"))));
check("confirmation names both refs and every creator", confirmationPhrase({ fromRef: TEST_REF, toRef: LIVE_REF }, ["a@x.co", "b@y.co"]) === `CARRY ${TEST_REF} -> ${LIVE_REF}: a@x.co, b@y.co`);

console.log(`carry-over.test: ${passed} checks passed`);
