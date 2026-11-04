// @ts-check
// 0065 batch-3 hardening on a disposable local PostgreSQL only (run by
// schema-drift-check.mjs on every build path). No Supabase credential is read.
//   A44  archiving/deleting a game with Focus/Chase promises never deadlocks a
//        credited play (lockRace with an observed-wait barrier; the pre-0065
//        direct UPDATE is the control that must reproduce the 40P01).
//   A17  two racing first-admin claims give exactly one admin; unconfirmed or
//        mismatched email and API roles are refused.
//   A11  run_retention_cleanup trims only settled operational history.
//   A12  the spin_attempts foreign keys are served by an index (EXPLAIN).
//   Pin  a link's own game is written only by set_fan_pass_game: a direct
//        UPDATE/INSERT (a seat's PostgREST PATCH) is refused, even with
//        Supabase's default table grants.
//   A35  sessions cannot delete a redemption (and its recorded award cost).
// Barriers are observed lock waits, never sleep windows: a session renames
// itself once it holds its row, then waits until it sees the other session
// blocked on a lock (the only timers left are hang guards).
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
const MIGRATION_0065 = join(import.meta.dirname, '../../supabase/migrations/0065_fan_game_pins_and_hardening.sql');
const q = value => `'${String(value).replaceAll("'", "''")}'`;
const seen = (name, condition) => `do $$ begin for i in 1..1500 loop perform pg_stat_clear_snapshot(); exit when exists(select 1 from pg_stat_activity where application_name='${name}'${condition}); perform pg_sleep(0.01); end loop; end $$;`;
const asUser = (id, body) => `set local role authenticated;select set_config('request.jwt.claim.sub','${id}',true);select set_config('request.jwt.claim.role','authenticated',true);${body}`;

