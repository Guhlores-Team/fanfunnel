// Home-screen install (RM-4): the knobs, in one place. Isomorphic (no server
// imports) so the fan's install nudge and the dashboard card can read them too.

/** What a fan's installed spin link shows on their home screen (owner decision D8). */
export type PwaIconMode = "neutral" | "avatar";
export const PWA_ICON_MODES: readonly PwaIconMode[] = ["neutral", "avatar"];

/**
 * D8 default: neutral. An adult creator's face and name on a fan's home screen
 * is a privacy risk for the fan, so a creator must opt in to "avatar". The
 * database column default (migration 0046) must match this value.
 */
export const DEFAULT_PWA_ICON_MODE: PwaIconMode = "neutral";

/** The installed app's name in neutral mode (never the creator's name). */
export const NEUTRAL_APP_NAME = "Spins";

/** Longest home-screen label we emit; launchers truncate around here anyway. */
export const SHORT_NAME_MAX = 12;

/** App background / splash colour (globals.css --color-base). */
export const APP_BACKGROUND = "#0c0a0e";

/**
 * Cache policy for anything whose URL or body is tied to a fan's link token:
 * the browser may reuse it briefly, but no shared cache (CDN, proxy) may store
 * it. Never add s-maxage or `public` here.
 */
export const FAN_APP_CACHE_CONTROL = "private, max-age=300";

/** Keep token-bearing responses out of search indexes. */
export const NOINDEX = "noindex, nofollow, noarchive";

/** The install nudge stays hidden this long after "Not now". */
export const INSTALL_NUDGE_SNOOZE_DAYS = 14;
export const INSTALL_NUDGE_STORAGE_KEY = "ff.installNudge.dismissedAt";

/** Creator dashboard app (root manifest). Web push registers its worker here. */
export const DASHBOARD_APP_PATH = "/dashboard";
export const SERVICE_WORKER_URL = "/sw.js";
/** The only scope the app's service worker may control. Never "/" or /spin. */
export const SERVICE_WORKER_SCOPE = DASHBOARD_APP_PATH;
