// A38 end-to-end test of scripts/golive/carry-over.mjs against two disposable
// local Postgres 16 databases (a "TEST" and a "LIVE" stand-in), each built from
// scripts/db/supabase-stub.sql + supabase/schema.sql, so every real trigger,
// guard and constraint runs. Connections are injected (unix socket, no TCP);
// the hosted-URL binding and ref checks are covered by carry-over.test.mjs and
// still run here for the ref pair. Never contacts a hosted project.
//
//   PG_BIN=/usr/lib/postgresql/16/bin node scripts/golive/carry-over.db.test.mjs
//
// Like scripts/db/schema-drift-check.mjs it needs initdb/pg_ctl/psql and drops
// the server to the `postgres` OS user when run as root.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chownSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detId, LIVE_REF, main, makePsql, TEST_REF } from "./carry-over.mjs";

const ROOT = join(import.meta.dirname, "../..");
function findPgBin() {
  if (process.env.PG_BIN) return process.env.PG_BIN;
  const cfg = spawnSync("pg_config", ["--bindir"], { encoding: "utf8" });
  if (cfg.status === 0 && cfg.stdout.trim()) return cfg.stdout.trim();
  const base = "/usr/lib/postgresql";
  if (existsSync(base)) {
    const v = readdirSync(base).map(Number).filter((n) => !Number.isNaN(n)).sort((a, b) => b - a);
    if (v.length) return join(base, String(v[0]), "bin");
  }
  throw new Error("Postgres binaries not found; set PG_BIN=/path/to/pg/bin");
}
const BIN = findPgBin();
process.env.PG_BIN = BIN;
let runAs = {};
if (typeof process.getuid === "function" && process.getuid() === 0) {
  const uid = spawnSync("id", ["-u", "postgres"], { encoding: "utf8" });
  const gid = spawnSync("id", ["-g", "postgres"], { encoding: "utf8" });
  if (uid.status !== 0 || gid.status !== 0) throw new Error("running as root and no `postgres` OS user exists");
  runAs = { uid: Number(uid.stdout.trim()), gid: Number(gid.stdout.trim()) };
}
const WORK = mkdtempSync(join(tmpdir(), "ff-carry-over-"));
if (runAs.uid !== undefined) chownSync(WORK, runAs.uid, runAs.gid);
const PORT = process.env.FF_CARRY_PORT ?? "54287";
const LOG = join(WORK, "resume.jsonl");

let passed = 0;
const check = (label, ok) => {
  assert.ok(ok, label);
  passed++;
};
function pg(cmd, args) {
  const r = spawnSync(join(BIN, cmd), args, { encoding: "utf8", cwd: WORK, ...runAs });
  if (r.status !== 0) throw new Error(`${cmd} failed: ${r.stderr}`);
}
const conn = (db) => ({ PGHOST: WORK, PGPORT: PORT, PGUSER: "postgres", PGDATABASE: db, PGOPTIONS: "-c search_path=public,extensions,pg_temp" });
const SRC = makePsql(conn("carry_src"));
const DST = makePsql(conn("carry_dst"));
const ADMIN = makePsql(conn("postgres"));
const q = (psql, sql) => psql(sql).trim();
const one = (psql, sql) => q(psql, sql).split("\n").at(-1);

const u = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const SA = u(1), SB = u(2), SC = u(3), SD = u(4);
const LA = u(901), LB = u(902), LD = u(904), LE = u(905);
const W = u(10), WS = u(11), WB = u(12), WX = u(13), WBOB = u(14), WDAN = u(15);
const MEDIA = u(60);
const prize = (n, wheel, extra = "") => `('${u(100 + n)}', '${wheel}', 'p${n}', ${extra || "'common', 1, null, 'manual'"})`;

function build(db) {
  q(ADMIN, `create database ${db};`);
  const psql = makePsql(conn(db));
  psql("create schema extensions; create extension pgcrypto with schema extensions; grant usage on schema extensions to public;");
  psql(readFileSync(join(ROOT, "scripts/db/supabase-stub.sql"), "utf8"));
  psql(readFileSync(join(ROOT, "supabase/schema.sql"), "utf8"));
}

