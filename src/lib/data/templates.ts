import { gameSettings, gameWriteError, requireGameFeature } from "./gameSettings";
// Data layer — reusable prize and wheel templates.
import { isSupabaseConfigured, createClient } from "@/lib/supabase/server";
import type { Prize, Rarity, WheelConfig } from "@/lib/games/wheel/types";
import { MAX_WHEEL_PRIZES } from "@/lib/games/wheel/types";
import { storedWeight } from "@/lib/games/wheel/weights";
import type { PrizeTemplate, WheelTemplate } from "./types";
import {
  mockListPrizeTemplates,
  mockCreatePrizeTemplate,
  mockDeletePrizeTemplate,
  mockListWheelTemplates,
  mockCreateWheelTemplate,
  mockDeleteWheelTemplate,
} from "./mock";
import { getWheelById } from "./wheels";

// ---------------------------------------------------------------------------
// Reusable templates (Phase 2): saved prizes + saved wheel presets.
// ---------------------------------------------------------------------------

const PRIZE_TEMPLATE_SELECT =
  "id, label, description, rarity, weight, color, emoji, created_at";

function toPrizeTemplate(r: {
  id: string;
  label: string;
  description: string | null;
  rarity: Rarity;
  weight: number;
  color: string | null;
  emoji: string | null;
  created_at: string;
}): PrizeTemplate {
  return {
    id: r.id,
    label: r.label,
    description: r.description ?? undefined,
    rarity: r.rarity,
    weight: r.weight,
    color: r.color ?? undefined,
    emoji: r.emoji ?? undefined,
    createdAt: r.created_at,
  };
}

export async function listPrizeTemplates(): Promise<PrizeTemplate[]> {
  if (!isSupabaseConfigured()) return mockListPrizeTemplates();

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return [];

  const { data } = await sb
    .from("prize_templates")
    .select(PRIZE_TEMPLATE_SELECT)
    .eq("creator_id", user.id)
    .order("created_at", { ascending: false });
  const rows = (data ?? []) as Parameters<typeof toPrizeTemplate>[0][];
  return rows.map(toPrizeTemplate);
}

export async function createPrizeTemplate(input: {
  label: string;
  description?: string;
  rarity: Rarity;
  weight: number;
  color?: string;
  emoji?: string;
}): Promise<PrizeTemplate> {
  if (!isSupabaseConfigured()) return mockCreatePrizeTemplate(input);

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) throw new Error("unauthorized");

  const label = input.label.slice(0, 80) || "Prize";

  // Dedupe: a prize with the same name + rarity is "the same prize" — return the
  // existing library entry instead of saving a duplicate (e.g. double-clicks).
  const { data: dupe } = await sb
    .from("prize_templates")
    .select(PRIZE_TEMPLATE_SELECT)
    .eq("creator_id", user.id)
    .eq("label", label)
    .eq("rarity", input.rarity)
    .maybeSingle();
  if (dupe) return toPrizeTemplate(dupe as Parameters<typeof toPrizeTemplate>[0]);

  const { data, error } = await sb
    .from("prize_templates")
    .insert({
      creator_id: user.id,
      label,
      description: input.description?.slice(0, 280) ?? null,
      rarity: input.rarity,
      weight: storedWeight(input.weight),
      color: input.color ?? null,
      emoji: input.emoji ?? null,
    })
    .select(PRIZE_TEMPLATE_SELECT)
    .single();
  if (error || !data) throw new Error(gameWriteError(error));
  return toPrizeTemplate(data as Parameters<typeof toPrizeTemplate>[0]);
}

export async function deletePrizeTemplate(
  id: string
): Promise<{ ok: true } | { error: string }> {
  if (!isSupabaseConfigured()) return mockDeletePrizeTemplate(id);

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { error: "unauthorized" };

  const { error } = await sb
    .from("prize_templates")
    .delete()
    .eq("id", id)
    .eq("creator_id", user.id);
  return error ? { error: "db_error" } : { ok: true };
}

function toWheelTemplate(r: {
  id: string;
  name: string;
  title: string;
  subtitle: string | null;
  brand_color: string | null;
  prizes: Omit<Prize, "id">[] | null;
  created_at: string;
  game_kind?: unknown;
  game_config?: unknown;
}): WheelTemplate {
  return {
    ...gameSettings(r.game_kind, r.game_config),
    id: r.id,
    name: r.name,
    title: r.title,
    subtitle: r.subtitle ?? undefined,
    brandColor: r.brand_color ?? "#ec4899",
    prizes: r.prizes ?? [],
    createdAt: r.created_at,
  };
}

const WHEEL_TEMPLATE_SELECT =
  "id, name, title, subtitle, brand_color, prizes, created_at, game_kind, game_config";

export async function listWheelTemplates(): Promise<WheelTemplate[]> {
  if (!isSupabaseConfigured()) return mockListWheelTemplates();

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return [];

  const { data } = await sb
    .from("wheel_templates")
    .select(WHEEL_TEMPLATE_SELECT)
    .eq("creator_id", user.id)
    .order("created_at", { ascending: false });
  const rows = (data ?? []) as unknown as Parameters<typeof toWheelTemplate>[0][];
  return rows.map(toWheelTemplate);
}

/**
 * Save a wheel preset. Snapshots the prize set as id-less jsonb, sourced from an
 * existing wheel (fromWheelId) or a provided config.
 */
export async function createWheelTemplate(input: {
  name: string;
  fromWheelId?: string;
  config?: WheelConfig;
}): Promise<WheelTemplate> {
  if (!isSupabaseConfigured()) return mockCreateWheelTemplate(input);

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) throw new Error("unauthorized");

  let source: WheelConfig | null = input.config ?? null;
  if (!source && input.fromWheelId) {
    source = await getWheelById(input.fromWheelId);
  }
  if (!source) throw new Error("no_source");
  const settings = gameSettings(source.gameKind, source.gameConfig);
  await requireGameFeature(sb, user.id, settings.gameKind);

  // Strip ids off the prize snapshot.
  const prizes: Omit<Prize, "id">[] = source.prizes
    .slice(0, MAX_WHEEL_PRIZES)
    .map(({ id: _id, ...rest }) => rest);

  const { data, error } = await sb
    .from("wheel_templates")
    .insert({
      creator_id: user.id,
      name: input.name.slice(0, 120) || "Template",
      game_kind: settings.gameKind,
      game_config: settings.gameConfig,
      title: source.title.slice(0, 120),
      subtitle: source.subtitle?.slice(0, 200) ?? null,
      brand_color: source.brandColor ?? "#ec4899",
      prizes,
    })
    .select(WHEEL_TEMPLATE_SELECT)
    .single();
  if (error || !data) throw new Error(gameWriteError(error));
  return toWheelTemplate(data as unknown as Parameters<typeof toWheelTemplate>[0]);
}

export async function deleteWheelTemplate(
  id: string
): Promise<{ ok: true } | { error: string }> {
  if (!isSupabaseConfigured()) return mockDeleteWheelTemplate(id);

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { error: "unauthorized" };

  const { error } = await sb
    .from("wheel_templates")
    .delete()
    .eq("id", id)
    .eq("creator_id", user.id);
  return error ? { error: "db_error" } : { ok: true };
}
