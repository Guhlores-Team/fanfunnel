// @ts-check
// Completeness-gaps probe (0064). Run by schema-drift-check.mjs against a
// throwaway local Postgres, acting as real `authenticated` / `anon` users
// through the live policies, grants, triggers and RPCs, with Supabase's default
// table grants emulated and the migration's own revokes replayed on top.
//
// It proves:
//  - creator_reports: a creator, and an admin without aal2, can neither read
//    nor review a report; an aal2 admin can, and the database (not the
//    request) stamps who/when, keeps what the fan reported immutable, and
//    clears the trail on reopen; legacy/unknown statuses are refused.
//  - webhooks: the 6th hook for one creator is refused (another creator is
//    unaffected) and an unknown event is refused.
//  - webhook_secrets: no API role (anon, a creator, even an aal2 admin) can
//    read or write it; only the service role can.
//  - creator_redemption_queue / creator_inbox_threads: anon is refused; each
//    creator sees only its own rows; search and keyset paging work.

import { readFileSync } from "node:fs";
import { join } from "node:path";

const id = (n) => `00000000-0000-4000-8000-0000000064${n}`;
const A = id("a0");
const B = id("b0");
const ADM = id("ad");
const WA = id("1a");
const WB = id("1b");
const FA = id("2a");
const FB = id("2b");
const PA = id("3a");
const PB = id("3b");
const SA1 = id("4a");
const SA2 = id("4c");
const SB1 = id("4b");
const RA1 = id("5a");
const RA2 = id("5c");
const RB1 = id("5b");
const REP = id("6a");

const MIGRATION = join(import.meta.dirname, "../../supabase/migrations/0064_completeness_gaps.sql");
const SECRET_REVOKES = readFileSync(MIGRATION, "utf8")
  .split("\n")
  .filter((l) => /^(revoke|grant) .* on table public\.webhook_secrets /.test(l))
  .join("\n");

const SEED = `
  insert into auth.users (id, email) values
    ('${A}', 'probe-0064a@example.test'), ('${B}', 'probe-0064b@example.test'), ('${ADM}', 'probe-0064adm@example.test');
  update public.profiles set is_active = true, approval_status = 'approved' where id in ('${A}', '${B}', '${ADM}');
  update public.profiles set role = 'admin' where id = '${ADM}';
  insert into public.wheels (id, creator_id, title) values ('${WA}', '${A}', 'wa'), ('${WB}', '${B}', 'wb');
  insert into public.fans (id, creator_id, display_name) values ('${FA}', '${A}', 'Ava 100%'), ('${FB}', '${B}', 'Bo');
  insert into public.fan_passes (id, token, creator_id, wheel_id, fan_id) values
    ('${PA}', 'probe-0064-pa', '${A}', '${WA}', '${FA}'), ('${PB}', 'probe-0064-pb', '${B}', '${WB}', '${FB}');
  set local fanfunnel.economic_write = 'on';
  insert into public.spins (id, fan_pass_id, creator_id, wheel_id, fan_id, prize_label, created_at) values
    ('${SA1}', '${PA}', '${A}', '${WA}', '${FA}', 'Selfie', now() - interval '2 hours'),
    ('${SA2}', '${PA}', '${A}', '${WA}', '${FA}', 'Shoutout', now() - interval '1 hour'),
    ('${SB1}', '${PB}', '${B}', '${WB}', '${FB}', 'Secret B', now());
  set local fanfunnel.economic_write = 'off';
  insert into public.redemptions (id, spin_id, creator_id, created_at) values
    ('${RA1}', '${SA1}', '${A}', now() - interval '2 hours'),
    ('${RA2}', '${SA2}', '${A}', now() - interval '1 hour'),
    ('${RB1}', '${SB1}', '${B}', now());
  insert into public.messages (creator_id, fan_id, sender, body, created_at) values
    ('${A}', '${FA}', 'fan', 'one', now() - interval '3 minutes'),
    ('${A}', '${FA}', 'fan', 'two', now() - interval '2 minutes'),
    ('${A}', '${FA}', 'creator', 'reply', now() - interval '1 minute'),
    ('${B}', '${FB}', 'fan', 'b-secret', now());
  insert into public.creator_reports (id, creator_id, fan_id, token, reason, detail) values
    ('${REP}', '${A}', '${FA}', 'probe-0064-pa', 'Involves someone under 18', 'what the fan wrote');
  grant all on table public.creator_reports, public.webhooks, public.redemptions, public.spins,
    public.fans, public.messages, public.webhook_secrets to anon, authenticated;
  ${SECRET_REVOKES}`;

const as = (uid, aal, stmt) =>
  `set local role authenticated; select set_config('request.jwt.claim.sub', '${uid}', true);` +
  ` select set_config('request.jwt.claims', '{"aal":"${aal}"}', true); ${stmt} reset role;`;
const asAnon = (stmt) =>
  `set local role anon; select set_config('request.jwt.claim.sub', '', true); ${stmt} reset role;`;