const TEST_HOST = `https://${TEST_REF}.supabase.co/storage/v1/object/public`;
const SEED_SRC = `
insert into auth.users (id, email) values ('${SA}', 'Alice@Example.com'), ('${SB}', 'bob@example.com'), ('${SC}', 'carol@example.com'), ('${SD}', 'dan@example.com');
update public.profiles set approval_status = 'approved', features = '{"scratch": true, "bingo": true}'::jsonb,
  display_name = 'Alice A', public_slug = 'alice', tip_url = 'https://tips.example/alice', public_tagline = 'hi',
  chat_intro = 'intro', chat_outro = 'outro', creator_note = 'note', leaderboard_enabled = true,
  pwa_icon_mode = 'avatar', avatar_url = '${TEST_HOST}/avatars/a.webp' where id = '${SA}';
update public.profiles set approval_status = 'approved', features = '{"scratch": true}'::jsonb, display_name = 'Bob', public_slug = 'bob' where id = '${SB}';
update public.profiles set approval_status = 'approved', display_name = 'Carol' where id = '${SC}';
update public.profiles set approval_status = 'approved', display_name = 'Dan' where id = '${SD}';
insert into public.creator_media (id, creator_id, path, width, height, sfw_attested_at) values ('${MEDIA}', '${SA}', '${SA}/${MEDIA}.webp', 10, 10, now());
update public.profiles set theme = jsonb_build_object('font', 'syne', 'background', 'photo', 'bg_media_id', '${MEDIA}') where id = '${SA}';
insert into public.wheels (id, creator_id, title, brand_color, is_active, game_kind, game_config, game_ready) values
  ('${W}', '${SA}', 'Main wheel', '#111111', true, 'wheel', '{}', true),
  ('${WS}', '${SA}', 'Scratch', '#222222', false, 'scratch', '{"style":"classic"}', true),
  ('${WB}', '${SA}', 'Bingo', '#333333', false, 'bingo', '{"size":3,"linePrizeId":null}', false),
  ('${WX}', '${SA}', 'Old', '#444444', false, 'wheel', '{}', true),
  ('${WBOB}', '${SB}', 'Bob scratch', '#555555', true, 'scratch', '{"style":"classic"}', true),
  ('${WDAN}', '${SD}', 'Dan wheel', '#666666', true, 'wheel', '{}', true);
update public.wheels set archived_at = now() where id = '${WX}';
insert into public.prizes (id, wheel_id, label, rarity, weight, stock, delivery) values
  ${prize(0, W)}, ${prize(1, W, "'rare', 1, null, 'link'")}, ${prize(2, W, "'epic', 1, null, 'codes'")}, ${prize(3, W, "'common', 2, 5, 'text'")},
  ${prize(4, WS)}, ${prize(5, WX)}, ${prize(6, WBOB)}, ${prize(7, WDAN)},
  ${Array.from({ length: 9 }, (_, i) => prize(20 + i, WB, i === 0 ? "'rare', 1, null, 'manual'" : "'common', 1, null, 'manual'")).join(", ")};
update public.prizes set image_url = '${TEST_HOST}/prizes/p0.webp', cost_cents = 250, boostable = true where id = '${u(100)}';
update public.wheels set game_config = '{"size":3,"linePrizeId":"${u(120)}"}', game_ready = true where id = '${WB}';
insert into public.prize_rewards (prize_id, creator_id, kind, cipher, iv, key_version) values ('${u(101)}', '${SA}', 'link', 'c', 'i', 1);
insert into public.prize_reward_codes (prize_id, creator_id, cipher, iv, fingerprint) values ('${u(102)}', '${SA}', 'c', 'i', repeat('a', 64)), ('${u(102)}', '${SA}', 'c', 'i', repeat('b', 64));
update public.prizes set label = label where id = '${u(102)}';
insert into public.fans (id, creator_id, handle) values ('${u(70)}', '${SA}', 'fan1'), ('${u(71)}', '${SA}', 'fan2');
insert into public.fan_passes (token, creator_id, wheel_id, fan_id) values ('tok-carry-1', '${SA}', '${W}', '${u(70)}');
insert into public.campaigns (id, creator_id, name, pinned_wheel_id) values ('${u(30)}', '${SA}', 'Launch', '${W}'), ('${u(31)}', '${SA}', 'Pinned old', '${WX}');
insert into public.campaign_packs (id, creator_id, campaign_id, label, spins, amount_cents, bonus_spins, sort_order, pack_kind) values
  ('${u(40)}', '${SA}', '${u(30)}', '5 plays', 5, 500, 1, 0, 'spins'), ('${u(41)}', '${SA}', null, 'Focus', 0, 900, 0, 1, 'focus');
insert into public.prize_templates (id, creator_id, label, rarity, weight) values ('${u(50)}', '${SA}', 'Tpl prize', 'rare', 3);
insert into public.wheel_templates (id, creator_id, name, title, brand_color, prizes, game_kind, game_config) values
  ('${u(51)}', '${SA}', 'Classic', 'T', '#000000', '[{"label":"x","rarity":"common","weight":1}]', 'wheel', '{}'),
  ('${u(52)}', '${SA}', 'Bingo tpl', 'B', '#000000', '[{"id":"${u(120)}","label":"line"},{"id":"${u(88)}","label":"y"}]', 'bingo', '{"size":3,"linePrizeId":"${u(88)}"}');
insert into public.dm_templates (id, creator_id, title, body) values ('${u(53)}', '${SA}', 'Welcome', 'Hi there');
insert into public.focus_creator_config (creator_id, focus_enabled, chase_enabled) values ('${SA}', true, true);
insert into public.happy_hours (creator_id, wheel_id, multiplier, starts_at, ends_at) values ('${SA}', '${W}', 2, now(), now() + interval '1 day');
`;
const SEED_DST = `
insert into auth.users (id, email) values ('${LA}', 'alice@example.com'), ('${LB}', 'BOB@example.com'), ('${LD}', 'dan@example.com'), ('${LE}', 'eve@example.com');
update public.profiles set approval_status = 'approved', features = '{"bingo": true, "scratch": true}'::jsonb where id = '${LA}';
update public.profiles set approval_status = 'approved' where id in ('${LB}', '${LD}', '${LE}');
update public.profiles set public_slug = 'bob' where id = '${LE}';
`;

