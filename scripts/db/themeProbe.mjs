// @ts-check
// Per-creator theming probe (0058). Run by schema-drift-check.mjs on every
// build path against a throwaway local Postgres, acting as real `authenticated`
// users through the live policies, grants, triggers and RPC.
//
// It proves: set_creator_theme writes only the caller's own active row; it
// rejects unknown keys, values off the allow-list, CSS/URL strings, and a
// background photo that is not the caller's own; a suspended caller changes
// nothing; deleting the background photo resets the background. On
// creator_media (with Supabase's default table grants emulated, then the
// migration's own revoke/grant statements replayed on top): a creator reads,
// re-captions, re-orders and deletes only their own photos, can never insert a
// row or change a row's path, owner or attestation, and anon has no access.
// The hub is capped at 12 and a path must sit in the owner's own folder.

import { readFileSync } from "node:fs";
import { join } from "node:path";

const id = (n) => `00000000-0000-4000-8000-0000000058${n}`;
const A = id("a0");
const B = id("b0");
const MA = id("aa");
const MB = id("bb");
const pathOf = (owner, media) => `${owner}/${media}.webp`;

const MIGRATION = join(import.meta.dirname, "../../supabase/migrations/0058_creator_theme_media.sql");
// The migration's own table grants, replayed after emulating Supabase's
// defaults (ALL to anon and authenticated), so the probe checks the privileges
// a real project ends up with rather than the stub's empty defaults.
const GRANTS = readFileSync(MIGRATION, "utf8")
  .split("\n")
  .filter((l) => /^(revoke|grant) .* on table public\.creator_media /.test(l))
  .join("\n");

const SEED = `
  insert into auth.users (id, email) values ('${A}', 'probe-0058a@example.test'), ('${B}', 'probe-0058b@example.test');
  update public.profiles set is_active = true, approval_status = 'approved' where id in ('${A}', '${B}');
  insert into public.creator_media (id, creator_id, path, caption, width, height, sfw_attested_at) values
    ('${MA}', '${A}', '${pathOf(A, MA)}', 'a', 10, 10, now()),
    ('${MB}', '${B}', '${pathOf(B, MB)}', 'b', 10, 10, now());
  grant all on table public.creator_media to anon, authenticated;
  ${GRANTS}`;

const as = (uid, stmt) =>
  `set local role authenticated; select set_config('request.jwt.claim.sub', '${uid}', true); ${stmt} reset role;`;

/**
 * @param {string} db
 * @param {(db: string, extra: string[], opts?: { allowFail?: boolean }) => import("node:child_process").SpawnSyncReturns<string>} psql
 * @returns {string[]} problems found (empty = pass)
 */