/**
 * @param {string} db
 * @param {(db: string, extra: string[], opts?: { allowFail?: boolean }) => import("node:child_process").SpawnSyncReturns<string>} psql
 * @returns {string[]} problems found (empty = pass)
 */
export function probeGaps(db, psql) {
  const bad = [];
  if (!/revoke all on table public\.webhook_secrets from public, anon, authenticated/.test(SECRET_REVOKES)) {
    bad.push("could not read 0064's webhook_secrets revoke");
  }
  const run = (body) => psql(db, ["-c", `begin; ${SEED} ${body} rollback;`], { allowFail: true });
  const out = (r) => (r.stdout || "").split("\n").map((l) => l.trim());
  const err = (r) => (r.stderr || "no error").trim().split("\n").find((l) => /ERROR/.test(l)) ?? (r.stderr || "no error").trim();
  const expect = (label, r, want) => {
    const got = out(r);
    const missing = want.filter((w) => !got.includes(w));
    if (r.status !== 0 || missing.length) bad.push(`${label} (missing ${missing.join(" | ") || "-"}; got ${got.filter((l) => /:/.test(l)).join(" | ")}; ${r.status !== 0 ? err(r) : "ok"})`);
  };
  const refused = (label, r, pattern) => {
    if (!pattern.test(r.stderr || "")) bad.push(`${label} was not refused (${err(r)}; out ${out(r).join(" ")})`);
  };

  // --- creator_reports: who can review, and what the trigger stamps -----------
  const reviewSet = `status = 'resolved', resolution_note = 'handled', resolved_by = '${A}', resolved_at = '2000-01-01',
    reason = 'changed', detail = 'changed', creator_id = '${B}', fan_id = '${FB}', token = 'other'`;
  expect("creator_reports is admin-aal2 only", run(`
    ${as(A, "aal2", `select 'creator-reads:' || count(*) from public.creator_reports;`)}
    ${as(A, "aal2", `with u as (update public.creator_reports set ${reviewSet} returning 1) select 'creator-updates:' || count(*) from u;`)}
    ${as(ADM, "aal1", `select 'aal1-reads:' || count(*) from public.creator_reports;`)}
    ${as(ADM, "aal1", `with u as (update public.creator_reports set ${reviewSet} returning 1) select 'aal1-updates:' || count(*) from u;`)}
    ${asAnon(`select 'anon-reads:' || count(*) from public.creator_reports;`)}
    select 'still-open:' || status from public.creator_reports where id = '${REP}';`), [
    "creator-reads:0", "creator-updates:0", "aal1-reads:0", "aal1-updates:0", "anon-reads:0", "still-open:open",
  ]);

  expect("an aal2 admin's review is stamped by the database and the report stays immutable", run(`
    ${as(ADM, "aal2", `with u as (update public.creator_reports set ${reviewSet} returning 1) select 'admin-updates:' || count(*) from u;`)}
    select 'row:' || concat_ws(',', status, resolution_note, resolved_by = '${ADM}', resolved_at > now() - interval '1 minute',
      reason, detail, creator_id = '${A}', fan_id = '${FA}', token) from public.creator_reports where id = '${REP}';
    ${as(ADM, "aal2", `update public.creator_reports set status = 'open', resolution_note = 'keep me' where id = '${REP}';`)}
    select 'reopened:' || concat_ws(',', status, coalesce(resolution_note, 'none'), coalesce(resolved_by::text, 'none'), coalesce(resolved_at::text, 'none'))
      from public.creator_reports where id = '${REP}';
    ${as(ADM, "aal2", `update public.creator_reports set fan_id = null, token = null where id = '${REP}';`)}
    select 'cleared:' || coalesce(fan_id::text, 'null') || ',' || coalesce(token, 'null') from public.creator_reports where id = '${REP}';`), [
    "admin-updates:1",
    "row:resolved,handled,t,t,Involves someone under 18,what the fan wrote,t,t,probe-0064-pa",
    "reopened:open,none,none,none",
    "cleared:null,null",
  ]);
  refused("a legacy 'reviewed' status", run(as(ADM, "aal2", `update public.creator_reports set status = 'reviewed' where id = '${REP}';`)), /creator_reports_status_check/);
  refused("a resolution note over 1000 characters", run(as(ADM, "aal2", `update public.creator_reports set status = 'dismissed', resolution_note = repeat('x', 1001) where id = '${REP}';`)), /creator_reports_note_check/);

  // --- webhooks: event allow-list and the per-creator cap ----------------------
  const five = Array.from({ length: 5 }, (_, i) => `('${A}', 'https://93.184.216.34/${i}', 'all')`).join(", ");
  expect("five hooks are allowed and another creator is unaffected", run(`
    ${as(A, "aal1", `with i as (insert into public.webhooks (creator_id, url, event) values ${five} returning 1) select 'a-five:' || count(*) from i;`)}
    ${as(B, "aal1", `with i as (insert into public.webhooks (creator_id, url, event) values ('${B}', 'https://93.184.216.34/b', 'prize_pending') returning 1) select 'b-one:' || count(*) from i;`)}`), [
    "a-five:5", "b-one:1",
  ]);
  refused("a sixth hook", run(as(A, "aal1", `insert into public.webhooks (creator_id, url, event) values ${five}, ('${A}', 'https://93.184.216.34/6', 'all');`)), /webhook limit reached/);
  refused("an unknown webhook event", run(as(A, "aal1", `insert into public.webhooks (creator_id, url, event) values ('${A}', 'https://93.184.216.34/x', 'everything');`)), /webhooks_event_check/);

  // --- webhook_secrets: server only ---------------------------------------------
  const secretSeed = `insert into public.webhook_secrets (creator_id, secret) values ('${A}', repeat('a', 64));`;
  for (const [label, stmt] of [
    ["the owning creator's read", as(A, "aal2", "select secret from public.webhook_secrets;")],
    ["the owning creator's write", as(A, "aal2", `update public.webhook_secrets set secret = repeat('b', 64);`)],
    ["a creator inserting its own secret", as(B, "aal2", `insert into public.webhook_secrets (creator_id, secret) values ('${B}', repeat('c', 64));`)],
    ["an aal2 admin's read", as(ADM, "aal2", "select secret from public.webhook_secrets;")],
    ["anon's read", asAnon("select secret from public.webhook_secrets;")],
  ]) {
    refused(`webhook_secrets: ${label}`, run(`${secretSeed} ${stmt}`), /permission denied for table webhook_secrets/);
  }
  expect("the service role reads and rotates webhook secrets", run(`${secretSeed}
    set local role service_role;
    update public.webhook_secrets set secret = repeat('d', 64), rotated_at = now() where creator_id = '${A}';
    select 'svc:' || count(*) from public.webhook_secrets where secret = repeat('d', 64);
    reset role;`), ["svc:1"]);
  refused("a malformed webhook secret", run(`insert into public.webhook_secrets (creator_id, secret) values ('${A}', 'short');`), /webhook_secrets_secret_check/);

  // --- server-side queues: anon refused, tenant-isolated, searchable, paged ----
  refused("anon calling creator_redemption_queue", run(asAnon("select * from public.creator_redemption_queue();")), /permission denied for function creator_redemption_queue/);
  refused("anon calling creator_inbox_threads", run(asAnon("select * from public.creator_inbox_threads();")), /permission denied for function creator_inbox_threads/);
  expect("creator_redemption_queue is the caller's own queue, searchable and keyset-paged", run(`
    ${as(A, "aal1", `select 'a-all:' || string_agg(prize_label, ',' order by created_at desc) from public.creator_redemption_queue();`)}
    ${as(B, "aal1", `select 'b-all:' || string_agg(prize_label, ',') from public.creator_redemption_queue();`)}
    ${as(A, "aal1", `select 'a-search:' || count(*) from public.creator_redemption_queue(null, 'selfie');`)}
    ${as(A, "aal1", `select 'a-fan-search:' || count(*) from public.creator_redemption_queue(null, '100%');`)}
    ${as(A, "aal1", `select 'a-wildcard:' || count(*) from public.creator_redemption_queue(null, '_elfie%x');`)}
    ${as(A, "aal1", `select 'a-other-tenant:' || count(*) from public.creator_redemption_queue(null, 'Secret B');`)}
    ${as(A, "aal1", `select 'a-page1:' || string_agg(prize_label, ',') from public.creator_redemption_queue(null, null, null, null, 1);`)}
    ${as(A, "aal1", `select 'a-page2:' || string_agg(q.prize_label, ',') from public.redemptions r, public.creator_redemption_queue(null, null, r.created_at, r.id, 1) q where r.id = '${RA2}';`)}
    ${as(A, "aal1", `select 'a-fulfilled:' || count(*) from public.creator_redemption_queue('fulfilled');`)}`), [
    "a-all:Shoutout,Selfie", "b-all:Secret B", "a-search:1", "a-fan-search:2", "a-wildcard:0", "a-other-tenant:0",
    "a-page1:Shoutout", "a-page2:Selfie", "a-fulfilled:0",
  ]);
  expect("creator_inbox_threads is the caller's own threads with unread counts", run(`
    ${as(A, "aal1", `select 'a-threads:' || string_agg(fan_name || '/' || last_body || '/' || last_sender || '/' || unread, ',') from public.creator_inbox_threads();`)}
    ${as(B, "aal1", `select 'b-threads:' || string_agg(fan_name || '/' || last_body || '/' || unread, ',') from public.creator_inbox_threads();`)}
    ${as(A, "aal1", `select 'a-after-last:' || count(*) from public.creator_inbox_threads(now() - interval '1 hour', '${FA}');`)}`), [
    "a-threads:Ava 100%/reply/creator/2", "b-threads:Bo/b-secret/1", "a-after-last:0",
  ]);
  return bad;
}
