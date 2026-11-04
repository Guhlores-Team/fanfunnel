// @ts-check
// A38: one-off go-live carry-over of chosen creators' CONFIGURATION from the
// TEST Supabase project to the LIVE project. Dry run by default.
//
//   CARRY_FROM_DB_URL=... CARRY_TO_DB_URL=... node scripts/golive/carry-over.mjs \
//     --from-ref snmcrmhgevfqggxdiomu --to-ref ttlogfmogcccwiraaoae \
//     --creators alice@example.com,bob@example.com [--apply] [--resume-log FILE]
//
// Copies, per creator (matched TEST -> LIVE by Auth email; the LIVE account must
// already exist, be an active, approved creator and is never created here):
//   profile look and copy (theme, display name, public page fields, chat intro/
//   outro, note, notification and leaderboard preferences); live (unarchived)
//   games with their prizes and game config; campaigns and their packs; prize,
//   wheel and DM templates; Focus config.
// Never copies: fans, passes, spins, grants, redemptions, ledgers, wishlists,
//   reward secrets (prize_rewards) or reward codes, media bytes/rows, webhooks,
//   happy hours, archived games, role/approval/features/org/terms, Auth.
// Changes on the way (each reported in the plan):
//   - every row gets a NEW deterministic id (sha256 of to-ref, table and TEST
//     id), so a re-run maps to the same ids and inserts nothing twice;
//   - games arrive paused (is_active=false, no schedule): the creator reviews
//     and turns them on in LIVE;
//   - link/text prizes become manual (their secrets are never copied); code
//     prizes arrive with 0 stock until codes are added in LIVE;
//   - a photo background falls back to `glow`, avatar/prize image URLs are
//     dropped, an `avatar` home-screen icon falls back to `neutral`;
//   - Chase is off (hosted Chase stays OFF until separately approved).
// Refuses (whole run): from-ref equal to to-ref, from-ref not the TEST ref,
//   to-ref not the LIVE ref, a DB URL not bound to its ref, a database URL on
//   the command line, any blocked creator in an --apply run, or a typed
//   confirmation that is not exactly the one printed.
// Apply: one transaction per creator, stopping at the first failure; each
//   finished creator is appended to the resume log (JSONL) and skipped on a
//   re-run. Needs `psql` on PATH (or PG_BIN). Credentials come only from the
//   two environment variables and are passed to psql through its environment.

import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

export const TEST_REF = "snmcrmhgevfqggxdiomu";
export const LIVE_REF = "ttlogfmogcccwiraaoae";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID_ANY = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const EMAIL = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/;
const REF = /^[a-z0-9]{20}$/;

export class CarryError extends Error {
  /** @param {string} code @param {string} [detail] */
  constructor(code, detail = "") {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
  }
}

// ------------------------------------------------------------------ inputs ---
/** @param {string[]} argv */
export function parseArgs(argv) {
  /** @type {{ fromRef: string, toRef: string, creators: string[], apply: boolean, resumeLog: string }} */
  const out = { fromRef: "", toRef: "", creators: [], apply: false, resumeLog: "" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new CarryError("ARG_VALUE_MISSING", a);
      return v;
    };
    if (a === "--from-ref") out.fromRef = value();
    else if (a === "--to-ref") out.toRef = value();
    else if (a === "--creators") out.creators = value().split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
    else if (a === "--resume-log") out.resumeLog = value();
    else if (a === "--apply") out.apply = true;
    else if (/^--(from|to)-db-url/.test(a) || /^postgres(ql)?:\/\//.test(a)) {
      throw new CarryError("DB_URL_ON_COMMAND_LINE", "pass CARRY_FROM_DB_URL / CARRY_TO_DB_URL in the environment");
    } else throw new CarryError("UNKNOWN_ARGUMENT", a);
  }
  if (!out.creators.length) throw new CarryError("CREATORS_REQUIRED");
  for (const e of out.creators) if (!EMAIL.test(e)) throw new CarryError("CREATOR_EMAIL_INVALID", e);
  if (new Set(out.creators).size !== out.creators.length) throw new CarryError("CREATOR_LISTED_TWICE");
  out.creators.sort();
  if (!out.resumeLog) out.resumeLog = `golive-carry-over-${out.toRef || "unknown"}.log.jsonl`;
  return out;
}

