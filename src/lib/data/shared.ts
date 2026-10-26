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

export function randomToken(): string {
  // URL-safe, unguessable token for a fan link.
  return Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export type { FanPassView } from "./types";
export type SpinError = { error: "not_found" | "no_spins" | "no_prizes" | "rate_limited" | "blocked" | "needs_ack" | "db_error" };

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

// Shapes of the Supabase rows we read (keeps us off `any`).
interface DbPrizeRow {
  id: string;
  label: string;
  description: string | null;
  rarity: Rarity;
  weight: number;
  color: string | null;
  emoji: string | null;
  image_url: string | null;
  cost_cents: number | null;
  stock: number | null;
  sort_order: number | null;
}
export interface DbWheelRow {
  id: string;
  title: string;
  subtitle: string | null;
  brand_color: string | null;
  /** Phase 9 (#11): creator-chosen prize-label color (migration 0025). */
  label_color?: string | null;
  /** Per-wheel prize-label text size (migration 0037). */
  label_size?: string | null;
  is_active?: boolean;
  active_from?: string | null;
  active_until?: string | null;
  archived_at?: string | null;
  prizes: DbPrizeRow[];
}

// The columns we select to load a wheel's full config (prizes joined).
export const WHEEL_SELECT =
  `id, title, subtitle, brand_color, label_color, label_size, is_active, active_from, active_until, archived_at,
   prizes(id, label, description, rarity, weight, color, emoji, image_url, cost_cents, stock, sort_order)`;

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

// ---------------------------------------------------------------------------
export function toWheelConfig(wheel: DbWheelRow): WheelConfig {
  const prizes: Prize[] = (wheel.prizes ?? [])
    .slice()
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
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
    }));

  return {
    id: wheel.id,
    title: wheel.title,
    subtitle: wheel.subtitle ?? undefined,
    brandColor: wheel.brand_color ?? "#ec4899",
    // #11: undefined when unset so Wheel.tsx falls back to its auto-pick.
    labelColor: wheel.label_color ?? undefined,
    labelSize: (wheel.label_size as WheelConfig["labelSize"]) ?? undefined,
    prizes,
  };
}