/** @param {string} db @param {Function} psql @param {Function} psqlAsync */
export async function probeHardening(db, psql, psqlAsync) {
  const bad = []; let checks = 0;
  const check = (ok, label) => { checks++; if (!ok) bad.push(label); };
  const run = (sql) => { const r = psql(db, ['-c', sql], { allowFail: true }); if (r.status !== 0) throw Error(`${sql.slice(0, 80)}: ${(r.stderr || '').trim()}`); return (r.stdout || '').trim(); };
  const creator = randomUUID(), stranger = randomUUID();
  run(`insert into auth.users(id,email) values(${q(creator)},'a44-${creator}@example.test'),(${q(stranger)},'a44-${stranger}@example.test');
       update public.profiles set is_active=true,approval_status='approved' where id in(${q(creator)},${q(stranger)});`);
  try {
    // ---------------------------------------------------------------- A44
    // A game W with one fan's Focus promise on it. `elsewhere`: the fan's link
    // is stored on another game V and set to play W (pinned_wheel_id), so W
    // carries no stored link and can be deleted; `focus: false` drops the
    // promise (only the link set to W ties the fan to it).
    const promise = ({ elsewhere = false, focus = true } = {}) => {
      const w = randomUUID(), v = randomUUID(), p = randomUUID(), f = randomUUID(), s = randomUUID();
      run(`insert into public.wheels(id,creator_id,title,is_active) values(${q(w)},${q(creator)},'A44 game',true)${elsewhere ? `,(${q(v)},${q(creator)},'A44 stored game',false)` : ''};
           insert into public.prizes(id,wheel_id,label,weight,emoji,sort_order,boostable) values(${q(p)},${q(w)},'A44 prize',1,'🎯',0,true);
           insert into public.fans(id,creator_id,display_name) values(${q(f)},${q(creator)},'A44 fan');
           select set_config('fanfunnel.pass_game_write',${q(s)},true);
           insert into public.fan_passes(id,creator_id,fan_id,wheel_id,pinned_wheel_id,token) values(${q(s)},${q(creator)},${q(f)},${q(elsewhere ? v : w)},${elsewhere ? q(w) : 'null'},'a44-${s}');
           ${focus ? `insert into public.fan_focus(creator_id,fan_id,fan_pass_id,wheel_id,prize_id,prize_label,kind,multiplier,total_spins,spins_left) values(${q(creator)},${q(f)},${q(s)},${q(w)},${q(p)},'A44 prize','focus',2,5,5);` : ''}`);
      return { w, f, s };
    };
    // The play side (commit_spin_attempt's order): fan row, its pass, then
    // (once the editor is seen waiting) the wheel row.
    const lockRace = async (label, fixture, editor) => {
      const tag = `ff-a44-${randomUUID().slice(0, 8)}`;
      const play = psqlAsync(db, `begin;set local statement_timeout='20s';select 1 from public.fans where id=${q(fixture.f)} for update;select 1 from public.fan_passes where id=${q(fixture.s)} for update;set local application_name='${tag}-held';${seen(`${tag}-edit`, " and wait_event_type='Lock'")}select 1 from public.wheels where id=${q(fixture.w)} for update;commit;`);
      const ready = await psqlAsync(db, `${seen(`${tag}-held`, '')}select count(*) from pg_stat_activity where application_name='${tag}-held';`);
      if (ready.stdout.trim() !== '1') { await play; throw Error(`${label}: the play never reached its held fan row`); }
      const edit = psqlAsync(db, `begin;set local statement_timeout='20s';set local application_name='${tag}-edit';${editor};commit;`);
      const [p, e] = await Promise.all([play, edit]);
      return { play: p, edit: e, deadlock: [p, e].some(r => /deadlock detected/.test(r.stderr || '')), timedOut: [p, e].some(r => /statement timeout/.test(r.stderr || '')) };
    };
    const control = promise();
    const plain = await lockRace('control', control, `update public.wheels set archived_at=now(),is_active=false where id=${q(control.w)};`);
    check(plain.deadlock, `A44 control: the pre-0065 direct archive UPDATE deadlocks a credited play (40P01) under the barrier (${[plain.play.stderr, plain.edit.stderr].join(' ').trim().split('\n')[0] || 'no error'})`);
    for (const [label, call] of [['archive_wheel', 'archive_wheel'], ['delete_wheel', 'delete_wheel']]) {
      const fixture = promise({ elsewhere: call === 'delete_wheel' });
      const raced = await lockRace(label, fixture, `${asUser(creator, `select public.${call}(${q(fixture.w)});`)}`);
      check(!raced.deadlock && !raced.timedOut && raced.play.status === 0 && raced.edit.status === 0, `A44 ${label}: a creator's ${label} racing a credited play never deadlocks (${[raced.play.stderr, raced.edit.stderr].join(' ').trim().split('\n')[0] || 'clean'})`);
      check(raced.edit.stdout.trim().split('\n').at(-1) === 'ok', `A44 ${label}: the creator's call succeeds once the play commits`);
      const after = run(`select coalesce((select case when archived_at is null then 'live' else 'archived' end from public.wheels where id=${q(fixture.w)}),'deleted')||','||(select string_agg(status,',') from public.fan_focus where fan_id=${q(fixture.f)});`);
      check(after === `${call === 'archive_wheel' ? 'archived' : 'deleted'},released`, `A44 ${label}: the game is ${call === 'archive_wheel' ? 'archived' : 'deleted'} and its Focus promise released (${after})`);
    }
    // Deleting a game also clears the links set to it (ON DELETE SET NULL),
    // which locks those passes: a fan with no promise on the game, only a
    // link set to it, must be taken first as well.
    const pinOnly = promise({ elsewhere: true, focus: false });
    const plainDelete = await lockRace('delete control', pinOnly, `delete from public.wheels where id=${q(pinOnly.w)};`);
    check(plainDelete.deadlock, `A44 control: a direct DELETE of a game a link is set to deadlocks a credited play on that link (${[plainDelete.play.stderr, plainDelete.edit.stderr].join(' ').trim().split('\n')[0] || 'no error'})`);
    const pinOnlyFix = promise({ elsewhere: true, focus: false });
    const pinRace = await lockRace('delete_wheel (link set to the game)', pinOnlyFix, `${asUser(creator, `select public.delete_wheel(${q(pinOnlyFix.w)});`)}`);
    check(!pinRace.deadlock && !pinRace.timedOut && pinRace.play.status === 0 && pinRace.edit.status === 0 && pinRace.edit.stdout.trim().split('\n').at(-1) === 'ok', `A44 delete_wheel: deleting a game a link is set to never deadlocks a play on that link (${[pinRace.play.stderr, pinRace.edit.stderr].join(' ').trim().split('\n')[0] || pinRace.edit.stdout.trim().split('\n').at(-1)})`);
    check(run(`select (select count(*) from public.wheels where id=${q(pinOnlyFix.w)})||','||coalesce((select coalesce(pinned_wheel_id::text,'null') from public.fan_passes where id=${q(pinOnlyFix.s)}),'gone');`) === '0,null', 'A44 delete_wheel: the game is gone and the link survives, following its campaign and the live game again');
    // A link stored on the game would be erased by the cascade (and its balance with it).
    const stored = promise({ focus: false });
    check(run(`begin;${asUser(creator, `select public.delete_wheel(${q(stored.w)});`)}commit;`).split('\n').at(-1) === 'has_history', 'A44 delete_wheel: a game a fan link is stored on is archived instead, never deleted');
    check(run(`select (select count(*) from public.wheels where id=${q(stored.w)})||','||(select count(*) from public.fan_passes where id=${q(stored.s)});`) === '1,1', 'A44 delete_wheel: the refused delete keeps the game and the link');
    const guarded = promise();
    check(run(`begin;${asUser(stranger, `select public.archive_wheel(${q(guarded.w)});`)}commit;`).split('\n').at(-1) === 'not_found' && run(`begin;${asUser(stranger, `select public.delete_wheel(${q(guarded.w)});`)}commit;`).split('\n').at(-1) === 'not_found', 'A44: another creator cannot archive or delete the game');
    check(run(`select archived_at is null from public.wheels where id=${q(guarded.w)};`) === 't', 'A44: the refused calls leave the game live');
    for (const sig of ['archive_wheel(uuid)', 'delete_wheel(uuid)']) {
      const r = psql(db, ['-c', `begin;set local role anon;select public.${sig.replace('(uuid)', `(${q(guarded.w)})`)};rollback;`], { allowFail: true });
      check(/permission denied for function/.test(r.stderr || ''), `A44: anon cannot call ${sig}`);
    }
    check(run(`select has_function_privilege('authenticated','public._lock_wheel_lifecycle(uuid)','execute') or has_function_privilege('service_role','public._lock_wheel_lifecycle(uuid)','execute');`) === 'f', 'A44: the fan-locking helper is private');

    // ---------------------------------------------------------------- A12
    for (const [index, where] of [['spin_attempts_fan_idx', `fan_id=${q(randomUUID())}`], ['spin_attempts_fan_pass_idx', `fan_pass_id=${q(randomUUID())}`], ['spin_attempts_creator_created_idx', `creator_id=${q(creator)} order by created_at`]]) {
      const plan = run(`begin;set local enable_seqscan=off;explain (costs off) select id from public.spin_attempts where ${where};rollback;`);
      check(plan.includes(index), `A12: spin_attempts ${where.split('=')[0]} is served by ${index} (${plan.replace(/\s+/g, ' ').slice(0, 120)})`);
    }

    // ---------------------------------------------------------------- A11
    {
      const fan = randomUUID(), hex = 'a'.repeat(64);
      const id = Object.fromEntries(['committed', 'declined', 'recentDeclined', 'pending', 'jSettled', 'jPending', 'jRecent', 'bOld', 'bInUse', 'bRecent', 'cOld', 'cRecent'].map(k => [k, randomUUID()]));
      const out = run(`begin;
        insert into public.fans(id,creator_id,display_name) values(${q(fan)},${q(creator)},'A11 fan');
        insert into public.fan_checkins(fan_id,creator_id,day) values(${q(fan)},${q(creator)},current_date-100),(${q(fan)},${q(creator)},current_date-60),(${q(fan)},${q(creator)},current_date-1);
        insert into public.spin_attempts(id,creator_id,fan_id,token_hash,request_hash,state,context,created_at,finished_at) values
          (${q(id.committed)},${q(creator)},${q(fan)},'${hex}','${hex}','committed','{"seed":"x"}',now()-interval '100 days',now()-interval '100 days'),
          (${q(id.declined)},${q(creator)},${q(fan)},'${hex}','${hex}','declined','{"seed":"x"}',now()-interval '100 days',now()-interval '100 days'),
          (${q(id.recentDeclined)},${q(creator)},${q(fan)},'${hex}','${hex}','declined','{"seed":"x"}',now()-interval '10 days',now()-interval '10 days'),
          (${q(id.pending)},${q(creator)},${q(fan)},'${hex}','${hex}','pending','{"seed":"x"}',now()-interval '100 days',null);
        insert into public.fan_import_batches(id,creator_id,request_hash,created_at) values(${q(id.bOld)},${q(creator)},'${hex}',now()-interval '100 days'),(${q(id.bInUse)},${q(creator)},'${hex}',now()-interval '100 days'),(${q(id.bRecent)},${q(creator)},'${hex}',now()-interval '10 days');
        insert into public.fan_import_items(batch_id,ordinal,creator_id) values(${q(id.bOld)},0,${q(creator)});
        insert into public.creator_request_journal(id,creator_id,actor_id,kind,request_hash,state,created_at,finished_at,batch_id) values
          (${q(id.jSettled)},${q(creator)},${q(creator)},'grant','${hex}','committed',now()-interval '100 days',now()-interval '100 days',null),
          (${q(id.jPending)},${q(creator)},${q(creator)},'import','${hex}','pending',now()-interval '100 days',null,${q(id.bInUse)}),
          (${q(id.jRecent)},${q(creator)},${q(creator)},'grant','${hex}','committed',now()-interval '10 days',now()-interval '10 days',null);
        insert into public.actor_request_cancellations(actor_id,id,kind,created_at) values(${q(creator)},${q(id.cOld)},'grant',now()-interval '100 days'),(${q(creator)},${q(id.cRecent)},'grant',now()-interval '10 days');
        set local role service_role;
        select public.run_retention_cleanup(365,90,180,90,90)::text;
        reset role;
        select 'checkins:'||string_agg((current_date-day)::text,',' order by day) from public.fan_checkins where fan_id=${q(fan)};
        select 'attempts:'||string_agg(case id when ${q(id.committed)} then 'committed' when ${q(id.recentDeclined)} then 'recent' when ${q(id.pending)} then 'pending' else 'declined' end||'='||(context is not null)::text,',' order by state,created_at) from public.spin_attempts where creator_id=${q(creator)};
        select 'journal:'||string_agg(case id when ${q(id.jPending)} then 'pending' when ${q(id.jRecent)} then 'recent' else 'settled' end,',' order by created_at,state) from public.creator_request_journal where creator_id=${q(creator)};
        select 'batches:'||string_agg(case id when ${q(id.bInUse)} then 'inuse' when ${q(id.bRecent)} then 'recent' else 'old' end,',' order by created_at,id) from public.fan_import_batches where creator_id=${q(creator)};
        select 'items:'||count(*) from public.fan_import_items where batch_id=${q(id.bOld)};
        select 'cancellations:'||string_agg(case id when ${q(id.cRecent)} then 'recent' else 'old' end,',') from public.actor_request_cancellations where actor_id=${q(creator)};
        rollback;`).split('\n');
      const result = JSON.parse(out.find(l => l.startsWith('{')) ?? '{}');
      const line = prefix => out.find(l => l.startsWith(prefix)) ?? '';
      check(line('cancellations:') === 'cancellations:recent', `A11: request cancellation fences go after the journal period (${line('cancellations:')})`);
      check(['fan_checkins', 'spin_attempt_contexts', 'declined_spin_attempts', 'creator_request_journal', 'actor_request_cancellations', 'fan_import_batches'].every(k => Number.isInteger(result[k]) && result[k] >= 1), `A11: the cleanup reports every new count (${JSON.stringify(result)})`);
      check(line('checkins:') === 'checkins:60,1', `A11: check-ins older than 90 days go, the glow's 59-day window stays (${line('checkins:')})`);
      check(line('attempts:').split(':')[1]?.split(',').sort().join(',') === 'committed=false,pending=true,recent=true', `A11: old declined attempts go, old committed attempts lose only their context, pending and recent ones are untouched (${line('attempts:')})`);
      check(line('journal:').split(':')[1]?.split(',').sort().join(',') === 'pending,recent', `A11: only settled request journals past 90 days go (${line('journal:')})`);
      check(line('batches:').split(':')[1]?.split(',').sort().join(',') === 'inuse,recent' && line('items:') === 'items:0', `A11: old import batches go with their rows unless a pending request uses them (${line('batches:')} ${line('items:')})`);
    }
  } catch (error) { bad.push(`hardening probe: ${error instanceof Error ? error.message : error}`); }
  finally { psql(db, ['-c', `delete from auth.users where id in(${q(creator)},${q(stranger)});`], { allowFail: true }); }

  // ----------------------------------------- pin writer and redemption delete
  // In a clone given Supabase's default table grants to authenticated, then
  // 0065 re-applied (idempotent), as a hosted project would have it.
  const grantsDb = `g65_${randomUUID().replaceAll('-', '').slice(0, 16)}`; let grantsMade = false;
  try {
    let r = psql(db, ['-c', `create database "${grantsDb}" template "${db}";`], { allowFail: true }); if (r.status !== 0) throw Error(`clone failed ${(r.stderr || '').trim()}`); grantsMade = true;
    psql(grantsDb, ['-c', 'grant select,insert,update,delete on table public.redemptions,public.fan_passes to authenticated;']);
    const granted = psql(grantsDb, ['-c', `select has_table_privilege('authenticated','public.redemptions','delete');`]).stdout.trim();
    check(granted === 't', `A35 control: the simulated Supabase default grant lets a session delete before 0065 is re-applied (${granted})`);
    r = psql(grantsDb, ['-f', MIGRATION_0065], { allowFail: true }); if (r.status !== 0) throw Error(`0065 re-apply failed ${(r.stderr || '').trim().split('\n').find(l => l.includes('ERROR')) ?? ''}`);
    const runIn = sql => { const res = psql(grantsDb, ['-c', sql], { allowFail: true }); return { ok: res.status === 0, out: (res.stdout || '').trim(), err: (res.stderr || '').trim() }; };
    const owner = randomUUID(), w = randomUUID(), w2 = randomUUID(), f = randomUUID(), s = randomUUID();
    const seeded = runIn(`insert into auth.users(id,email) values(${q(owner)},'pin-${owner}@example.test');
      update public.profiles set is_active=true,approval_status='approved' where id=${q(owner)};
      insert into public.wheels(id,creator_id,title,is_active) values(${q(w)},${q(owner)},'Pin game',true),(${q(w2)},${q(owner)},'Other game',false);
      insert into public.fans(id,creator_id,display_name) values(${q(f)},${q(owner)},'Pin fan');
      insert into public.fan_passes(id,creator_id,fan_id,wheel_id,token) values(${q(s)},${q(owner)},${q(f)},${q(w)},'pin-${s}');`);
    if (!seeded.ok) throw Error(`pin seed failed ${seeded.err}`);
    const patch = runIn(`begin;${asUser(owner, `update public.fan_passes set pinned_wheel_id=${q(w2)} where id=${q(s)} returning id;`)}commit;`);
    check(!patch.ok && /use set_fan_pass_game/.test(patch.err), `Pin: the creator's own session cannot PATCH a link's game past set_fan_pass_game (${patch.ok ? 'accepted' : patch.err.split('\n')[0]})`);
    const direct = runIn(`update public.fan_passes set pinned_wheel_id=${q(w2)} where id=${q(s)};`);
    check(!direct.ok && /use set_fan_pass_game/.test(direct.err), 'Pin: no role writes a link\'s game directly');
    const forged = runIn(`select set_config('fanfunnel.pass_game_write',${q(randomUUID())},true);update public.fan_passes set pinned_wheel_id=${q(w2)} where id=${q(s)};`);
    check(!forged.ok && /use set_fan_pass_game/.test(forged.err), "Pin: the writer mark covers only the pass set_fan_pass_game is writing");
    const minted = runIn(`insert into public.fan_passes(creator_id,fan_id,wheel_id,pinned_wheel_id,token) values(${q(owner)},${q(f)},${q(w)},${q(w2)},'pin-new-${s}');`);
    check(!minted.ok && /use set_fan_pass_game/.test(minted.err), 'Pin: a new link cannot be inserted already set to a game');
    const other = runIn(`begin;${asUser(owner, `update public.fan_passes set last_spin_at=now() where id=${q(s)} returning id;`)}commit;`);
    check(other.ok, `Pin: other link updates are unaffected (${other.err.split('\n')[0] || 'ok'})`);
    check(runIn(`select coalesce(pinned_wheel_id::text,'null') from public.fan_passes where id=${q(s)};`).out === 'null', 'Pin: every refused write left the link following its campaign and the live game');
    const del = runIn(`begin;${asUser(owner, `delete from public.redemptions where creator_id=${q(owner)};`)}commit;`);
    check(!del.ok && /permission denied for table redemptions/.test(del.err), `A35: a session cannot delete a redemption and its recorded cost (${del.ok ? 'accepted' : del.err.split('\n')[0]})`);
    const read = runIn(`begin;${asUser(owner, 'select count(*) from public.redemptions;')}commit;`);
    check(read.ok, `A35: the creator still reads their redemptions (${read.err.split('\n')[0] || 'ok'})`);
    const upd = runIn(`begin;${asUser(owner, "update public.redemptions set notes='x' where false;")}commit;`);
    check(upd.ok, `A35: fulfilment updates keep their grant (${upd.err.split('\n')[0] || 'ok'})`);
  } catch (error) { bad.push(`pin/redemption probe: ${error instanceof Error ? error.message : error}`); }
  finally { if (grantsMade) psql(db, ['-c', `drop database "${grantsDb}" with (force);`], { allowFail: true }); }

  // ------------------------------------------------------------------ A17
  const clone = `a17_${randomUUID().replaceAll('-', '').slice(0, 16)}`; let made = false;
  try {
    let r = psql(db, ['-c', `create database "${clone}" template "${db}";`], { allowFail: true }); if (r.status !== 0) throw Error(`clone failed ${(r.stderr || '').trim()}`); made = true;
    const runIn = sql => { const res = psql(clone, ['-c', sql], { allowFail: true }); if (res.status !== 0) throw Error(`${sql.slice(0, 80)}: ${(res.stderr || '').trim()}`); return (res.stdout || '').trim(); };
    const users = Array.from({ length: 10 }, () => randomUUID());
    const email = id => `bootstrap-${id}@example.test`;
    // Start from zero administrators (a fresh project), bypassing the last-admin guard in this disposable clone only.
    const reset = () => runIn(`alter table public.profiles disable trigger user;update public.profiles set role='creator' where role='admin';alter table public.profiles enable trigger user;`);
    runIn(`insert into auth.users(id,email,email_confirmed_at) values ${users.map((id, i) => `(${q(id)},'${email(id)}',${i === 9 ? 'null' : 'now()'})`).join(',')};`);
    reset();
    const claim = (id, mail = email(id)) => `set local role service_role;select public.bootstrap_first_admin(${q(id)},${q(mail)});`;
    const admins = () => runIn(`select count(*)||':'||coalesce(string_agg(id::text,','),'') from public.profiles where role='admin';`);
    for (const role of ['anon', 'authenticated']) {
      const denied = psql(clone, ['-c', `begin;set local role ${role};select public.bootstrap_first_admin(${q(users[0])},'${email(users[0])}');rollback;`], { allowFail: true });
      check(/permission denied for function bootstrap_first_admin/.test(denied.stderr || ''), `A17: ${role} cannot call bootstrap_first_admin`);
    }
    check(runIn(`begin;${claim(users[9])}commit;`).split('\n').at(-1) === 'email_unconfirmed', 'A17: an unconfirmed email cannot claim the first admin');
    check(runIn(`begin;${claim(users[0], email(users[1]))}commit;`).split('\n').at(-1) === 'email_unconfirmed', "A17: an allow-listed address must be the account's own");
    check(admins().startsWith('0:'), 'A17: refused claims create no admin');
    // Barrier race: the first claim holds the fence until the second is seen waiting on it.
    const tag = `ff-a17-${randomUUID().slice(0, 8)}`;
    const first = psqlAsync(clone, `begin;set local statement_timeout='20s';${claim(users[0])}reset role;set local application_name='${tag}-held';${seen(`${tag}-second`, " and wait_event_type='Lock'")}commit;`);
    const ready = await psqlAsync(clone, `${seen(`${tag}-held`, '')}select count(*) from pg_stat_activity where application_name='${tag}-held';`);
    check(ready.stdout.trim() === '1', 'A17: the first claim reached its barrier holding the fence');
    const second = psqlAsync(clone, `begin;set local statement_timeout='20s';set local application_name='${tag}-second';${claim(users[1])}commit;`);
    const [one, two] = await Promise.all([first, second]);
    check(!/statement timeout/.test(one.stderr || '') && one.status === 0 && two.status === 0, `A17: both racing claims finish (${(one.stderr || two.stderr || 'clean').trim().split('\n')[0]})`);
    check(one.stdout.trim().split('\n').includes('ok') && two.stdout.trim().split('\n').at(-1) === 'already_bootstrapped', `A17: the claim that waited sees the first admin (${one.stdout.trim().replace(/\n/g, ' ')} / ${two.stdout.trim()})`);
    check(admins() === `1:${users[0]}`, `A17: exactly one admin after the barrier race (${admins()})`);
    // An unsynchronised burst: eight confirmed accounts claim at once.
    for (let round = 0; round < 3; round++) {
      reset();
      const results = await Promise.all(users.slice(1, 9).map(id => psqlAsync(clone, `begin;${claim(id)}commit;`)));
      const answers = results.map(res => res.status === 0 ? res.stdout.trim().split('\n').at(-1) : `exit${res.status}`).sort();
      check(answers.filter(a => a === 'ok').length === 1 && answers.filter(a => a === 'already_bootstrapped').length === 7, `A17 burst ${round + 1}: exactly one of eight concurrent claims wins (${answers.join(',')})`);
      check(admins().startsWith('1:'), `A17 burst ${round + 1}: exactly one admin exists (${admins()})`);
    }
    check(runIn(`begin;${claim(users[0])}commit;`).split('\n').at(-1) === 'already_bootstrapped', 'A17: once an admin exists the bootstrap is inert');
  } catch (error) { bad.push(`A17 probe: ${error instanceof Error ? error.message : error}`); }
  finally { if (made) psql(db, ['-c', `drop database "${clone}" with (force);`], { allowFail: true }); }
  return { bad, checks };
}
