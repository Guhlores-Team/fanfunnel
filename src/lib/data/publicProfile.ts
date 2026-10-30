// Data layer — public, unauthenticated reads: the wheel teaser and the
// link-in-bio profile (plus the creator's editor for it).
import { isSupabaseConfigured, createServiceClient, createClient } from "@/lib/supabase/server";
import { externalUrl } from "@/lib/format";
import type { PublicPrize, PublicWheelConfig } from "@/lib/games/wheel/types";
import { RARITY_ORDER } from "@/lib/games/wheel/types";
import { toPublicWheel } from "@/lib/games/wheel/publicView";
import type { HappyHourStatus } from "./types";
import { mockGetPublicWheelTeaser } from "./mock";
import { WHEEL_SELECT, toWheelConfig } from "./shared";
import { getCreatorThemeView, type CreatorThemeView } from "./creatorTheme";
import type { DbWheelRow } from "./shared";
import { getActiveHappyHour, resolveActiveWheelId } from "./wheels";

// --- Public teaser ----------------------------------------------------------

/**
 * A token-free preview of a creator's active wheel + current happy hour, for a
 * public landing page. Service role; no spinning, no fan identity.
 */
export async function getPublicWheelTeaser(
  creatorId: string
): Promise<{ creatorTitle: string; wheel: PublicWheelConfig; happyHour: HappyHourStatus } | null> {
  if (!isSupabaseConfigured()) return mockGetPublicWheelTeaser(creatorId);

  const sb = createServiceClient();
  const wheelId = await resolveActiveWheelId(sb, creatorId, new Date());
  if (!wheelId) return null;

  const { data: wheelData } = await sb
    .from("wheels")
    .select(WHEEL_SELECT)
    .eq("id", wheelId)
    .maybeSingle();
  if (!wheelData) return null;

  const { data: profile } = await sb
    .from("profiles")
    .select("display_name")
    .eq("id", creatorId)
    .maybeSingle();
  const creatorTitle =
    (profile as { display_name: string | null } | null)?.display_name ??
    "Creator";

  const happyHour = await getActiveHappyHour(sb, wheelId, new Date(), creatorId);
  return {
    creatorTitle,
    // Unauthenticated: fan-safe projection only (no prize costs).
    wheel: toPublicWheel(toWheelConfig(wheelData as unknown as DbWheelRow)),
    happyHour,
  };
}

// --- SFW link-in-bio public profile -----------------------------------------

export interface PublicProfile {
  creatorTitle: string;
  tagline: string | null;
  brandColor: string;
  /** The creator's avatar — shown as the page's hero in place of the 🎡. */
  avatarUrl: string | null;
  // SFW prize teaser: labels + rarities only (no explicit media), best first.
  // RM-2: plus the fan-safe stock (exact count only when the wheel shows it).
  prizes: TeaserPrize[];
  hasTipUrl: boolean;
  /** Per-creator theming: headline font, background and photo hub. */
  look: CreatorThemeView;
}

export type TeaserPrize = Pick<PublicPrize, "label" | "rarity" | "emoji" | "stock" | "soldOut">;

/** The link-in-bio teaser: the six best prizes of the fan-safe wheel. */
function teaserPrizes(prizes: PublicPrize[]): TeaserPrize[] {
  return prizes
    .slice()
    .sort((a, b) => RARITY_ORDER.indexOf(b.rarity) - RARITY_ORDER.indexOf(a.rarity))
    .slice(0, 6)
    .map((p) => {
      const out: TeaserPrize = { label: p.label, rarity: p.rarity, emoji: p.emoji };
      if (p.stock !== undefined) out.stock = p.stock;
      if (p.soldOut) out.soldOut = true;
      return out;
    });
}

