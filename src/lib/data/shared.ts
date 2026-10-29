// Data layer — shared helpers: row shapes, selects, the client type, small
// guards and the wheel row -> WheelConfig mapper used by several domains.
//
// Error convention (every module under src/lib/data follows it):
//  * A mutation returns a discriminated result and never throws for an
//    expected failure: `{ ok: true } | { error: string }`, or
//    `{ <payload> } | { error: string }` when it has something to hand back.
//    Callers branch on `"error" in result`.
//  * `error` is a short lowercase_snake code, never prose and never a raw DB
//    message. Shared codes: "unauthorized" (no session / not the owner),
//    "not_found" (no such row for this creator), "db_error" (any Supabase
//    failure — the detail goes to console.error, never to the client),
//    "rate_limited", "blocked", "needs_ack". Domain codes ("no_spins",
//    "campaign_not_found", "invalid_url", ...) follow the same shape. Routes
//    map a code to an HTTP status in src/lib/api/handler.ts (statusForError)
//    and the fan-facing copy lives in src/components/spinErrors.ts.
//  * `SpinError` below is the closed union the spin path returns, so the
//    fan-facing mapper can be exhaustive.
//  * A read (get*/list*) returns `null`, `[]` or a default instead of an error
//    result, and never throws when signed out.
//  * One deliberate exception: the create* functions that return the created
//    entity directly (createWheel, duplicateWheel, createCampaignPack,
//    createPrizeTemplate, createWheelTemplate) `throw new Error("<code>")`
//    with the same codes; their routes catch and pass the message through
//    errorResponse().
import { createServiceClient, createClient } from "@/lib/supabase/server";
import type { Prize, Rarity, WheelConfig } from "@/lib/games/wheel/types";
import { RARITY_COLORS } from "@/lib/games/wheel/types";
import { SHOW_STOCK_DEFAULT } from "@/lib/games/wheel/publicView";
import { PRIZE_DELIVERIES, type PrizeDelivery } from "@/lib/rewards/config";
import type { Enums, Tables } from "./db.types";

