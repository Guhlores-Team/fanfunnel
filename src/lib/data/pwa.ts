// Data layer — home-screen install (RM-4): what a fan link's manifest and
// icons may show, and the creator's icon choice (owner decision D8).
//
// Fans never authenticate: the fan read is keyed by the link token through the
// service client (server-side only, like getFanPass). The creator's setting is
// written only through the set_pwa_icon_mode RPC (migration 0046), which
// updates the caller's own row; profiles UPDATE stays admin-only.
import { isSupabaseConfigured, createServiceClient, createClient } from "@/lib/supabase/server";
import { DEFAULT_BRAND } from "@/lib/theme";
import { DEFAULT_PWA_ICON_MODE, type PwaIconMode } from "@/lib/pwa/config";
import {
  avatarSource,
  isPwaIconMode,
  isValidFanToken,
  normalizeIconMode,
  type FanAppInfo,
} from "@/lib/pwa/manifest";
import { mockGetFanAppInfo, mockGetMyPwaIconMode, mockSetMyPwaIconMode } from "./mock";
import { resolveWheelId } from "./wheels";

type PassRow = {
  creator_id: string;
  campaign_id: string | null;
  wheel_id: string;
  fan: { id: string } | null;
  creator: {
    display_name: string | null;
    avatar_url: string | null;
    pwa_icon_mode?: string | null;
  } | null;
};

/**
 * The creator name, brand colour, icon mode and (safe-to-fetch) avatar for an
 * ACTIVE fan link, or null for an unknown, inactive or paused link (the same
 * links getFanPass refuses). Reveals nothing else about the fan or creator.
 */
export async function getFanAppInfo(token: string): Promise<FanAppInfo | null> {
  if (!isValidFanToken(token)) return null;
  if (!isSupabaseConfigured()) return mockGetFanAppInfo(token);

  const sb = createServiceClient();
  const select = (creatorCols: string) =>
    sb
      .from("fan_passes")
      .select(`creator_id, campaign_id, wheel_id, fan:fans(id), creator:profiles(${creatorCols})`)
      .eq("token", token)
      .eq("is_active", true)
      .maybeSingle();
  let res = await select("display_name, avatar_url, pwa_icon_mode");
  // A database without 0046 yet: serve the neutral default rather than 404.
  if (res.error) res = await select("display_name, avatar_url");
  const pass = res.data as unknown as PassRow | null;
  if (!pass || !pass.fan) return null;

  const wheelId = await resolveWheelId(sb, pass, new Date());
  if (!wheelId) return null;
  const { data: wheel } = await sb.from("wheels").select("brand_color").eq("id", wheelId).maybeSingle();

  return {
    creatorTitle: pass.creator?.display_name ?? "Creator",
    brandColor: (wheel as { brand_color: string | null } | null)?.brand_color ?? DEFAULT_BRAND,
    iconMode: normalizeIconMode(pass.creator?.pwa_icon_mode),
    avatarUrl: avatarSource(pass.creator?.avatar_url ?? null, process.env.NEXT_PUBLIC_SUPABASE_URL),
  };
}

/** The signed-in creator's home-screen icon choice. */
export async function getMyPwaIconMode(): Promise<{ mode: PwaIconMode } | { error: "unauthorized" }> {
  if (!isSupabaseConfigured()) return { mode: mockGetMyPwaIconMode() };
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { error: "unauthorized" };
  const { data, error } = await sb
    .from("profiles")
    .select("pwa_icon_mode")
    .eq("id", user.id)
    .maybeSingle();
  if (error) return { mode: DEFAULT_PWA_ICON_MODE };
  return { mode: normalizeIconMode((data as { pwa_icon_mode?: string } | null)?.pwa_icon_mode) };
}

/**
 * Set the signed-in creator's own icon choice. There is no target argument:
 * the RPC writes auth.uid()'s row only, so no request can change another
 * creator's setting.
 */
export async function setMyPwaIconMode(
  mode: unknown
): Promise<{ ok: true; mode: PwaIconMode } | { error: "unauthorized" | "invalid_mode" | "db_error" }> {
  if (!isSupabaseConfigured()) {
    if (!isPwaIconMode(mode)) return { error: "invalid_mode" };
    mockSetMyPwaIconMode(mode);
    return { ok: true, mode };
  }
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { error: "unauthorized" };
  if (!isPwaIconMode(mode)) return { error: "invalid_mode" };
  const { error } = await sb.rpc("set_pwa_icon_mode", { p_mode: mode });
  return error ? { error: "db_error" } : { ok: true, mode };
}