export function probeTheme(db, psql) {
  const bad = [];
  if (!GRANTS.includes("grant update (caption, sort_order)")) bad.push("could not read 0058's creator_media grants");
  const run = (body) => psql(db, ["-c", `begin; ${SEED} ${body} rollback;`], { allowFail: true });
  const out = (r) => (r.stdout || "").split("\n").map((l) => l.trim());
  const err = (r) => (r.stderr || "no error").trim().split("\n").find((l) => /ERROR/.test(l)) ?? (r.stderr || "no error").trim();
  const themeOf = (uid) => `(select theme::text from public.profiles where id = '${uid}')`;

  // --- set_creator_theme: own row, allow-list, own media only ----------------
  const own = run(`
    ${as(A, `select 'set:' || public.set_creator_theme('{"font":"syne","background":"aurora"}')::text;`)}
    select 'a:' || ${themeOf(A)};
    select 'b:' || ${themeOf(B)};
    ${as(A, `select 'photo:' || (public.set_creator_theme('{"background":"photo","bg_media_id":"${MA}"}') ->> 'bg_media_id');`)}
    select public.creator_storage_queue_remove('${A}', '[{"id":"${MA}","path":"${pathOf(A, MA)}"}]', '${A}', false);
    select public.creator_storage_complete_remove((select id from public.creator_storage_objects where path = '${pathOf(A, MA)}'));
    select 'after-delete:' || ((${themeOf(A)})::jsonb ->> 'background') || ',' || coalesce((${themeOf(A)})::jsonb ->> 'bg_media_id', 'none');
    update public.profiles set is_active = false where id = '${B}';
    ${as(B, `select 'suspended:' || coalesce(public.set_creator_theme('{"font":"syne"}')::text, 'null');`)}
    select 'b-after:' || ${themeOf(B)};`);
  const got = out(own);
  const want = [
    'set:{"font": "syne", "background": "aurora"}',
    'a:{"font": "syne", "background": "aurora"}',
    "b:{}",
    `photo:${MA}`,
    "after-delete:glow,none",
    "suspended:null",
    "b-after:{}",
  ];
  const missing = want.filter((w) => !got.includes(w));
  if (own.status !== 0 || missing.length) {
    bad.push(`set_creator_theme is not own-row only (missing ${missing.join(" | ") || "-"}; got ${got.filter((l) => /:/.test(l)).join(" | ")}; ${err(own)})`);
  }

  const rejects = [
    ['{"background":"photo","bg_media_id":"' + MB + '"}', "invalid theme photo", "another creator's photo as the background"],
    ['{"background":"photo"}', "invalid theme photo", "a photo background with no photo"],
    ['{"background":"photo","bg_media_id":"' + id("ff") + '"}', "invalid theme photo", "an unknown photo id"],
    ['{"background":"glow","bg_media_id":"' + MA + '"}', "invalid theme photo", "a photo id without the photo background"],
    ['{"css":"body{display:none}"}', "invalid theme key", "an unknown key"],
    ['{"background":"url(https://evil.example/x.png)"}', "invalid theme background", "a url() background"],
    ['{"font":"Comic Sans"}', "invalid theme font", "a font off the allow-list"],
    ['{"font":{"family":"x"}}', "invalid theme font", "a non-string font"],
    ['["syne"]', "invalid theme", "a non-object theme"],
  ];
  for (const [json, msg, label] of rejects) {
    const r = run(as(A, `select public.set_creator_theme('${json}');`));
    if (!new RegExp(msg).test(r.stderr || "")) bad.push(`set_creator_theme accepted ${label} (${err(r)})`);
  }
  const unchanged = run(`${as(A, `select public.set_creator_theme('{"font":"syne"}');`)} select 'b-direct:' || ${themeOf(B)};`);
  if (!out(unchanged).includes("b-direct:{}")) bad.push(`B's theme changed when A saved (${out(unchanged).join(" ")})`);
  // A direct UPDATE of B's (or even A's own) profile theme is not allowed:
  // profiles UPDATE is admin-only.
  for (const target of [B, A]) {
    const direct = run(`grant select, update on public.profiles to authenticated;
      ${as(A, `update public.profiles set theme = '{"font":"syne"}' where id = '${target}';`)}
      select 'direct:' || ${themeOf(target)};`);
    if (!out(direct).includes("direct:{}")) bad.push(`a creator's direct UPDATE changed profiles.theme of ${target === A ? "its own row" : "another creator"} (${err(direct)})`);
  }

  // --- creator_media: RLS + column grants ------------------------------------
  const media = run(`
    ${as(A, "select 'a-reads:' || count(*) from public.creator_media;")}
    ${as(A, `select 'a-reads-b:' || count(*) from public.creator_media where creator_id = '${B}';`)}
    ${as(A, `with u as (update public.creator_media set caption = 'mine now' where id = '${MB}' returning 1) select 'a-recaptions-b:' || count(*) from u;`)}
    ${as(A, `with u as (update public.creator_media set caption = 'hello', sort_order = 3 where id = '${MA}' returning 1) select 'a-recaptions-own:' || count(*) from u;`)}
    select 'b-row:' || caption from public.creator_media where id = '${MB}';
    update public.profiles set is_active = false where id = '${A}';
    ${as(A, "select 'suspended-reads:' || count(*) from public.creator_media;")}`);
  const m = out(media);
  for (const w of ["a-reads:1", "a-reads-b:0", "a-recaptions-b:0", "a-recaptions-own:1", "b-row:b", "suspended-reads:0"]) {
    if (!m.includes(w)) bad.push(`creator_media: expected ${w} (got ${m.filter((l) => /:/.test(l)).join(" ") || "nothing"}; ${err(media)})`);
  }
  const denied = (r) => r.status !== 0 && /permission denied|row-level security/.test(r.stderr || "");
  const writes = [
    [`delete from public.creator_media where id = '${MB}';`, "delete another creator's photo directly"],
    [`delete from public.creator_media where id = '${MA}';`, "discard their own storage retry path via direct DELETE"],
    [`insert into public.creator_media (creator_id, path, width, height, sfw_attested_at) values ('${A}', '${pathOf(A, id("c1"))}', 1, 1, now());`, "INSERT a photo row (server-only)"],
    [`update public.creator_media set path = '${pathOf(A, id("c2"))}' where id = '${MA}';`, "change a photo's path"],
    [`update public.creator_media set creator_id = '${B}' where id = '${MA}';`, "move a photo to another creator"],
    [`update public.creator_media set sfw_attested_at = now() - interval '1 year' where id = '${MA}';`, "rewrite the SFW attestation"],
  ];
  for (const [stmt, label] of writes) {
    if (!denied(run(as(A, stmt)))) bad.push(`a creator could ${label}`);
  }
  if (!denied(run(`update public.profiles set is_active=false where id='${A}'; ${as(A, `delete from public.creator_media where id='${MA}';`)}`))) bad.push("a suspended creator could delete a photo directly");
  const anon = run("set local role anon; select count(*) from public.creator_media; reset role;");
  if (!/permission denied for table creator_media/.test(anon.stderr || "")) bad.push(`anon is not refused on creator_media (${err(anon)})`);

  // --- shape + cap ------------------------------------------------------------
  const foreign = run(`insert into public.creator_media (creator_id, path, width, height, sfw_attested_at) values ('${A}', '${pathOf(B, id("c3"))}', 1, 1, now());`);
  if (!/creator_media_path_shape/.test(foreign.stderr || "")) bad.push(`a photo path outside the owner's folder was accepted (${err(foreign)})`);
  const svg = run(`insert into public.creator_media (creator_id, path, width, height, sfw_attested_at) values ('${A}', '${A}/${id("c4")}.svg', 1, 1, now());`);
  if (!/creator_media_path_shape/.test(svg.stderr || "")) bad.push(`a non-.webp photo path was accepted (${err(svg)})`);
  const unattested = run(`insert into public.creator_media (creator_id, path, width, height) values ('${A}', '${pathOf(A, id("c5"))}', 1, 1);`);
  if (!/sfw_attested_at/.test(unattested.stderr || "")) bad.push(`a photo without an SFW attestation was accepted (${err(unattested)})`);
  const fill = Array.from({ length: 11 }, (_, i) => `('${A}', '${pathOf(A, id("d" + i.toString(16)))}', 1, 1, now())`).join(", ");
  const cap = run(`insert into public.creator_media (creator_id, path, width, height, sfw_attested_at) values ${fill};
    select 'count:' || count(*) from public.creator_media where creator_id = '${A}';
    insert into public.creator_media (creator_id, path, width, height, sfw_attested_at) values ('${A}', '${pathOf(A, id("e0"))}', 1, 1, now());`);
  if (!out(cap).includes("count:12") || !/creator media limit reached/.test(cap.stderr || "")) {
    bad.push(`the 12-photo cap did not hold (${out(cap).join(" ")}; ${err(cap)})`);
  }
  return bad;
}