export function randomToken(): string {
  // URL-safe, unguessable token for a fan link.
  return Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export type { FanPassView } from "./types";
export type SpinError = { error: "not_found" | "no_spins" | "no_prizes" | "rate_limited" | "blocked" | "on_break" | "needs_ack" | "db_error" | "spin_pending" };

/** True if `s` is a canonical UUID — used to keep raw ids out of filter strings. */
export function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

/**
 * True when `campaignId` belongs to the authenticated creator. A null/undefined
 * id means "no campaign" and is always allowed; a non-null id the creator does
 * not own (or that does not exist) is rejected so a client-supplied value can't
 * create a cross-tenant campaign reference or an FK failure on later writes.
 * Callers MUST verify before persisting any client-supplied campaign id.
 */
export async function creatorOwnsCampaign(
  sb: AnyClient,
  userId: string,
  campaignId: string | null | undefined
): Promise<boolean> {
  if (campaignId == null) return true;
  const { data } = await sb
    .from("campaigns")
    .select("id")
    .eq("id", campaignId)
    .eq("creator_id", userId)
    .maybeSingle();
  return !!data;
}

// Phase 3 referral economy: how many referrals a fan can be credited for, and
// how many bonus spins each credited referral grants to BOTH parties.
export const REFERRAL_CAP = 3;
export const REFERRAL_BONUS = 3;

// Shapes of the Supabase rows we read (keeps us off `any`), derived from the
// generated schema types (./db.types.ts, `npm run gen:types`, drift-checked in
// CI) so a renamed or retyped column fails typecheck instead of drifting.
type DbPrizeRow = Pick<
  Tables<"prizes">,
  | "id"
  | "label"
  | "description"
  | "rarity"
  | "weight"
  | "color"
  | "emoji"
  | "image_url"
  | "cost_cents"
  | "stock"
  | "sort_order"
> &
  Partial<Pick<Tables<"prizes">, "delivery">> & { boostable?: boolean };
type WheelRow = Tables<"wheels">;
// label_color: Phase 9 (#11) prize-label color (migration 0025); label_size:
// per-wheel label text size (0037); show_stock: RM-2 "Show stock to fans"
// (0048). Lifecycle columns are optional because some selects leave them out.
export interface DbWheelRow
  extends Pick<WheelRow, "id" | "title" | "subtitle" | "brand_color">,
    Partial<
      Pick<WheelRow, "label_color" | "label_size" | "show_stock" | "is_active" | "active_from" | "active_until" | "archived_at">
    > {
  game_kind?: string;
  game_config?: unknown;
  game_ready?: boolean;
  game_kind_locked?: boolean;
  prizes: DbPrizeRow[];
}

// Compile-time guard: the app's Rarity union must equal the DB prize_rarity enum.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type AssertTrue<T extends true> = T;
type _RarityMatchesDb = AssertTrue<Same<Rarity, Enums<"prize_rarity">>>;

// The columns we select to load a wheel's full config (prizes joined).
export const WHEEL_SELECT =
  `id, title, subtitle, brand_color, label_color, label_size, show_stock, game_kind, game_config, game_ready, is_active, active_from, active_until, archived_at,
   prizes(id, label, description, rarity, weight, color, emoji, image_url, cost_cents, stock, sort_order, delivery, boostable)`;

// Any Supabase client (auth-scoped or service-role) we resolve wheels with.
export type AnyClient =
  | Awaited<ReturnType<typeof createClient>>
  | ReturnType<typeof createServiceClient>;

// Postgres `integer` (int4) bounds. weight/cost_cents/stock are int4 columns,
// so values outside this range are rejected by the DB. Clamp instead of letting
// the INSERT fail (see saveWheel).
const PG_INT4_MAX = 2147483647;
const PG_INT4_MIN = -2147483648;
export function clampInt(n: number, min = PG_INT4_MIN, max = PG_INT4_MAX): number {
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

const isPrizeDelivery = (v: unknown): v is PrizeDelivery =>
  typeof v === "string" && (PRIZE_DELIVERIES as readonly string[]).includes(v);

// ---------------------------------------------------------------------------
export function toWheelConfig(wheel: DbWheelRow): WheelConfig {
  const prizes: Prize[] = (wheel.prizes ?? [])
    .slice()
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.id.localeCompare(b.id))
    .map((p) => ({
      id: p.id,
      label: p.label,
      description: p.description ?? undefined,
      rarity: p.rarity,
      weight: p.weight,
      color: p.color ?? RARITY_COLORS[p.rarity],
      emoji: p.emoji ?? undefined,
      imageUrl: p.image_url ?? null,
      cost: p.cost_cents ?? null,
      stock: p.stock ?? null,
      // #26 (migration 0057): creator-only; toPublicPrize never copies it.
      delivery: isPrizeDelivery(p.delivery) ? p.delivery : "manual",
      boostable: p.boostable === true,
    }));

  return {
    id: wheel.id,
    title: wheel.title,
    gameKind: wheel.game_kind === "scratch" ? "scratch" : wheel.game_kind === "bingo" ? "bingo" : "wheel",
    gameConfig: wheel.game_kind === "scratch" ? { style: "classic" } : wheel.game_kind === "bingo" ? wheel.game_config as WheelConfig["gameConfig"] : {},
    gameReady: wheel.game_ready !== false,
    gameKindLocked: wheel.game_kind_locked !== false,
    subtitle: wheel.subtitle ?? undefined,
    brandColor: wheel.brand_color ?? "#ec4899",
    // #11: undefined when unset so Wheel.tsx falls back to its auto-pick.
    labelColor: wheel.label_color ?? undefined,
    labelSize: (wheel.label_size as WheelConfig["labelSize"]) ?? undefined,
    // RM-2: an older row/select without the column reads as the default.
    showStock: wheel.show_stock ?? SHOW_STOCK_DEFAULT,
    prizes,
  };
}
