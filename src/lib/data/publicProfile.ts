// Data layer — public, unauthenticated reads: the wheel teaser and the
// link-in-bio profile (plus the creator's editor for it).
import { publicBaseOdds, type PublicOddsRow } from "@/lib/games/wheel/publicOdds";
import { isReservedName } from "@/lib/reservedNames";
import { isSupabaseConfigured, createServiceClient, createClient } from "@/lib/supabase/server";
import { externalUrl } from "@/lib/format";
import type { PublicPrize, PublicWheelConfig } from "@/lib/games/wheel/types";
import { RARITY_ORDER } from "@/lib/games/wheel/types";
import type { GameKind } from "@/lib/games/core/gameProof";
import { publicGameKind } from "@/lib/games/publicCopy";
import { toPublicWheel } from "@/lib/games/wheel/publicView";
import type { HappyHourStatus } from "./types";
import { mockGetPublicWheelTeaser } from "./mock";
import { WHEEL_SELECT, toWheelConfig } from "./shared";
import { getCreatorThemeView, type CreatorThemeView } from "./creatorTheme";
import type { DbWheelRow } from "./shared";
import { getActiveHappyHour, resolveActiveWheelId } from "./wheels";
import { mockGetPublicProfileFields, mockSetPublicProfileFields } from "./mockPublicProfile";
import { readPublicCreator } from "./publicCreatorRow";
import { publicCreatorTitle } from "@/lib/publicCreator";
import { publicProfileRpcError } from "@/lib/profileErrors";

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
  // L5: a suspended or unapproved account has no public teaser (404).
  const creator = await readPublicCreator(sb, creatorId, { by: "id" });
  if (!creator) return null;
  const wheelId = await resolveActiveWheelId(sb, creator.id, new Date());
  if (!wheelId) return null;

  const { data: wheelData } = await sb
    .from("wheels")
    .select(WHEEL_SELECT)
    .eq("id", wheelId)
    .maybeSingle();
  if (!wheelData) return null;

  const creatorTitle = publicCreatorTitle(creator.display_name);

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
  /** T12: every prize by name with its base odds (empty for bingo, which plays a card). */
  odds: PublicOddsRow[];
  hasTipUrl: boolean;
  /** The live game's kind, so the page never calls a scratch or bingo game a wheel. */
  gameKind: GameKind;
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
  // TS-03: a reserved slug (/c/admin, /c/fanfunnel) is nobody's page, even if
  // a row stored one before the rule existed.
  if (isReservedName(slug)) return null;
  if (!isSupabaseConfigured()) {
    const saved = mockGetPublicProfileFields();
    // WA-02 parity: only the demo creator's own link name (and the historical
    // "demo") answers; any other slug is unknown, as in production.
    if (slug !== saved.slug && slug !== "demo") return null;
    // Parity with the Supabase path: the demo's live game, fan-safe; an unset
    // tagline stays null so the page shows the game's own default line.
    const live = mockGetPublicWheelTeaser()?.wheel;
    return {
      profile: {
        creatorTitle: "Demo Creator",
        tagline: saved.tagline || null,
        brandColor: "#ec4899",
        avatarUrl: saved.avatarUrl || null,
        prizes: teaserPrizes(live?.prizes ?? []),
        odds: publicGameKind(live?.gameKind) === "bingo" ? [] : publicBaseOdds(live?.prizes ?? []),
        // PR-19: no "#" call to action in the demo; a saved link or none.
        hasTipUrl: !!saved.tipUrl,
        gameKind: publicGameKind(live?.gameKind),
        look: await getCreatorThemeView(null),
      },
      tipUrl: saved.tipUrl || null,
    };
  }
  const sb = createServiceClient();
  // L5: a suspended or unapproved account's page is a 404 (its tip link must
  // not keep soliciting payments), the same answer as an unknown slug.
  const p = await readPublicCreator<{
    public_tagline: string | null;
    tip_url: string | null;
    avatar_url: string | null;
  }>(sb, slug, { by: "slug", extra: "public_tagline, tip_url, avatar_url" });
  if (!p) return null;

  const wheelId = await resolveActiveWheelId(sb, p.id, new Date());
  let brandColor = "#ec4899";
  let prizes: TeaserPrize[] = [];
  let odds: PublicOddsRow[] = [];
  let gameKind: GameKind = "wheel";
  if (wheelId) {
    const { data: wheelData } = await sb
      .from("wheels")
      .select(WHEEL_SELECT)
      .eq("id", wheelId)
      .maybeSingle();
    if (wheelData) {
      const cfg = toWheelConfig(wheelData as unknown as DbWheelRow);
      brandColor = cfg.brandColor ?? "#ec4899";
      const fanSafe = toPublicWheel(cfg).prizes;
      prizes = teaserPrizes(fanSafe);
      gameKind = publicGameKind(cfg.gameKind);
      odds = gameKind === "bingo" ? [] : publicBaseOdds(fanSafe);
    }
  }

  return {
    profile: {
      creatorTitle: publicCreatorTitle(p.display_name),
      tagline: p.public_tagline,
      brandColor,
      avatarUrl: p.avatar_url,
      prizes,
      odds,
      hasTipUrl: !!p.tip_url,
      gameKind,
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
  if (!isSupabaseConfigured()) return mockGetPublicProfileFields();
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

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:" && value.length <= 2048 && !/\s/.test(value);
  } catch {
    return false;
  }
}

/** An https URL whose path is our public avatars bucket (matches the 0068 RPC rule). */
function isOurAvatarUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.pathname.startsWith("/storage/v1/object/public/avatars/") && !/\s/.test(value);
  } catch {
    return false;
  }
}

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
  if (!isSupabaseConfigured()) {
    // A36: keep what was saved, with the same normalization and avatar rule
    // as the database path, so the demo never pretends to save.
    const avatar = input.avatarUrl;
    if (avatar !== undefined && avatar !== "") {
      try {
        const protocol = new URL(avatar).protocol;
        if (avatar.length > MAX_AVATAR_URL_LEN || (protocol !== "http:" && protocol !== "https:")) return { error: "invalid_avatar_url" };
      } catch {
        return { error: "invalid_avatar_url" };
      }
    }
    mockSetPublicProfileFields({
      slug: input.slug !== undefined ? normalizePublicSlug(input.slug) : undefined,
      tipUrl: input.tipUrl !== undefined ? (input.tipUrl ? externalUrl(input.tipUrl) : "") : undefined,
      tagline: input.tagline,
      note: input.note,
      avatarUrl: input.avatarUrl,
    });
    return { ok: true };
  }
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
    // A tip link is https only (bare domains are normalized to https://); the
    // RPC refuses anything else (0068), so say so before the round trip.
    const tipUrl = input.tipUrl !== undefined ? externalUrl(input.tipUrl) : null;
    if (tipUrl && !isHttpsUrl(tipUrl)) return { error: "invalid_tip_url" };
    const { error } = await sb.rpc("set_public_profile", {
      p_slug: slug,
      p_tip_url: tipUrl,
      p_tagline: input.tagline !== undefined ? input.tagline : null,
    });
    // 0071: a refused slug/tagline/tip link (22023) or a taken slug (23505)
    // is a stable code, never the database's text.
    if (error) return { error: publicProfileRpcError(error) };
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
        // Only an object the avatar upload wrote to our public avatars bucket
        // (https, path /storage/v1/object/public/avatars/...); the RPC enforces
        // the same (0068).
        if (!isOurAvatarUrl(avatar)) return { error: "invalid_avatar_url" };
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
