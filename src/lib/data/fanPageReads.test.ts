import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { mock } from "node:test";
import { LEGAL } from "@/lib/legal";

// A41: the fan page (/spin/[token]) no longer waits on its reads one after
// another. Once the pass is known, the seed commitment, the wheel resolution
// and the focus/odds read run together, and the fan's history/wishlist/happy
// hour/play/glow (plus a bingo card) run together after the wheel is known.
// Every query here takes the same fixed delay, so the page's critical path is
// counted in "waves": it must be at most 4 (pass → wheel resolve → wheel row
// → history batch), with the commitment and focus read inside them.
// The error UI is a segment error.tsx (no loading.tsx anywhere: with
// htmlLimitedBots the metadata must stay blocking, see next.config.ts).

let passed = 0;
const check = (label: string, cond: unknown) => { assert.ok(cond, label); passed++; };

const DELAY = 25;
type Span = { name: string; start: number; end: number };
const spans: Span[] = [];
let t0 = 0;
const timed = async <T>(name: string, value: T): Promise<T> => {
  const start = Date.now() - t0;
  await new Promise((r) => setTimeout(r, DELAY));
  spans.push({ name, start, end: Date.now() - t0 });
  return value;
};

const PRIZES = [{ id: "p1", label: "Shoutout", description: null, rarity: "common", weight: 1, color: null, emoji: null, image_url: null, cost_cents: 0, stock: null, sort_order: 0 }];
const PASS = {
  id: "pass-1", creator_id: "creator-1", campaign_id: null, wheel_id: "wheel-1", fan_id: "fan-1", is_active: true,
  spins_remaining: 3, next_server_seed_hash: null,
  fan: { id: "fan-1", display_name: "Sam", handle: null, spins_remaining: 3, spins_granted_total: 3, referral_code: "R", acked_at: "2026-01-01T00:00:00Z", acked_terms_version: LEGAL.version, leaderboard_opt_in: false, blocked_at: null },
  creator: { display_name: "Creator", tip_url: null, leaderboard_enabled: false, creator_note: null, avatar_url: null, is_active: true, approval_status: "approved", role: "creator" },
};
const WHEEL = { id: "wheel-1", title: "W", subtitle: null, brand_color: "#ec4899", label_color: null, label_size: null, show_stock: true, is_active: true, active_from: null, active_until: null, archived_at: null, game_ready: true, game_kind: "wheel", prizes: PRIZES };

function fakeClient() {
  const from = (table: string) => {
    const ops: { name: string; args: unknown[] }[] = [];
    const proxy: unknown = new Proxy({}, {
      get(_t, prop) {
        if (prop === "then") {
          return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => {
            const sel = String(ops.find((o) => o.name === "select")?.args[0] ?? "");
            let data: unknown = null;
            if (table === "fan_passes") data = PASS;
            else if (table === "wheels") data = sel.includes("prizes(") ? WHEEL : ops.some((o) => o.name === "maybeSingle") ? { id: "wheel-1" } : [{ id: "wheel-1", is_active: true, active_from: null, active_until: null, game_ready: true, archived_at: null, created_at: "2026-01-01T00:00:00Z" }];
            else if (table === "fans") data = { pity_counter: 0 };
            else data = [];
            return timed(`${table}:${sel.slice(0, 24)}`, { data, error: null }).then(res, rej);
          };
        }
        return (...args: unknown[]) => { ops.push({ name: String(prop), args }); return proxy; };
      },
    });
    return proxy;
  };
  return {
    from,
    rpc: (name: string) => timed(`rpc:${name}`, {
      data: name === "ensure_pass_commitment" ? { hash: "a".repeat(64) } : name === "get_fan_focus_state" ? { status: "ok", focus: null } : null,
      error: null,
    }),
  };
}

mock.module("@/lib/supabase/server", {
  namedExports: {
    isSupabaseConfigured: () => true,
    createClient: async () => fakeClient(),
    createServiceClient: () => fakeClient(),
  },
});

function waves(list: Span[]): number {
  // Greedy: a new wave starts when a span starts after every span of the current wave ended.
  const sorted = [...list].sort((a, b) => a.start - b.start);
  let count = 0, waveEnd = -1;
  for (const s of sorted) if (s.start >= waveEnd) { count++; waveEnd = s.end; } else waveEnd = Math.max(waveEnd, s.end);
  return count;
}

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((e) => (statSync(join(dir, e)).isDirectory() ? files(join(dir, e)) : [join(dir, e)]));
}

async function main() {
  const { getFanPass } = await import("./spins");
  t0 = Date.now();
  const pass = await getFanPass("tok-parallel");
  check("the fan page loads from the fake database", pass !== null && pass.nextSpinHash === "a".repeat(64));
  const commit = spans.find((s) => s.name === "rpc:ensure_pass_commitment");
  const focus = spans.find((s) => s.name === "rpc:get_fan_focus_state");
  const firstWheel = spans.filter((s) => s.name.startsWith("wheels:")).sort((a, b) => a.start - b.start)[0];
  check("the commitment, the wheel read and the focus read start together", !!commit && !!focus && !!firstWheel
    && commit.start < firstWheel.end && firstWheel.start < commit.end && focus.start < commit.end);
  const history = spans.find((s) => s.name.startsWith("spins:"));
  const wish = spans.find((s) => s.name.startsWith("wishlists:"));
  check("history and wishlist still run together", !!history && !!wish && history.start < wish.end && wish.start < history.end);
  const n = waves(spans);
  check(`the critical path is at most 4 waves (saw ${n}: ${spans.map((s) => `${s.name}@${s.start}`).join(", ")})`, n <= 4);

  // Error and loading boundaries.
  const spinError = "src/app/spin/[token]/error.tsx";
  const publicError = "src/app/c/[slug]/error.tsx";
  for (const f of [spinError, publicError]) {
    check(`${f} exists`, existsSync(f));
    check(`${f} is a client error boundary`, readFileSync(f, "utf8").trimStart().startsWith('"use client"'));
  }
  check("the fan error keeps the data controls (download/delete)", readFileSync(spinError, "utf8").includes("LinkDataRescue"));
  check("no loading.tsx under src/app (metadata must stay blocking with htmlLimitedBots)", !files("src/app").some((f) => /[\\/]loading\.(t|j)sx?$/.test(f)));
  check("next.config still blocks metadata for every user agent", /htmlLimitedBots:\s*\/\.\*\//.test(readFileSync("next.config.ts", "utf8")));

  console.log(`fan page reads: ${passed} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