const COUNT_TABLES = ["profiles", "wheels", "prizes", "campaigns", "campaign_packs", "prize_templates", "wheel_templates", "dm_templates", "focus_creator_config", "fans", "fan_passes", "prize_rewards", "prize_reward_codes", "creator_media", "happy_hours"];
const snapshot = () =>
  one(DST, `select json_build_object(${COUNT_TABLES.map((t) => `'${t}', (select count(*) from public.${t})`).join(", ")},
    'profiles_md5', (select md5(string_agg(p::text, '|' order by id)) from public.profiles p),
    'wheels_md5', (select md5(coalesce(string_agg(w::text, '|' order by id), '')) from public.wheels w))::text`);
const lines = [];
const run = (argv, input) =>
  main(argv, { connect: (which) => (which === "from" ? SRC : DST), log: (s) => lines.push(s), input: input === undefined ? null : input, env: {} });
const asLines = async function* (...values) {
  for (const v of values) yield v;
};
const refs = ["--from-ref", TEST_REF, "--to-ref", LIVE_REF, "--resume-log", LOG];
const phrase = (emails) => `CARRY ${TEST_REF} -> ${LIVE_REF}: ${emails.join(", ")}`;
const rejects = async (p, code, label) => {
  await assert.rejects(p, (e) => e.code === code, label);
  passed++;
};