/** @param {string} fromRef @param {string} toRef */
export function checkRefs(fromRef, toRef) {
  if (!fromRef || !toRef) throw new CarryError("REFS_REQUIRED", "--from-ref and --to-ref are both required");
  if (!REF.test(fromRef) || !REF.test(toRef)) throw new CarryError("REF_MALFORMED");
  if (fromRef === toRef) throw new CarryError("REFS_EQUAL", "source and target are the same project");
  if (toRef !== LIVE_REF) throw new CarryError("TO_REF_NOT_LIVE", `expected ${LIVE_REF}`);
  if (fromRef !== TEST_REF) throw new CarryError("FROM_REF_NOT_TEST", `expected ${TEST_REF}`);
}

/**
 * Turn a Supabase Postgres URL into psql environment variables, refusing any
 * URL that does not name the given project: direct `db.<ref>.supabase.co`
 * (user `postgres`) or the pooler `*.pooler.supabase.com` (user `postgres.<ref>`).
 * @param {string | undefined} url @param {string} ref @param {string} label
 */
export function connectionFromUrl(url, ref, label) {
  if (!url) throw new CarryError("DB_URL_MISSING", label);
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new CarryError("DB_URL_MALFORMED", label);
  }
  if (u.protocol !== "postgres:" && u.protocol !== "postgresql:") throw new CarryError("DB_URL_MALFORMED", label);
  /** A bad percent-escape must not surface as a URIError. @param {string} s */
  const decode = (s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      throw new CarryError("DB_URL_MALFORMED", `${label}: invalid percent-encoding`);
    }
  };
  const host = u.hostname.toLowerCase();
  const user = decode(u.username);
  const direct = host === `db.${ref}.supabase.co` && user === "postgres";
  const pooler = /^[a-z0-9-]+\.pooler\.supabase\.com$/.test(host) && user === `postgres.${ref}`;
  if (!direct && !pooler) throw new CarryError("DB_URL_NOT_BOUND_TO_REF", `${label} URL does not belong to ${ref}`);
  const db = decode(u.pathname.replace(/^\//, "")) || "postgres";
  return {
    PGHOST: host,
    PGPORT: u.port || "5432",
    PGUSER: user,
    PGPASSWORD: decode(u.password),
    PGDATABASE: db,
    PGSSLMODE: "require",
    PGCONNECT_TIMEOUT: "15",
  };
}

/** Deterministic UUID for a carried row: same (to-ref, table, TEST id) -> same LIVE id. */
export function detId(toRef, table, sourceId) {
  const h = createHash("sha256").update(`fanfunnel-carry-over/v1|${toRef}|${table}|${sourceId}`).digest("hex");
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

// ------------------------------------------------------------------- psql ---
/**
 * @typedef {(sql: string, opts?: { readOnly?: boolean }) => string} Psql
 * Runs SQL from stdin in one session and returns stdout. readOnly wraps the
 * statements in a READ ONLY transaction.
 */
/** @param {Record<string, string>} connEnv @param {string[]} [extraArgs] @returns {Psql} */
export function makePsql(connEnv, extraArgs = []) {
  const bin = process.env.PG_BIN ? join(process.env.PG_BIN, "psql") : "psql";
  return (sql, { readOnly = false } = {}) => {
    const body = readOnly ? `begin transaction read only;\n${sql}\nrollback;\n` : sql;
    const r = spawnSync(bin, ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", ...extraArgs, "-f", "-"], {
      input: body,
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", ...connEnv },
      maxBuffer: 256 * 1024 * 1024,
    });
    if (r.error) throw new CarryError("PSQL_UNAVAILABLE", r.error.message);
    if (r.status !== 0) {
      const line = (r.stderr || "").split("\n").find((l) => /ERROR|FATAL/.test(l)) ?? "psql failed";
      throw new CarryError("SQL_FAILED", line.trim());
    }
    return r.stdout;
  };
}

const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;
const uuidList = (ids) => {
  for (const id of ids) if (!UUID.test(id)) throw new CarryError("UUID_INVALID", String(id));
  return ids.length ? ids.map(lit).join(",") : "null";
};
/** @param {Psql} psql @param {string} query */
const readJson = (psql, query) => {
  const out = psql(`select coalesce(jsonb_agg(t), '[]'::jsonb) from (${query}) t;`, { readOnly: true }).trim();
  return JSON.parse(out.split("\n").at(-1) || "[]");
};

export const PROFILE_COLS = [
  "display_name", "chat_intro", "chat_outro", "public_slug", "tip_url", "public_tagline", "creator_note",
  "leaderboard_enabled", "onboarding_dismissed", "notify_new_spin", "notify_low_balance", "notify_messages",
  "pwa_icon_mode", "theme",
];
const WHEEL_COLS = ["id", "creator_id", "title", "subtitle", "brand_color", "label_color", "label_size", "show_stock", "is_active", "archived_at", "created_at", "active_from", "active_until", "game_kind", "game_config", "game_ready"];
const PRIZE_COLS = ["id", "wheel_id", "label", "description", "rarity", "weight", "color", "emoji", "stock", "sort_order", "created_at", "image_url", "cost_cents", "delivery", "boostable"];
const CAMPAIGN_COLS = ["id", "creator_id", "name", "is_active", "created_at", "pinned_wheel_id"];
const PACK_COLS = ["id", "creator_id", "campaign_id", "label", "spins", "amount_cents", "bonus_spins", "sort_order", "created_at", "pack_kind", "focus_multiplier", "focus_spins", "chase_within"];
const PRIZE_TEMPLATE_COLS = ["id", "creator_id", "label", "description", "rarity", "weight", "color", "emoji", "created_at"];
const WHEEL_TEMPLATE_COLS = ["id", "creator_id", "name", "title", "subtitle", "brand_color", "prizes", "created_at", "game_kind", "game_config", "game_ready"];
const DM_COLS = ["id", "creator_id", "title", "body", "created_at"];
const FOCUS_COLS = ["creator_id", "focus_enabled", "chase_enabled"];
/** Tables inserted, in dependency order, with their payload key and columns. */
const INSERTS = [
  ["wheels", "wheels", WHEEL_COLS],
  ["prizes", "prizes", PRIZE_COLS],
  ["campaigns", "campaigns", CAMPAIGN_COLS],
  ["campaign_packs", "campaign_packs", PACK_COLS],
  ["prize_templates", "prize_templates", PRIZE_TEMPLATE_COLS],
  ["wheel_templates", "wheel_templates", WHEEL_TEMPLATE_COLS],
  ["dm_templates", "dm_templates", DM_COLS],
];
/** Per-creator tables never carried, counted for the report. */
export const EXCLUDED_TABLES = [
  "fans", "fan_passes", "spins", "spin_attempts", "grants", "redemptions", "wishlists", "referrals", "messages",
  "prize_rewards", "creator_media", "webhooks", "happy_hours", "bingo_cards", "fan_focus", "fan_checkins", "fan_outreach",
];

// ------------------------------------------------------------------ reads ---
/** @param {Psql} psql @param {string[]} emails */
export function readSource(psql, emails) {
  const creators = readJson(psql, `
    select p.id, lower(u.email) as email, p.role, p.is_active, p.approval_status, p.avatar_url,
           ${PROFILE_COLS.map((c) => `p.${c}`).join(", ")}
      from auth.users u join public.profiles p on p.id = u.id
     where lower(u.email) in (${emails.map(lit).join(",")}) order by 2`);
  const ids = creators.map((c) => c.id);
  const inCreators = `creator_id in (${uuidList(ids)})`;
  const wheels = readJson(psql, `select ${WHEEL_COLS.join(", ")} from public.wheels where ${inCreators} and archived_at is null order by created_at, id`);
  const prizes = readJson(psql, `select ${PRIZE_COLS.join(", ")} from public.prizes where wheel_id in (${uuidList(wheels.map((w) => w.id))}) order by sort_order, id`);
  const read = (cols, table) => readJson(psql, `select ${cols.join(", ")} from public.${table} where ${inCreators} order by created_at, 1`);
  const excluded = readJson(psql, `
    select c.id as creator_id, (
      select json_object_agg(t.table_name, (xpath('/row/n/text()', query_to_xml(
        format('select count(*) as n from public.%I where creator_id = %L', t.table_name, c.id), false, true, '')))[1]::text::int)
        from information_schema.columns t
       where t.table_schema = 'public' and t.column_name = 'creator_id'
         and t.table_name in (${EXCLUDED_TABLES.map(lit).join(",")})
    ) as counts,
    (select count(*) from public.prize_reward_codes rc join public.prizes p on p.id = rc.prize_id
       join public.wheels w on w.id = p.wheel_id where w.creator_id = c.id)::int as reward_codes,
    (select count(*) from public.wheels w where w.creator_id = c.id and w.archived_at is not null)::int as archived_games
      from (select unnest(array[${ids.length ? ids.map(lit).join(",") : ""}]::uuid[]) as id) c`);
  return {
    creators,
    wheels,
    prizes,
    campaigns: read(CAMPAIGN_COLS, "campaigns"),
    campaign_packs: read(PACK_COLS, "campaign_packs"),
    prize_templates: read(PRIZE_TEMPLATE_COLS, "prize_templates"),
    wheel_templates: read(WHEEL_TEMPLATE_COLS, "wheel_templates"),
    dm_templates: read(DM_COLS, "dm_templates"),
    focus: readJson(psql, `select ${FOCUS_COLS.join(", ")} from public.focus_creator_config where ${inCreators}`),
    excluded,
  };
}

/** @param {Psql} psql @param {string[]} emails @param {string[]} slugs */
export function readTarget(psql, emails, slugs) {
  const creators = readJson(psql, `
    select p.id, lower(u.email) as email, p.role, p.is_active, p.approval_status, p.features, p.public_slug,
           exists(select 1 from public.focus_creator_config f where f.creator_id = p.id) as has_focus_config
      from auth.users u join public.profiles p on p.id = u.id
     where lower(u.email) in (${emails.map(lit).join(",")}) order by 2`);
  const slugOwners = slugs.length
    ? readJson(psql, `select id, public_slug from public.profiles where public_slug in (${slugs.map(lit).join(",")})`)
    : [];
  return { creators, slugOwners };
}

/** @param {Psql} psql @param {Record<string, string[]>} idsByTable */
export function readExisting(psql, idsByTable) {
  /** @type {Set<string>} */
  const present = new Set();
  for (const [table, ids] of Object.entries(idsByTable)) {
    if (!ids.length) continue;
    for (const r of readJson(psql, `select id from public.${table} where id in (${uuidList(ids)})`)) present.add(`${table}:${r.id}`);
  }
  return present;
}

// ------------------------------------------------------------------- plan ---
/**
 * Pure: map TEST rows to LIVE rows for each creator and list blockers/warnings.
 * @param {ReturnType<typeof readSource>} src
 * @param {ReturnType<typeof readTarget>} tgt
 * @param {{ fromRef: string, toRef: string, emails: string[] }} opts
 */
export function buildPlan(src, tgt, { fromRef, toRef, emails }) {
  const id = (table, sourceId) => detId(toRef, table, sourceId);
  const sourceIds = new Set();
  const plans = [];
  for (const email of emails) {
    const blocked = [];
    const warnings = [];
    const s = src.creators.find((c) => c.email === email);
    const t = tgt.creators.find((c) => c.email === email);
    if (!s) blocked.push("no TEST account with this email");
    if (!t) blocked.push("no LIVE account with this email (the creator signs up or is invited first; this tool never creates Auth users)");
    if (t && t.role !== "creator") blocked.push(`LIVE account role is ${t.role}, not creator`);
    if (t && !t.is_active) blocked.push("LIVE account is not active");
    if (t && t.approval_status !== "approved") blocked.push(`LIVE account is ${t.approval_status}, not approved`);
    if (!s || !t) {
      plans.push({ email, blocked, warnings, sourceId: s?.id ?? null, liveId: t?.id ?? null, payload: null, counts: {}, excluded: null });
      continue;
    }
    sourceIds.add(s.id);
    const liveId = t.id;
    // Profile fields.
    const profile = { id: liveId };
    for (const c of PROFILE_COLS) profile[c] = s[c];
    const theme = { ...(s.theme ?? {}) };
    if ("bg_media_id" in theme || theme.background === "photo") {
      delete theme.bg_media_id;
      if (theme.background === "photo") theme.background = "glow";
      warnings.push("theme photo background reset to glow (media is not carried)");
    }
    profile.theme = theme;
    if (s.avatar_url) warnings.push("avatar not carried (re-upload in LIVE)");
    if (profile.pwa_icon_mode === "avatar") {
      profile.pwa_icon_mode = "neutral";
      warnings.push("home-screen icon set to neutral (avatar not carried)");
    }
    if (s.public_slug && tgt.slugOwners.some((o) => o.public_slug === s.public_slug && o.id !== liveId)) {
      blocked.push(`public page address ${s.public_slug} is taken by another LIVE account`);
    }
    // Games and prizes.
    const wheels = src.wheels.filter((w) => w.creator_id === s.id);
    const wheelIds = new Map(wheels.map((w) => [w.id, id("wheels", w.id)]));
    const prizes = src.prizes.filter((p) => wheelIds.has(p.wheel_id));
    const prizeIds = new Map(prizes.map((p) => [p.id, id("prizes", p.id)]));
    for (const w of wheels) sourceIds.add(w.id);
    for (const p of prizes) sourceIds.add(p.id);
    const features = t.features ?? {};
    const bingoFinal = [];
    const outWheels = wheels.map((w) => {
      if (w.game_kind !== "wheel" && features[w.game_kind] !== true) {
        blocked.push(`LIVE account lacks the ${w.game_kind} feature needed by game "${w.title}" (an admin enables it in LIVE first)`);
      }
      if (w.is_active || w.active_from || w.active_until) warnings.push(`game "${w.title}" arrives paused (was ${w.is_active ? "on" : "scheduled"} in TEST)`);
      const row = { ...w, id: wheelIds.get(w.id), creator_id: liveId, is_active: false, archived_at: null, active_from: null, active_until: null };
      if (w.game_kind === "bingo") {
        const line = w.game_config?.linePrizeId;
        const mappedLine = line ? prizeIds.get(line) ?? null : null;
        if (line && !mappedLine) blocked.push(`bingo game "${w.title}" line prize is not one of its prizes`);
        row.game_config = { size: 3, linePrizeId: null };
        row.game_ready = false;
        bingoFinal.push({ id: row.id, game_config: { size: 3, linePrizeId: mappedLine }, game_ready: Boolean(w.game_ready && mappedLine) });
      }
      return row;
    });
    const outPrizes = prizes.map((p) => {
      const row = { ...p, id: prizeIds.get(p.id), wheel_id: wheelIds.get(p.wheel_id), image_url: null };
      if (p.image_url) warnings.push(`prize "${p.label}" image not carried (re-upload in LIVE)`);
      if (p.delivery === "link" || p.delivery === "text") {
        row.delivery = "manual";
        warnings.push(`prize "${p.label}" delivery ${p.delivery} -> manual (reward secrets are never carried; re-enter it in LIVE)`);
      }
      if (p.delivery === "codes") {
        row.stock = 0;
        warnings.push(`prize "${p.label}" arrives with 0 codes (add codes in LIVE)`);
      }
      return row;
    });
    // Campaigns and packs.
    const campaigns = src.campaigns.filter((c) => c.creator_id === s.id);
    const campaignIds = new Map(campaigns.map((c) => [c.id, id("campaigns", c.id)]));
    for (const c of campaigns) sourceIds.add(c.id);
    const outCampaigns = campaigns.map((c) => {
      const pinned = c.pinned_wheel_id ? wheelIds.get(c.pinned_wheel_id) ?? null : null;
      if (c.pinned_wheel_id && !pinned) warnings.push(`campaign "${c.name}" pinned an archived game; pin cleared`);
      return { ...c, id: campaignIds.get(c.id), creator_id: liveId, pinned_wheel_id: pinned };
    });
    const packs = src.campaign_packs.filter((p) => p.creator_id === s.id);
    const outPacks = packs.map((p) => {
      sourceIds.add(p.id);
      return { ...p, id: id("campaign_packs", p.id), creator_id: liveId, campaign_id: p.campaign_id ? campaignIds.get(p.campaign_id) ?? null : null };
    });
    // Templates.
    const simple = (rows, table) =>
      rows.filter((r) => r.creator_id === s.id).map((r) => {
        sourceIds.add(r.id);
        return { ...r, id: id(table, r.id), creator_id: liveId };
      });
    const tplPrizeId = (pid) => prizeIds.get(pid) ?? id("wheel_template_prizes", pid);
    const outWheelTemplates = src.wheel_templates.filter((r) => r.creator_id === s.id).map((r) => {
      sourceIds.add(r.id);
      const tplPrizes = (Array.isArray(r.prizes) ? r.prizes : []).map((p) => {
        const q = { ...p };
        if (typeof q.id === "string" && UUID.test(q.id)) {
          sourceIds.add(q.id);
          q.id = tplPrizeId(q.id);
        }
        for (const k of ["imageUrl", "image_url"]) if (k in q && q[k]) {
          q[k] = null;
          warnings.push(`template "${r.name}" prize image dropped`);
        }
        return q;
      });
      const cfg = { ...(r.game_config ?? {}) };
      if (typeof cfg.linePrizeId === "string" && UUID.test(cfg.linePrizeId)) {
        sourceIds.add(cfg.linePrizeId);
        cfg.linePrizeId = tplPrizeId(cfg.linePrizeId);
      }
      if (r.game_kind !== "wheel" && features[r.game_kind] !== true) {
        blocked.push(`LIVE account lacks the ${r.game_kind} feature needed by template "${r.name}"`);
      }
      return { ...r, id: id("wheel_templates", r.id), creator_id: liveId, prizes: tplPrizes, game_config: cfg };
    });
    // Focus config.
    const focusSrc = src.focus.find((f) => f.creator_id === s.id);
    let focus = null;
    if (focusSrc) {
      if (t.has_focus_config) warnings.push("LIVE already has a Focus setting; kept as is");
      else {
        focus = { creator_id: liveId, focus_enabled: focusSrc.focus_enabled, chase_enabled: false };
        if (focusSrc.chase_enabled) warnings.push("Chase turned off (hosted Chase stays OFF until separately approved)");
      }
    }
    const payload = {
      profile,
      wheels: outWheels,
      prizes: outPrizes,
      bingo: bingoFinal,
      campaigns: outCampaigns,
      campaign_packs: outPacks,
      prize_templates: simple(src.prize_templates, "prize_templates"),
      wheel_templates: outWheelTemplates,
      dm_templates: simple(src.dm_templates, "dm_templates"),
      focus,
    };
    const counts = Object.fromEntries(INSERTS.map(([, key]) => [key, payload[key].length]));
    counts.focus = focus ? 1 : 0;
    const ex = src.excluded.find((e) => e.creator_id === s.id) ?? null;
    plans.push({ email, blocked, warnings, sourceId: s.id, liveId, payload, counts, excluded: ex });
  }
  // Fail closed on anything that still points at TEST: the TEST host/ref or a TEST row id.
  for (const p of plans) {
    if (!p.payload) continue;
    const text = JSON.stringify(p.payload);
    if (text.includes(fromRef)) p.blocked.push(`payload still references the TEST project (${fromRef})`);
    const leaked = [...new Set(text.match(UUID_ANY) ?? [])].filter((u) => sourceIds.has(u));
    if (leaked.length) p.blocked.push(`payload still holds ${leaked.length} TEST row id(s)`);
  }
  return plans;
}

/** @param {ReturnType<typeof buildPlan>} plans @param {Set<string>} present */
export function markExisting(plans, present) {
  for (const p of plans) {
    if (!p.payload) continue;
    p.alreadyPresent = {};
    for (const [table, key] of INSERTS) {
      p.alreadyPresent[key] = p.payload[key].filter((r) => present.has(`${table}:${r.id}`)).length;
    }
  }
  return plans;
}

/** @param {ReturnType<typeof buildPlan>} plans */
export const plannedIds = (plans) => {
  /** @type {Record<string, string[]>} */
  const out = Object.fromEntries(INSERTS.map(([table]) => [table, []]));
  for (const p of plans) if (p.payload) for (const [table, key] of INSERTS) out[table].push(...p.payload[key].map((r) => r.id));
  return out;
};

/** @param {{ fromRef: string, toRef: string }} refs @param {string[]} emails */
export const confirmationPhrase = (refs, emails) => `CARRY ${refs.fromRef} -> ${refs.toRef}: ${emails.join(", ")}`;

// ------------------------------------------------------------------ apply ---
const insertSql = (table, key, cols) => `
insert into public.${table} (${cols.join(", ")})
select ${cols.map((c) => `r.${c}`).join(", ")}
  from carry_payload, jsonb_populate_recordset(null::public.${table}, doc->'${key}') r
 where not exists (select 1 from public.${table} x where x.id = r.id)
on conflict (id) do nothing;`;

/** One creator, one transaction. @param {ReturnType<typeof buildPlan>[number]} plan */
export function applySql(plan) {
  const json = JSON.stringify(plan.payload);
  let tag;
  do tag = `carry_${randomBytes(12).toString("hex")}`;
  while (json.includes(tag));
  if (!UUID.test(plan.liveId)) throw new CarryError("UUID_INVALID");
  const setProfile = PROFILE_COLS.map((c) => `${c} = r.${c}`).join(", ");
  return `
begin;
set local lock_timeout = '10s';
set local statement_timeout = '120s';
do $guard$ begin
  if not exists (select 1 from public.profiles where id = ${lit(plan.liveId)} and role = 'creator' and is_active and approval_status = 'approved') then
    raise exception 'CARRY_TARGET_CHANGED';
  end if;
end $guard$;
create temp table carry_payload (doc jsonb not null) on commit drop;
insert into carry_payload values ($${tag}$${json}$${tag}$::jsonb);
update public.profiles p set ${setProfile}
  from carry_payload, jsonb_populate_record(null::public.profiles, doc->'profile') r
 where p.id = r.id;
${INSERTS.map(([table, key, cols]) => insertSql(table, key, cols)).join("\n")}
update public.wheels w set game_config = (b->'game_config'), game_ready = (b->>'game_ready')::boolean
  from carry_payload, jsonb_array_elements(doc->'bingo') b
 where w.id = (b->>'id')::uuid and not w.game_ready and w.game_config->'linePrizeId' = 'null'::jsonb;
insert into public.focus_creator_config (${FOCUS_COLS.join(", ")})
select r.${FOCUS_COLS.join(", r.")}
  from carry_payload, jsonb_populate_record(null::public.focus_creator_config, doc->'focus') r
 where doc->'focus' <> 'null'::jsonb
on conflict (creator_id) do nothing;
commit;
select 'CARRY_APPLIED';
`;
}

/** @param {string} path */
export function readResumeLog(path) {
  if (!existsSync(path)) return { header: null, done: new Set() };
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const header = lines.find((l) => l.kind === "header") ?? null;
  const done = new Set(lines.filter((l) => l.kind === "creator" && l.status === "done").map((l) => l.email));
  return { header, done };
}

// ------------------------------------------------------------------- main ---
/** @param {AsyncIterable<string> | null} input */
async function readLine(input) {
  if (!input) return null;
  for await (const line of input) return line;
  return null;
}

/**
 * @param {string[]} argv
 * @param {{ env?: NodeJS.ProcessEnv, log?: (s: string) => void, input?: AsyncIterable<string> | null,
 *   connect?: (which: "from" | "to", ref: string) => Psql, now?: () => string }} [deps]
 * @returns {Promise<{ code: number, plans?: ReturnType<typeof buildPlan>, applied?: string[] }>}
 */
export async function main(argv, deps = {}) {
  const env = deps.env ?? process.env;
  const log = deps.log ?? ((s) => console.log(s));
  const now = deps.now ?? (() => new Date().toISOString());
  const args = parseArgs(argv);
  checkRefs(args.fromRef, args.toRef);
  const connect =
    deps.connect ??
    ((which, ref) => makePsql(connectionFromUrl(which === "from" ? env.CARRY_FROM_DB_URL : env.CARRY_TO_DB_URL, ref, which === "from" ? "CARRY_FROM_DB_URL" : "CARRY_TO_DB_URL")));
  const source = connect("from", args.fromRef);
  const target = connect("to", args.toRef);

  const src = readSource(source, args.creators);
  const slugs = src.creators.map((c) => c.public_slug).filter(Boolean);
  const tgt = readTarget(target, args.creators, slugs);
  const plans = buildPlan(src, tgt, { fromRef: args.fromRef, toRef: args.toRef, emails: args.creators });
  markExisting(plans, readExisting(target, plannedIds(plans)));
  const resume = readResumeLog(args.resumeLog);

  log(`Carry-over plan ${args.fromRef} (TEST) -> ${args.toRef} (LIVE) — ${args.apply ? "APPLY" : "DRY RUN, no writes"}`);
  for (const p of plans) {
    const state = p.blocked.length ? "BLOCKED" : resume.done.has(p.email) ? "DONE (resume log)" : "ready";
    log(`- ${p.email}: ${state}`);
    for (const b of p.blocked) log(`    blocked: ${b}`);
    if (p.payload) {
      log(`    carries: ${Object.entries(p.counts).map(([k, v]) => `${k}=${v}`).join(" ")} + profile`);
      if (p.alreadyPresent && Object.values(p.alreadyPresent).some(Boolean)) log(`    already in LIVE: ${Object.entries(p.alreadyPresent).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(" ")}`);
      const ex = p.excluded ?? { counts: {}, reward_codes: 0, archived_games: 0 };
      const exParts = Object.entries(ex.counts ?? {}).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`);
      if (ex.reward_codes) exParts.push(`reward_codes=${ex.reward_codes}`);
      if (ex.archived_games) exParts.push(`archived_games=${ex.archived_games}`);
      log(`    not carried: ${exParts.length ? exParts.join(" ") : "nothing else on record"}`);
    }
    for (const w of [...new Set(p.warnings)]) log(`    note: ${w}`);
  }
  if (!args.apply) {
    log("Dry run complete: nothing was written. Re-run with --apply to write LIVE.");
    return { code: plans.some((p) => p.blocked.length) ? 2 : 0, plans };
  }

  if (plans.some((p) => p.blocked.length)) throw new CarryError("PLAN_BLOCKED", "fix or remove the blocked creators, then dry-run again");
  if (resume.header && (resume.header.fromRef !== args.fromRef || resume.header.toRef !== args.toRef)) {
    throw new CarryError("RESUME_LOG_MISMATCH", "the resume log belongs to another source/target pair");
  }
  const phrase = confirmationPhrase(args, args.creators);
  log(`To write LIVE, type exactly:\n${phrase}`);
  const typed = await readLine(deps.input === undefined ? createInterface({ input: process.stdin, terminal: false }) : deps.input);
  if (typed === null || typed.trim() !== phrase) throw new CarryError("CONFIRMATION_MISMATCH", "nothing was written");

  if (!resume.header) appendFileSync(args.resumeLog, JSON.stringify({ kind: "header", tool: "carry-over/v1", fromRef: args.fromRef, toRef: args.toRef, at: now() }) + "\n");
  const applied = [];
  for (const p of plans) {
    if (resume.done.has(p.email)) {
      log(`- ${p.email}: skipped (done in resume log)`);
      continue;
    }
    try {
      const out = target(applySql(p));
      if (!out.includes("CARRY_APPLIED")) throw new CarryError("APPLY_UNCONFIRMED");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appendFileSync(args.resumeLog, JSON.stringify({ kind: "creator", email: p.email, status: "failed", error: message, at: now() }) + "\n");
      log(`- ${p.email}: FAILED, rolled back (${message}). Fix, dry-run, then re-run --apply to resume.`);
      return { code: 1, plans, applied };
    }
    appendFileSync(args.resumeLog, JSON.stringify({ kind: "creator", email: p.email, status: "done", liveId: p.liveId, counts: p.counts, at: now() }) + "\n");
    applied.push(p.email);
    log(`- ${p.email}: applied`);
  }
  log(`Applied ${applied.length} creator(s). Resume log: ${args.resumeLog}`);
  return { code: 0, plans, applied };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).then(
    (r) => process.exit(r.code),
    (error) => {
      console.error(error instanceof CarryError ? `refused: ${error.message}` : error);
      process.exit(1);
    },
  );
}