/** Public, SFW landing data for a creator's link-in-bio page (by slug). */
export async function getPublicProfileBySlug(
  slug: string
): Promise<{ profile: PublicProfile; tipUrl: string | null } | null> {
  if (!isSupabaseConfigured()) {
    return {
      profile: {
        creatorTitle: "Demo Creator",
        tagline: "Spin my wheel — every spin wins 🎡",
        brandColor: "#ec4899",
        avatarUrl: null,
        // Parity with the Supabase path: the demo's live wheel, fan-safe.
        prizes: teaserPrizes(mockGetPublicWheelTeaser()?.wheel.prizes ?? []),
        hasTipUrl: true,
        look: await getCreatorThemeView(null),
      },
      tipUrl: "#",
    };
  }
  const sb = createServiceClient();
  const { data: prof } = await sb
    .from("profiles")
    .select("id, display_name, public_tagline, tip_url, avatar_url")
    .eq("public_slug", slug)
    .maybeSingle();
  const p = prof as {
    id: string;
    display_name: string | null;
    public_tagline: string | null;
    tip_url: string | null;
    avatar_url: string | null;
  } | null;
  if (!p) return null;

  const wheelId = await resolveActiveWheelId(sb, p.id, new Date());
  let brandColor = "#ec4899";
  let prizes: TeaserPrize[] = [];
  if (wheelId) {
    const { data: wheelData } = await sb
      .from("wheels")
      .select(WHEEL_SELECT)
      .eq("id", wheelId)
      .maybeSingle();
    if (wheelData) {
      const cfg = toWheelConfig(wheelData as unknown as DbWheelRow);
      brandColor = cfg.brandColor ?? "#ec4899";
      prizes = teaserPrizes(toPublicWheel(cfg).prizes);
    }
  }

  return {
    profile: {
      creatorTitle: p.display_name ?? "Creator",
      tagline: p.public_tagline,
      brandColor,
      avatarUrl: p.avatar_url,
      prizes,
      hasTipUrl: !!p.tip_url,
      look: await getCreatorThemeView(p.id),
    },
    tipUrl: p.tip_url,
  };
}

/** The signed-in creator's editable public-profile fields. */
export async function getMyPublicProfile(): Promise<{
  slug: string | null;
  tipUrl: string | null;
  tagline: string | null;
  note: string | null;
  avatarUrl: string | null;
}> {
  if (!isSupabaseConfigured())
    return { slug: "demo-creator", tipUrl: "", tagline: "", note: "", avatarUrl: "" };
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { slug: null, tipUrl: null, tagline: null, note: null, avatarUrl: null };
  const { data } = await sb
    .from("profiles")
    .select("public_slug, tip_url, public_tagline, creator_note, avatar_url")
    .eq("id", user.id)
    .maybeSingle();
  const row = data as {
    public_slug: string | null;
    tip_url: string | null;
    public_tagline: string | null;
    creator_note: string | null;
    avatar_url: string | null;
  } | null;
  return {
    slug: row?.public_slug ?? null,
    tipUrl: row?.tip_url ?? null,
    tagline: row?.public_tagline ?? null,
    note: row?.creator_note ?? null,
    avatarUrl: row?.avatar_url ?? null,
  };
}

// Cap stored avatar URLs so a multi-KB string can't be persisted via the note RPC.
const MAX_AVATAR_URL_LEN = 2048;

/** Creator updates their SFW link-in-bio fields + fan-page personal note. */
/** The stored form of a public slug (the `/c/<slug>` path segment). */
export function normalizePublicSlug(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export async function setMyPublicProfile(input: {
  slug?: string;
  tipUrl?: string;
  tagline?: string;
  note?: string;
  avatarUrl?: string;
}): Promise<{ ok: true } | { error: string }> {
  if (!isSupabaseConfigured()) return { ok: true };
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { error: "unauthorized" };
  // Atomic partial update: pass NULL for any field omitted from the request so
  // the RPC leaves that column unchanged (migration 0033). This replaces the
  // route's old read-modify-write, which raced concurrent partial updates
  // (TOCTOU) and could wipe an omitted note/avatar.
  if (input.slug !== undefined || input.tipUrl !== undefined || input.tagline !== undefined) {
    const slug = input.slug !== undefined ? normalizePublicSlug(input.slug) : null;
    const { error } = await sb.rpc("set_public_profile", {
      p_slug: slug,
      p_tip_url: input.tipUrl !== undefined ? externalUrl(input.tipUrl) : null,
      p_tagline: input.tagline !== undefined ? input.tagline : null,
    });
    if (error) return { error: "db_error" };
  }
  if (input.note !== undefined || input.avatarUrl !== undefined) {
    // Defense in depth: never persist an avatar URL with a non-http(s) scheme
    // (blocks data:/javascript:) or an oversized value, even if a caller skips
    // the validated upload path. An empty string clears the avatar; an omitted
    // avatar (null) leaves the current one unchanged.
    let avatar: string | null = null;
    if (input.avatarUrl !== undefined) {
      avatar = input.avatarUrl;
      if (avatar !== "") {
        if (avatar.length > MAX_AVATAR_URL_LEN) return { error: "invalid_avatar_url" };
        let protocol: string;
        try {
          protocol = new URL(avatar).protocol;
        } catch {
          return { error: "invalid_avatar_url" };
        }
        if (protocol !== "http:" && protocol !== "https:") {
          return { error: "invalid_avatar_url" };
        }
      }
    }
    const { error: noteError } = await sb.rpc("set_creator_note", {
      p_note: input.note !== undefined ? input.note : null,
      p_avatar: avatar,
    });
    if (noteError) return { error: "db_error" };
  }
  return { ok: true };
}