try {
  pg("initdb", ["-D", join(WORK, "data"), "-A", "trust", "-U", "postgres", "--no-sync", "-E", "UTF8", "--locale=C"]);
  pg("pg_ctl", ["-D", join(WORK, "data"), "-w", "-l", join(WORK, "pg.log"), "-o", `-p ${PORT} -k ${WORK} -c listen_addresses= -c fsync=off`, "start"]);
  build("carry_src");
  build("carry_dst");
  SRC(SEED_SRC);
  DST(SEED_DST);
  check("seed: source bingo game is ready with a real line prize", one(SRC, `select game_ready from public.wheels where id = '${WB}'`) === "t");
  check("seed: source code prize stock follows its codes", one(SRC, `select stock from public.prizes where id = '${u(102)}'`) === "2");

  // 1. Ref refusals never connect.
  await rejects(main(["--from-ref", LIVE_REF, "--to-ref", LIVE_REF, "--creators", "alice@example.com", "--apply"], { connect: () => assert.fail("connected") }), "REFS_EQUAL", "equal refs");
  await rejects(main(["--from-ref", LIVE_REF, "--to-ref", TEST_REF, "--creators", "alice@example.com"], { connect: () => assert.fail("connected") }), "TO_REF_NOT_LIVE", "reversed refs");

  // 2. Dry run: plan only, LIVE unchanged, no resume log. Bob is blocked (slug taken, scratch feature missing in LIVE).
  const before = snapshot();
  const dry = await run([...refs, "--creators", "alice@example.com,bob@example.com"]);
  check("dry run with a blocked creator exits 2", dry.code === 2);
  check("dry run writes nothing to LIVE", snapshot() === before);
  check("dry run writes no resume log", !existsSync(LOG));
  const bob = dry.plans.find((p) => p.email === "bob@example.com");
  check("dry run reports bob's blockers", bob.blocked.some((b) => b.includes("bob is taken")) && bob.blocked.some((b) => b.includes("scratch feature")));
  const alicePlan = dry.plans.find((p) => p.email === "alice@example.com");
  check("dry run counts what alice carries", JSON.stringify(alicePlan.counts) === JSON.stringify({ wheels: 3, prizes: 14, campaigns: 2, campaign_packs: 2, prize_templates: 1, wheel_templates: 2, dm_templates: 1, focus: 1 }));
  check("dry run counts what stays behind", alicePlan.excluded.counts.fans === 2 && alicePlan.excluded.counts.fan_passes === 1 && alicePlan.excluded.counts.prize_rewards === 1 && alicePlan.excluded.counts.creator_media === 1 && alicePlan.excluded.counts.happy_hours === 1 && alicePlan.excluded.reward_codes === 2 && alicePlan.excluded.archived_games === 1);
  check("dry run prints a not-carried line", lines.some((l) => l.includes("not carried:") && l.includes("fans=2")));

  // 3. Apply refuses a blocked plan before asking for confirmation.
  await rejects(run([...refs, "--creators", "alice@example.com,bob@example.com", "--apply"], asLines(phrase(["alice@example.com", "bob@example.com"]))), "PLAN_BLOCKED", "blocked apply");
  check("blocked apply wrote nothing", snapshot() === before && !existsSync(LOG));

  // Owner fixes bob in LIVE: frees the address and enables scratch.
  DST(`update public.profiles set public_slug = null where id = '${LE}'; update public.profiles set features = '{"scratch": true}'::jsonb where id = '${LB}';`);
  const fixed = snapshot();
  const both = ["alice@example.com", "bob@example.com"];

  // 4. Confirmation must be typed exactly.
  await rejects(run([...refs, "--creators", both.join(","), "--apply"], asLines(phrase(["alice@example.com"]))), "CONFIRMATION_MISMATCH", "partial list");
  await rejects(run([...refs, "--creators", both.join(","), "--apply"], asLines(phrase(both).replace(LIVE_REF, TEST_REF))), "CONFIRMATION_MISMATCH", "wrong ref");
  await rejects(run([...refs, "--creators", both.join(","), "--apply"], asLines()), "CONFIRMATION_MISMATCH", "no input");
  await rejects(run([...refs, "--creators", both.join(","), "--apply"], null), "CONFIRMATION_MISMATCH", "closed input");
  check("unconfirmed applies wrote nothing", snapshot() === fixed && !existsSync(LOG));

  // 5. Apply.
  const applied = await run([...refs, "--creators", both.join(","), "--apply"], asLines(phrase(both)));
  check("apply exits 0 and applies both", applied.code === 0 && applied.applied.join() === both.join());
  const id = (t, s) => detId(LIVE_REF, t, s);
  const prof = JSON.parse(one(DST, `select row_to_json(p)::text from public.profiles p where id = '${LA}'`));
  check("profile copy fields carried", prof.display_name === "Alice A" && prof.public_slug === "alice" && prof.tip_url === "https://tips.example/alice" && prof.chat_intro === "intro" && prof.creator_note === "note" && prof.leaderboard_enabled === true);
  check("theme carried without the photo", prof.theme.font === "syne" && prof.theme.background === "glow" && !("bg_media_id" in prof.theme));
  check("avatar and avatar icon not carried", prof.avatar_url === null && prof.pwa_icon_mode === "neutral");
  check("role, approval and features untouched", prof.role === "creator" && prof.approval_status === "approved" && JSON.stringify(prof.features) === JSON.stringify({ bingo: true, scratch: true }));
  const wheels = JSON.parse(one(DST, `select jsonb_agg(w order by title)::text from public.wheels w where creator_id = '${LA}'`));
  check("only unarchived games carried, with mapped ids", wheels.length === 3 && wheels.map((w) => w.id).sort().join() === [id("wheels", W), id("wheels", WS), id("wheels", WB)].sort().join());
  check("every carried game arrives paused", wheels.every((w) => w.is_active === false && w.active_from === null));
  const bingo = wheels.find((w) => w.game_kind === "bingo");
  check("bingo finalized ready with its mapped line prize", bingo.game_ready === true && bingo.game_config.linePrizeId === id("prizes", u(120)) && one(DST, `select wheel_id from public.prizes where id = '${id("prizes", u(120))}'`) === bingo.id);
  check("scratch keeps its config", wheels.find((w) => w.game_kind === "scratch").game_config.style === "classic");
  const prizes = JSON.parse(one(DST, `select jsonb_object_agg(label, json_build_object('delivery', delivery, 'stock', stock, 'image', image_url, 'cost', cost_cents, 'boost', boostable))::text from public.prizes p join public.wheels w on w.id = p.wheel_id where w.creator_id = '${LA}'`));
  check("link and text prizes became manual", prizes.p1.delivery === "manual" && prizes.p3.delivery === "manual" && prizes.p3.stock === 5);
  check("code prize kept codes delivery with zero stock", prizes.p2.delivery === "codes" && prizes.p2.stock === 0);
  check("prize economics carried, image dropped", prizes.p0.cost === 250 && prizes.p0.boost === true && prizes.p0.image === null);
  check("archived game's prize not carried", !("p5" in prizes));
  check("no reward secrets, codes, fans, passes, media or happy hours in LIVE", ["prize_rewards", "prize_reward_codes", "fans", "fan_passes", "creator_media", "happy_hours"].every((t) => one(DST, `select count(*) from public.${t}`) === "0"));
  const camps = JSON.parse(one(DST, `select jsonb_object_agg(name, pinned_wheel_id)::text from public.campaigns where creator_id = '${LA}'`));
  check("campaign pin mapped; archived pin cleared", camps.Launch === id("wheels", W) && camps["Pinned old"] === null);
  check("packs mapped to the carried campaign", one(DST, `select string_agg(coalesce(campaign_id::text, '-'), ',' order by sort_order) from public.campaign_packs where creator_id = '${LA}'`) === `${id("campaigns", u(30))},-`);
  const tpl = JSON.parse(one(DST, `select row_to_json(t)::text from public.wheel_templates t where id = '${id("wheel_templates", u(52))}'`));
  check("bingo template prize ids and line prize remapped together", tpl.prizes[0].id === id("prizes", u(120)) && tpl.prizes[1].id === tpl.game_config.linePrizeId && tpl.creator_id === LA);
  check("prize and DM templates carried", one(DST, `select count(*) from public.prize_templates where creator_id = '${LA}'`) === "1" && one(DST, `select body from public.dm_templates where creator_id = '${LA}'`) === "Hi there");
  check("Focus carried with Chase off", one(DST, `select focus_enabled::text || '/' || chase_enabled::text from public.focus_creator_config where creator_id = '${LA}'`) === "true/false");
  check("bob's scratch game carried paused", one(DST, `select count(*) from public.wheels where creator_id = '${LB}' and game_kind = 'scratch' and not is_active`) === "1" && one(DST, `select display_name from public.profiles where id = '${LB}'`) === "Bob");
  check("unselected creators untouched", one(DST, `select count(*) from public.wheels where creator_id in ('${LD}', '${LE}')`) === "0" && one(DST, `select display_name is distinct from 'Dan' from public.profiles where id = '${LD}'`) === "t");
  check("nothing in LIVE references the TEST project", one(DST, `select count(*) from (select row_to_json(p)::text t from public.profiles p union all select row_to_json(w)::text from public.wheels w union all select row_to_json(x)::text from public.prizes x union all select row_to_json(y)::text from public.wheel_templates y) s where t like '%${TEST_REF}%'`) === "0");
  check("no TEST row id was written", one(DST, `select count(*) from public.wheels where id in ('${W}', '${WS}', '${WB}')`) === "0");
  const log1 = readFileSync(LOG, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  check("resume log has a header and one done line per creator", log1[0].kind === "header" && log1[0].toRef === LIVE_REF && log1.filter((l) => l.status === "done").map((l) => l.email).join() === both.join());
  check("resume log holds no secrets or payload", !readFileSync(LOG, "utf8").includes("Hi there") && !readFileSync(LOG, "utf8").includes("tips.example"));
  const afterApply = snapshot();

  // 6. Re-run with the log: skipped, no change.
  const again = await run([...refs, "--creators", both.join(","), "--apply"], asLines(phrase(both)));
  check("re-run skips done creators", again.code === 0 && again.applied.length === 0 && snapshot() === afterApply);

  // 7. Re-run without the log: deterministic ids make inserts no-ops.
  rmSync(LOG);
  const relogged = await run([...refs, "--creators", both.join(","), "--apply"], asLines(phrase(both)));
  check("without the log the plan sees every row already in LIVE", relogged.plans.find((p) => p.email === "alice@example.com").alreadyPresent.prizes === 14);
  check("without the log nothing is duplicated or changed", relogged.code === 0 && snapshot() === afterApply);

  // 8. Partial failure and resume: dan's LIVE account is suspended between the plan and the write.
  const three = ["alice@example.com", "bob@example.com", "dan@example.com"];
  const sabotage = async function* () {
    DST(`update public.profiles set is_active = false where id = '${LD}';`);
    yield phrase(three);
  };
  const failed = await run([...refs, "--creators", three.join(","), "--apply"], sabotage());
  check("a creator whose LIVE account changed fails and stops the run", failed.code === 1 && lines.some((l) => l.includes("dan@example.com: FAILED") && l.includes("CARRY_TARGET_CHANGED")));
  check("the failed creator's transaction rolled back", one(DST, `select count(*) from public.wheels where creator_id = '${LD}'`) === "0" && one(DST, `select display_name is distinct from 'Dan' from public.profiles where id = '${LD}'`) === "t");
  check("the failure is in the resume log", readFileSync(LOG, "utf8").includes('"status":"failed"'));
  DST(`update public.profiles set is_active = true where id = '${LD}';`);
  const resumed = await run([...refs, "--creators", three.join(","), "--apply"], asLines(phrase(three)));
  check("resume applies only the remaining creator", resumed.code === 0 && resumed.applied.join() === "dan@example.com");
  check("dan's game carried paused", one(DST, `select count(*) from public.wheels where id = '${id("wheels", WDAN)}' and creator_id = '${LD}' and not is_active`) === "1");

  // 9. A resume log for another pair is refused.
  const wrongLog = join(WORK, "wrong.jsonl");
  writeFileSync(wrongLog, JSON.stringify({ kind: "header", fromRef: "aaaaaaaaaaaaaaaaaaaa", toRef: LIVE_REF }) + "\n");
  await rejects(main(["--from-ref", TEST_REF, "--to-ref", LIVE_REF, "--resume-log", wrongLog, "--creators", "alice@example.com", "--apply"], { connect: (w) => (w === "from" ? SRC : DST), log: () => {}, input: asLines(phrase(["alice@example.com"])), env: {} }), "RESUME_LOG_MISMATCH", "foreign log");
} finally {
  spawnSync(join(BIN, "pg_ctl"), ["-D", join(WORK, "data"), "-m", "immediate", "stop"], { cwd: WORK, ...runAs });
  rmSync(WORK, { recursive: true, force: true });
}
console.log(`carry-over.db.test: ${passed} checks passed against disposable Postgres (no hosted project)`);
