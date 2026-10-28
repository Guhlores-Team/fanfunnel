import assert from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// #26 (migration 0057): static guards, in the migration AND both snapshots.
//  1. The three reward tables enable RLS with SELECT-only policies; anon loses
//     everything and authenticated gets column grants that never include
//     cipher or iv. No write policy and no grant back, anywhere.
//  2. Every reward function is SECURITY DEFINER with a pinned search_path and
//     revoked from public/anon/authenticated (granted to service_role only).
//  3. The spin insert refuses an undeliverable prize; a code prize's stock is
//     recounted on every write; codes are reserved under the prize row lock.
//  4. WHEEL_SELECT and the fan projection never reach a reward column.
// The runtime half (and the 20-way race) is in scripts/db/schema-drift-check.mjs.

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}
const ROOT = join(import.meta.dirname, "../../..");
const SUPA = join(ROOT, "supabase");
const read = (p: string) => readFileSync(p, "utf8");
const norm = (s: string) => s.replace(/--[^\n]*/g, " ").replace(/\s+/g, " ").toLowerCase();
const files: Record<string, string> = {
  "0057": norm(read(join(SUPA, "migrations/0057_instant_rewards.sql"))),
  "schema.sql": norm(read(join(SUPA, "schema.sql"))),
  "migrations_combined.sql": norm(read(join(SUPA, "migrations_combined.sql"))),
};
const everywhere = norm(
  [read(join(SUPA, "schema.sql")), read(join(SUPA, "migrations_combined.sql")), ...readdirSync(join(SUPA, "migrations")).map((f) => read(join(SUPA, "migrations", f)))].join("\n"),
);
const TABLES = ["prize_rewards", "prize_reward_codes", "spin_rewards"];
const FUNCS: [string, string][] = [
  ["reserve_reward_code", "uuid, uuid"],
  ["release_reward_code", "uuid"],
  ["add_reward_codes", "uuid, uuid, jsonb"],
  ["set_prize_delivery", "uuid, uuid, text, text, text, smallint"],
  ["record_reward_view", "uuid"],
];

for (const [name, s] of Object.entries(files)) {
  for (const t of TABLES) {
    check(`${name}: ${t} enables RLS`, s.includes(`alter table public.${t} enable row level security`));
    const pols = [...s.matchAll(new RegExp(`create policy (\\w+) on public\\.${t} for (\\w+)`, "g"))];
    check(`${name}: ${t} has exactly one policy, FOR SELECT`, pols.length === 1 && pols[0][2] === "select");
    check(`${name}: ${t} revokes all from anon and authenticated`, s.includes(`revoke all on table public.${t} from anon, authenticated;`));
    const grant = s.match(new RegExp(`grant select \\(([^)]*)\\) on table public\\.${t} to authenticated;`));
    check(`${name}: ${t} column grant excludes cipher and iv`, !!grant && !/\b(cipher|iv)\b/.test(grant[1]));
  }
  for (const [fn, sig] of FUNCS) {
    check(`${name}: ${fn} is security definer with search_path`, new RegExp(`create or replace function public\\.${fn}\\([^)]*\\)[^$]*security definer set search_path = public`).test(s));
    check(`${name}: ${fn} revoked from public, anon, authenticated`, s.includes(`revoke execute on function public.${fn}(${sig}) from public, anon, authenticated;`));
    check(`${name}: ${fn} granted to service_role`, s.includes(`grant execute on function public.${fn}(${sig}) to service_role;`));
  }
  check(`${name}: spin insert refuses a code prize with no reserved code`, s.includes("raise exception 'no reward code reserved for this spin'"));
  check(`${name}: spin insert refuses an instant prize with no reward`, s.includes("raise exception 'instant prize has no reward'"));
  check(`${name}: trg_attach_spin_reward runs after insert on spins`, s.includes("create trigger trg_attach_spin_reward after insert on public.spins"));
  check(`${name}: code stock recounted before every prize write`, s.includes("create trigger trg_sync_code_prize_stock before insert or update on public.prizes"));
  check(`${name}: reservation locks the prize row`, /reserve_reward_code[\s\S]*?perform 1 from public\.prizes where id = p_prize and delivery = 'codes' for update;/.test(s));
  check(`${name}: one code per spin, one spin per delivered code`, /spin_id uuid unique/.test(s) && /code_id uuid unique references public\.prize_reward_codes/.test(s));
  check(`${name}: release refuses once the spin is recorded`, /release_reward_code[\s\S]*?if exists \(select 1 from public\.spins where id = p_spin\) then return false;/.test(s));
}
for (const t of TABLES) {
  check(`no write policy on ${t} anywhere`, !new RegExp(`create policy \\w+ on public\\.${t} for (insert|update|delete|all)\\b`).test(everywhere));
  check(`no policy on ${t} without a FOR clause`, !new RegExp(`create policy \\w+ on public\\.${t} (using|with check)`).test(everywhere));
  check(`nothing grants a write on ${t}`, !new RegExp(`grant [^;]*(insert|update|delete|all)[^;]* on (table )?public\\.${t}\\b`).test(everywhere));
  check(`nothing grants ${t}.cipher back`, !new RegExp(`grant select \\([^)]*\\bcipher\\b[^)]*\\) on table public\\.${t}`).test(everywhere));
}

const shared = read(join(ROOT, "src/lib/data/shared.ts"));
const wheelSelect = shared.match(/WHEEL_SELECT =\s*`([\s\S]*?)`/)?.[1] ?? "";
check("WHEEL_SELECT reads no reward table or secret", wheelSelect.length > 0 && !/reward|cipher|\biv\b|hint/.test(wheelSelect));
const view = read(join(ROOT, "src/lib/games/wheel/publicView.ts"));
const toPublic = view.match(/export function toPublicPrize[\s\S]*?\n}/)?.[0] ?? "";
check("toPublicPrize never copies delivery or a reward", toPublic.length > 0 && !/delivery|reward/.test(toPublic));
const env = [".env.example", "README.md"].map((f) => { try { return read(join(ROOT, f)); } catch { return ""; } }).join("\n");
check("the key is never documented as a NEXT_PUBLIC_ var", !/NEXT_PUBLIC_REWARD/.test(env));

console.log(`instantRewards.test: ${passed} checks passed`);
