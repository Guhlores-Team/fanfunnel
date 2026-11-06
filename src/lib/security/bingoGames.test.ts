// Static boundaries supplement actual pure-engine/PostgreSQL race probes.
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const sql=readFileSync(new URL("../../../supabase/migrations/0061_personal_bingo.sql",import.meta.url),"utf8");
let checks=0;const check=(v:unknown,label:string)=>{assert.ok(v,label);checks++;};
for(const table of["bingo_cards","bingo_line_awards"]){check(sql.includes(`alter table public.${table} enable row level security`),`${table} RLS`);check(new RegExp(`create policy \\w+ on public\\.${table} for select to authenticated using\\(public\\.can_act_for\\(creator_id,'view'\\) or public\\.is_admin\\(\\)\\)`).test(sql),`${table} tenant read policy`);check(sql.includes(`on public.${table} for each row execute function public._guard_bingo_state_write()`),`${table} direct mutation guarded`);}
for(const [name,args] of[["_bingo_completed_lines","integer"],["_bingo_cells_valid","jsonb"],["_bingo_public_state","jsonb"],["_bingo_ready_error","uuid"],["_guard_bingo_state_write",""],["_guard_bingo_prize_change",""],["_guard_bingo_wheel_lifecycle",""],["_game_actor_edit_allowed","uuid,uuid"],["_validate_bingo_presentation","jsonb,jsonb,jsonb,uuid"],["_validate_bingo_snapshot","jsonb,jsonb,jsonb"],["_commit_bingo_bonus","uuid,jsonb,integer"]])check(sql.includes(`revoke execute on function public.${name}(${args}) from public,anon,authenticated,service_role;`),`${name} private`);
for(const [name,args] of[["save_game_wheel","uuid,uuid,jsonb,jsonb,uuid"],["get_bingo_card_state","text"]]){check(sql.includes(`revoke execute on function public.${name}(${args}) from public,anon,authenticated;`),`${name} browser denied`);check(sql.includes(`grant execute on function public.${name}(${args}) to service_role;`),`${name} service allowed`);}
check(sql.includes("primary key(card_id,line_index),unique(primary_spin_id,line_index)"),"one award per card line and parent line");
check(sql.includes("bonus_spin_id uuid not null unique"),"one line owns each bonus spin");
check(sql.includes("on public.bingo_cards(fan_id,wheel_id) where status='active'"),"one active card per fan/game");
check(sql.includes("exception when sqlstate 'P0061' then return sqlerrm::jsonb"),"recoverable candidate reply follows whole-attempt rollback");
check(sql.includes("not public._game_actor_edit_allowed(p_actor,p_creator)"),"atomic publication checks current actual actor");
check(sql.includes("p_parent.campaign_id,null,'bingo','bonus'"),"bonus references parent proof without independent seed claim");
check(sql.includes("old.status='complete'"),"completed card cannot reset in place");
check(sql.includes("new.stock is not null or new.delivery='codes' or new.weight<=0"),"active cells stay unlimited non-code positive weight");
check(sql.includes("'bingo_active_card'"),"incompatible paid-card lifecycle changes refuse explicitly");
check(sql.includes("excluded_all:=excluded_all||to_jsonb(excluded_id)"),"exclusions advance only while processing ordered lines");
check(sql.includes("reserved_focus_id is null for update"),"bonus allocation excludes held primary codes");
check(sql.includes("'bonusWins',bonuses"),"all bonus receipts persist inside original attempt");
check(!/user_metadata|app_metadata/.test(sql),"roles/features never use editable metadata");
console.log(`bingoGames.test: ${checks} RLS, atomicity, actor, proof, reservation and lifecycle guards passed`);
