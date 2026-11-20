import {
  DEFAULT_THEME,
  MAX_MEDIA,
  isMediaId,
  parseThemeInput,
  type CreatorTheme,
  type ThemeMedia,
} from "@/lib/creatorTheme/config";

/** The public pieces needed by Settings' live preview. No data-layer imports. */
export interface ThemePreviewValue {
  theme: CreatorTheme;
  media: ThemeMedia[];
  bgUrl: string | null;
}

export interface ThemeSettings extends ThemePreviewValue {
  photosEnabled: boolean;
  sfwRequired: boolean;
  maxMedia: number;
}

/** Refuse malformed responses rather than offering to overwrite them with defaults. */
export function readThemeSettings(value: unknown): ThemeSettings | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Partial<ThemeSettings>;
  const parsed = parseThemeInput(v.theme);
  if (
    "error" in parsed || !v.theme || !Array.isArray(v.media) ||
    typeof v.photosEnabled !== "boolean" || typeof v.sfwRequired !== "boolean" ||
    typeof v.maxMedia !== "number" || !Number.isInteger(v.maxMedia) || v.maxMedia < 1
  ) return null;
  if (!v.media.every((m) =>
    m && isMediaId(m.id) && typeof m.url === "string" &&
    (m.caption === null || typeof m.caption === "string") &&
    Number.isFinite(m.width) && m.width > 0 && Number.isFinite(m.height) && m.height > 0
  )) return null;
  return {
    ...previewValue(parsed.theme, v.media),
    photosEnabled: v.photosEnabled,
    sfwRequired: v.sfwRequired,
    maxMedia: Math.min(MAX_MEDIA, v.maxMedia),
  };
}

export function previewValue(theme: CreatorTheme, media: ThemeMedia[]): ThemePreviewValue {
  const bg = theme.background === "photo" ? media.find((m) => m.id === theme.bgMediaId) : null;
  return {
    theme: theme.background === "photo" && !bg
      ? { ...theme, background: DEFAULT_THEME.background, bgMediaId: null }
      : theme,
    media,
    bgUrl: bg?.url ?? null,
  };
}

/** Move an existing item; unrelated/foreign ids can never enter the submitted order. */
export function movePhoto(media: ThemeMedia[], id: string, target: number): ThemeMedia[] {
  const from = media.findIndex((m) => m.id === id);
  if (from < 0 || !Number.isInteger(target) || target < 0 || target >= media.length || from === target) return media;
  const next = [...media];
  const [photo] = next.splice(from, 1);
  next.splice(target, 0, photo);
  return next;
}

/** Server codes are mapped to helpful copy; raw server errors are never displayed. */
export function themeErrorMessage(code: string): string {
  switch (code) {
    case "unauthorized": return "Your session ended. Sign in again, then retry.";
    case "forbidden": return "This account cannot change photos or appearance right now.";
    case "rate_limited": return "Too many requests. Wait a minute, then try again.";
    case "invalid_font": return "Choose one of the headline fonts shown here.";
    case "invalid_background": return "Choose one of the backgrounds shown here.";
    case "invalid_photo": return "That background photo is no longer available. Choose another photo or a preset.";
    case "photos_disabled": return "Photo uploads are currently unavailable. You can still use a preset background.";
    case "sfw_required": return "Confirm that this photo is safe for work before uploading it.";
    case "limit_reached": return "Your photo hub is full. Remove a photo before adding another.";
    case "no_file": return "Choose a photo to upload.";
    case "too_large": return "Choose an image smaller than 5 MB.";
    case "not_image": return "Choose a valid JPEG, PNG, GIF or WebP image. SVG and HEIC files are not supported.";
    case "not_found": return "That photo is no longer available. Reload your saved settings.";
    case "upload_failed": return "The photo could not be uploaded. Your existing photos are unchanged; please retry.";
    case "storage_cleanup_failed": return "The photo could not be removed. It may still be visible; please retry.";
    default: return "We couldn’t save that change. Please retry, or reload your saved settings.";
  }
}
