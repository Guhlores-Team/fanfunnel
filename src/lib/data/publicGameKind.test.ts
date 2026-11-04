// A52: the share card and the link-in-bio page carry the game kind from the
// database (Supabase path), so their copy is right for scratch and bingo.
import assert from "node:assert/strict";
import { mock } from "node:test";

let passed = 0;
const check = (label: string, cond: unknown) => { assert.ok(cond, label); passed++; };

let spinRow: Record<string, unknown> | null = null;
let wheelRow: Record<string, unknown> | null = null;
const selects: string[] = [];
function table(name: string) {
  const q = {
    select(cols: string) { selects.push(`${name}:${cols}`); return q; },
    eq() { return q; },
    async maybeSingle() {
      if (name === "spins") return { data: spinRow, error: null };
      if (name === "profiles") return { data: { id: "creator-1", display_name: "Ava", public_tagline: null, tip_url: null, avatar_url: null }, error: null };
      if (name === "wheels") return { data: wheelRow, error: null };
      return { data: null, error: null };
    },
  };
  return q;
}
mock.module("@/lib/supabase/server", { namedExports: {
  isSupabaseConfigured: () => true,
  createClient: async () => ({ from: table }),
  createServiceClient: () => ({ from: table }),
} });
mock.module("./wheels", { namedExports: { resolveActiveWheelId: async () => (wheelRow ? "wheel-1" : null), getActiveHappyHour: async () => null } });
mock.module("./creatorTheme", { namedExports: { getCreatorThemeView: async () => ({ theme: {}, media: [], bgUrl: null }) } });

const wheel = (gameKind: string, gameConfig: unknown = {}) => ({ id: "wheel-1", title: "Live", subtitle: null, brand_color: "#123456", label_color: null, label_size: null,
  show_stock: false, game_kind: gameKind, game_config: gameConfig, game_ready: true, is_active: true, active_from: null, active_until: null, archived_at: null, prizes: [] });

async function main() {
  const { getShareCard } = await import("./boosts");
  const { getPublicProfileBySlug } = await import("./publicProfile");
  const base = { prize_label: "Signed photo", prize_rarity: "rare", prize_image_url: null, created_at: "2026-11-04T00:00:00Z", creator: { display_name: "Ava" } };
  for (const kind of ["wheel", "scratch", "bingo"] as const) {
    spinRow = { ...base, game_kind: kind };
    check(`a ${kind} win's share card carries its kind`, (await getShareCard("share-1"))?.gameKind === kind);
  }
  check("the share card reads game_kind from the spin row", selects.some((s) => s.startsWith("spins:") && s.includes("game_kind")));
  spinRow = { ...base, game_kind: null };
  check("a row without a kind reads as the wheel", (await getShareCard("share-1"))?.gameKind === "wheel");
  spinRow = null;
  check("an unknown share id is still not found", (await getShareCard("missing")) === null);

  wheelRow = wheel("scratch");
  check("the public page names a live scratch game", (await getPublicProfileBySlug("ava"))?.profile.gameKind === "scratch");
  wheelRow = wheel("bingo", { size: 3, linePrizeId: "p1" });
  check("the public page names a live bingo game", (await getPublicProfileBySlug("ava"))?.profile.gameKind === "bingo");
  wheelRow = wheel("wheel");
  check("the public page names a live wheel", (await getPublicProfileBySlug("ava"))?.profile.gameKind === "wheel");
  wheelRow = null;
  check("no live game reads as the wheel (the default copy)", (await getPublicProfileBySlug("ava"))?.profile.gameKind === "wheel");
  console.log(`publicGameKind.test: ${passed} checks passed`);
}
main().catch((error) => { console.error(error); process.exit(1); });
