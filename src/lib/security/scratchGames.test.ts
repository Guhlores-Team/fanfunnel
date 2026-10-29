// Static boundary guards supplement scripts/db/scratchGamesProbe.mjs, which
// commits actual pure-engine faces through disposable PostgreSQL transactions.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const sql=readFileSync(new URL("../../../supabase/migrations/0060_scratch_games.sql",import.meta.url),"utf8");
let checks=0;const check=(value:unknown,label:string)=>{assert.ok(value,label);checks++;};
for(const [table,column] of [["wheels","game_kind"],["wheels","game_config"],["wheels","game_ready"],["wheel_templates","game_kind"],["wheel_templates","game_config"],["wheel_templates","game_ready"],["spins","game_kind"],["spins","presentation"]])check(sql.includes(`alter table public.${table} add column if not exists ${column}`),`${table}.${column} exists`);
for(const table of ["wheels","wheel_templates"])check(sql.includes(`on public.${table} for each row execute function public._guard_game_settings()`),`${table} direct writes share authoritative feature guard`);
for(const [name,args] of [["_game_feature_allowed","uuid,text"],["_guard_game_settings",""],["_scratch_visible","text"],["_valid_scratch_presentation","jsonb,uuid,jsonb"],["_guard_immutable_game_proof",""]])check(sql.includes(`revoke execute on function public.${name}(${args}) from public,anon,authenticated,service_role;`),`${name} is private`);
check(sql.includes("features->'scratch'='true'::jsonb"),"feature source is the server-controlled profiles row");
check(!/user_metadata|app_metadata/.test(sql),"editable user metadata never authorizes games");
check(sql.includes("if new.game_kind='bingo' then raise exception 'game_unavailable'"),"bingo stays unavailable until0061 transaction exists");
check(sql.includes("exists(select 1 from public.spins where wheel_id=old.id)"),"first credited play locks kind");
check(sql.includes("perform 1 from public.wheels where id=public._resolved_spin_wheel(p.id) for update;"),"commit serializes game edits before checking context/debit");
check(sql.includes("s.game_kind is distinct from current_context#>>'{wheel,game_kind}'"),"caller cannot choose game kind");
check(sql.includes("snapshot->'gameConfig' is distinct from current_context#>'{wheel,game_config}'"),"proof config matches authoritative current wheel");
check(sql.includes("s.fair_trace->'bonuses' is distinct from '[]'::jsonb"),"scratch cannot invent line bonuses");
check(sql.includes("'gameKind',s.game_kind,'presentation',s.presentation,'bonusWins','[]'::jsonb"),"one immutable result contains face and explicit empty bonus list");
check(sql.includes("new.presentation is distinct from old.presentation"),"stored face cannot be edited after commit");
check(sql.includes("return wins=3 and cardinality(ids)=7"),"exactly one winning triple and six unique decoys");
check(!sql.includes("create table"),"0060 introduces no unaudited auxiliary state tables");
console.log(`scratchGames.test: ${checks} authoritative game, immutable proof and private-helper guards passed`);
