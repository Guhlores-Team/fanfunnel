// Web app manifests (RM-4). Pure and dependency-free so the token handling and
// the D8 icon/name rules are unit-tested without a server.
//
// Two apps:
//  - the fan's spin link: one manifest per link, served at /spin/<token>/manifest.
//    The token is the fan's bearer credential, so it appears only in same-origin
//    paths of that link (start_url, scope, id, icons) and never in the name.
//  - the creator dashboard (root manifest): start_url /dashboard, no token.
import type { MetadataRoute } from "next";
import {
  APP_BACKGROUND,
  DASHBOARD_APP_PATH,
  DEFAULT_PWA_ICON_MODE,
  NEUTRAL_APP_NAME,
  PWA_ICON_MODES,
  SHORT_NAME_MAX,
  type PwaIconMode,
} from "./config";

/** Same shape as randomToken() output, plus the demo store's short tokens. */
const TOKEN_RE = /^[A-Za-z0-9_-]{1,128}$/;

export function isValidFanToken(token: unknown): token is string {
  return typeof token === "string" && TOKEN_RE.test(token);
}

export function isPwaIconMode(v: unknown): v is PwaIconMode {
  return typeof v === "string" && (PWA_ICON_MODES as readonly string[]).includes(v);
}

/** Anything unknown (a pre-0046 row, a typo) degrades to the safe default. */
export function normalizeIconMode(v: unknown): PwaIconMode {
  return isPwaIconMode(v) ? v : DEFAULT_PWA_ICON_MODE;
}

/** Icon variants the icon routes render. `apple` is iOS's apple-touch-icon. */
export const ICON_VARIANTS = {
  "180": { size: 180, maskable: false },
  "192": { size: 192, maskable: false },
  "512": { size: 512, maskable: false },
  "maskable-192": { size: 192, maskable: true },
  "maskable-512": { size: 512, maskable: true },
} as const;
export type IconVariant = keyof typeof ICON_VARIANTS;

export function parseIconVariant(v: string): { size: number; maskable: boolean } | null {
  return Object.prototype.hasOwnProperty.call(ICON_VARIANTS, v)
    ? ICON_VARIANTS[v as IconVariant]
    : null;
}

/** Everything the fan's manifest and icons may reveal. Nothing else. */
export interface FanAppInfo {
  creatorTitle: string;
  brandColor: string;
  iconMode: PwaIconMode;
  /** The creator's avatar, only when it is safe to fetch server-side (see avatarSource). */
  avatarUrl: string | null;
}

/** The same-origin paths of one fan link's app. Throws on a malformed token. */
export function fanAppPaths(token: string) {
  if (!isValidFanToken(token)) throw new Error("invalid fan token");
  const base = `/spin/${encodeURIComponent(token)}`;
  return {
    page: base,
    startUrl: `${base}?src=pwa`,
    scope: base,
    manifest: `${base}/manifest`,
    icon: (variant: IconVariant) => `${base}/icon/${variant}`,
  };
}

/** The name on the fan's home screen: per D8, the creator's only when they opted in. */
export function fanAppName(info: Pick<FanAppInfo, "creatorTitle" | "iconMode">): string {
  if (info.iconMode !== "avatar") return NEUTRAL_APP_NAME;
  const name = info.creatorTitle.trim().replace(/\s+/g, " ");
  return name || NEUTRAL_APP_NAME;
}

export function shortName(name: string): string {
  const chars = Array.from(name);
  return chars.length <= SHORT_NAME_MAX ? name : chars.slice(0, SHORT_NAME_MAX - 1).join("").trimEnd() + "…";
}

/** Whether the icon shows the creator's avatar (otherwise the neutral glyph). */
export function usesAvatarIcon(info: Pick<FanAppInfo, "iconMode" | "avatarUrl">): boolean {
  return info.iconMode === "avatar" && !!info.avatarUrl;
}

/**
 * A short fingerprint of what the icon looks like, appended to icon URLs so a
 * changed mode, colour or avatar gives the installed app a new icon URL (Chrome
 * re-checks a manifest's icons when their URLs change). Not a secret.
 */
export function iconVersion(info: Pick<FanAppInfo, "iconMode" | "brandColor" | "avatarUrl">): string {
  const key = usesAvatarIcon(info)
    ? `a|${info.avatarUrl}`
    : `n|${info.brandColor.toLowerCase()}`;
  let h = 0x811c9dc5; // FNV-1a 32-bit
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export function buildFanManifest(token: string, info: FanAppInfo): MetadataRoute.Manifest {
  const p = fanAppPaths(token);
  const name = fanAppName(info);
  const v = `?v=${iconVersion(info)}`;
  return {
    // A distinct id per link, so two creators' links install as two apps.
    id: p.page,
    name,
    short_name: shortName(name),
    // Neutral on purpose: no creator name here either.
    description: "Your prize wheel. Every spin wins.",
    start_url: p.startUrl,
    scope: p.scope,
    display: "standalone",
    orientation: "portrait",
    background_color: APP_BACKGROUND,
    theme_color: info.brandColor,
    icons: [
      { src: p.icon("192") + v, sizes: "192x192", type: "image/png", purpose: "any" },
      { src: p.icon("512") + v, sizes: "512x512", type: "image/png", purpose: "any" },
      { src: p.icon("maskable-512") + v, sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}

/** The site-wide manifest: the creator dashboard app (web push extends this). */
export function buildRootManifest(): MetadataRoute.Manifest {
  return {
    id: DASHBOARD_APP_PATH,
    name: "FanFunnel",
    short_name: "FanFunnel",
    description: "Spin to win — every spin wins a prize.",
    start_url: DASHBOARD_APP_PATH,
    scope: "/",
    display: "standalone",
    background_color: APP_BACKGROUND,
    theme_color: APP_BACKGROUND,
    icons: [
      { src: "/app-icon/192", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/app-icon/512", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/app-icon/maskable-512", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}

/**
 * The avatar URL the icon route may fetch server-side, or null. Only objects in
 * the project's public `avatars` bucket qualify: a creator can store any
 * http(s) avatar URL, and the server must not fetch arbitrary hosts (SSRF).
 */
export function avatarSource(avatarUrl: string | null, supabaseUrl: string | undefined): string | null {
  if (!avatarUrl || !supabaseUrl) return null;
  let avatar: URL;
  let project: URL;
  try {
    avatar = new URL(avatarUrl);
    project = new URL(supabaseUrl);
  } catch {
    return null;
  }
  if (avatar.protocol !== "https:" && !(avatar.protocol === "http:" && project.protocol === "http:")) return null;
  if (avatar.origin !== project.origin) return null;
  if (!avatar.pathname.startsWith("/storage/v1/object/public/avatars/")) return null;
  if (avatar.pathname.includes("..") || avatar.username || avatar.password) return null;
  return avatar.toString();
}
