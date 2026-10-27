// Per-creator theming: the allow-lists, limits and owner decisions in one place.
//
// A creator's theme is stored as KEYS from these lists (profiles.theme, written
// only through set_creator_theme in migration 0058, which repeats the same
// lists; config.test.ts fails if the two drift). Nothing a creator saves is
// ever a URL, a colour or a CSS string: the page maps each key to a
// self-hosted font and a computed background (tokens.ts).
//
// Pure and dependency-free so the dashboard, the fan routes, the API routes
// and the unit tests all share it.

/**
 * Owner decision D12 (scope). Default: per creator. The headline font, the
 * background and the photo hub belong to the creator (profiles.theme,
 * creator_media) and apply to every link; the brand colour stays per wheel as
 * before (wheels.brand_color). "per_wheel" is not built: flipping it means
 * moving `theme` onto `wheels` and reading it where getCreatorThemeView is
 * called (src/lib/data/creatorTheme.ts).
 */
export const THEME_SCOPE: "per_creator" | "per_wheel" = "per_creator";

/**
 * Owner decision D13 (what the photo hub allows). Default: option (a), SFW-only
 * everywhere, the creator attests each upload and fans can report a photo.
 * Set PHOTO_HUB_ENABLED to false for option (c), presets only: uploads are
 * refused server-side, and the gallery and photo background are not rendered.
 * Option (b) (explicit media behind the age gate) is not built; it needs the
 * parked 2257 records and age verification.
 */
export const PHOTO_HUB_ENABLED = true;
/** D13 (a): every upload must carry the creator's "this photo is SFW" attestation. */
export const REQUIRE_SFW_ATTESTATION = true;
/** D13 (a): the fan Safety menu offers this report reason. */
export const PHOTO_REPORT_REASON = "Inappropriate photo";

/** Photo hub limits. The 12 cap is also enforced by a trigger (0058). */
export const MAX_MEDIA = 12;
/** Largest upload accepted, before re-encoding (the avatar route's cap). */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
/** Longest edge of the stored WebP (the column check in 0058 allows <= 1600). */
export const MAX_EDGE_PX = 1600;
/** Largest stored file; the bucket's file_size_limit (0058) is the same. */
export const MAX_STORED_BYTES = 2 * 1024 * 1024;
/** Inputs bigger than this many pixels are refused before decoding fully. */
export const MAX_INPUT_PIXELS = 40_000_000;
export const WEBP_QUALITY = 80;
export const CAPTION_MAX = 140;
/** The storage bucket (public read, server-only writes; 0058). */
export const MEDIA_BUCKET = "creator-media";

export const THEME_FONTS = ["bricolage", "playfair", "dm-serif", "syne", "fraunces", "unbounded"] as const;
export type ThemeFont = (typeof THEME_FONTS)[number];

export const FONT_LABELS: Record<ThemeFont, string> = {
  bricolage: "Bricolage Grotesque",
  playfair: "Playfair Display",
  "dm-serif": "DM Serif Display",
  syne: "Syne",
  fraunces: "Fraunces",
  unbounded: "Unbounded",
};

export const THEME_BACKGROUNDS = ["glow", "velvet", "noir", "aurora", "solid", "photo"] as const;
export type ThemeBackground = (typeof THEME_BACKGROUNDS)[number];
/** The backgrounds that need no photo. */
export type PresetBackground = Exclude<ThemeBackground, "photo">;
export const PRESET_BACKGROUNDS: readonly PresetBackground[] = ["glow", "velvet", "noir", "aurora", "solid"];

export const BACKGROUND_LABELS: Record<ThemeBackground, string> = {
  glow: "Glow",
  velvet: "Velvet",
  noir: "Grain noir",
  aurora: "Aurora",
  solid: "Solid",
  photo: "Your photo",
};

export interface CreatorTheme {
  font: ThemeFont;
  background: ThemeBackground;
  /** The creator_media row used as the background; set only with "photo". */
  bgMediaId: string | null;
}

export const DEFAULT_THEME: CreatorTheme = { font: "bricolage", background: "glow", bgMediaId: null };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isThemeFont(v: unknown): v is ThemeFont {
  return typeof v === "string" && (THEME_FONTS as readonly string[]).includes(v);
}
export function isThemeBackground(v: unknown): v is ThemeBackground {
  return typeof v === "string" && (THEME_BACKGROUNDS as readonly string[]).includes(v);
}
export function isMediaId(v: unknown): v is string {
  return typeof v === "string" && UUID.test(v);
}

/**
 * Read a stored theme (profiles.theme) tolerantly: anything unknown or
 * malformed falls back to the default for that field, so a bad row can never
 * break or restyle a fan page. A photo background with no usable id reads as
 * the default background.
 */
export function normalizeTheme(raw: unknown): CreatorTheme {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const font = isThemeFont(o.font) ? o.font : DEFAULT_THEME.font;
  let background = isThemeBackground(o.background) ? o.background : DEFAULT_THEME.background;
  const bgMediaId = background === "photo" && isMediaId(o.bg_media_id) ? o.bg_media_id : null;
  if (background === "photo" && (!bgMediaId || !PHOTO_HUB_ENABLED)) background = DEFAULT_THEME.background;
  return { font, background, bgMediaId: background === "photo" ? bgMediaId : null };
}

export type ThemeInputError = "invalid_font" | "invalid_background" | "invalid_photo" | "photos_disabled";

/**
 * Validate a theme a creator submits (strict: an unknown value is an error,
 * not a default). Extra fields are ignored. The database re-checks everything,
 * including that the photo is the creator's own.
 */
export function parseThemeInput(raw: unknown): { theme: CreatorTheme } | { error: ThemeInputError } {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const font = o.font === undefined ? DEFAULT_THEME.font : o.font;
  const background = o.background === undefined ? DEFAULT_THEME.background : o.background;
  if (!isThemeFont(font)) return { error: "invalid_font" };
  if (!isThemeBackground(background)) return { error: "invalid_background" };
  if (background !== "photo") return { theme: { font, background, bgMediaId: null } };
  if (!PHOTO_HUB_ENABLED) return { error: "photos_disabled" };
  if (!isMediaId(o.bgMediaId)) return { error: "invalid_photo" };
  return { theme: { font, background, bgMediaId: o.bgMediaId } };
}

/** The JSON the set_creator_theme RPC takes. */
export function toDbTheme(t: CreatorTheme): Record<string, string> {
  const out: Record<string, string> = { font: t.font, background: t.background };
  if (t.background === "photo" && t.bgMediaId) out.bg_media_id = t.bgMediaId;
  return out;
}

/** A stored object path: "<creator uuid>/<uuid>.webp" (the 0058 check). */
const MEDIA_PATH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.webp$/;
export function isMediaPath(p: unknown): p is string {
  return typeof p === "string" && MEDIA_PATH.test(p);
}

/** Trim a caption to the stored limit; empty becomes null. */
export function normalizeCaption(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  // Strip control characters; captions are rendered as text, never markup.
  const s = raw.replace(/\p{Cc}/gu, " ").trim().slice(0, CAPTION_MAX);
  return s ? s : null;
}
