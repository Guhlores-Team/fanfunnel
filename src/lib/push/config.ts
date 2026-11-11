// Web push (closed-tab notifications for creators): the knobs, in one place.
// Isomorphic (no server imports): the Settings card, the routes and the sender
// all read these.

/**
 * Owner decision D9, lock-screen content. A NEW device starts with this value
 * for "Show names and prizes on lock screen"; the creator flips it per device.
 * Default false (generic): a fan's name next to "won 💋 Custom video" on a
 * locked phone is an outing risk. The DB column default (migration 0056,
 * push_subscriptions.show_details) must match.
 */
export const DEFAULT_SHOW_DETAILS = false;

/** What a generic (discreet) notification says. No fan or prize names, ever. */
export const GENERIC_TITLE = "New activity on FanFunnel";
export const GENERIC_BODY = "Open your dashboard to see it.";

/** "Send a test" says the same thing in both modes. */
export const TEST_TITLE = "FanFunnel test notification";
export const TEST_BODY = "Push works on this device.";

/** At most one push per thread (notification tag) in this window. */
export const PUSH_THROTTLE_MS = 2 * 60_000;
/** Each delivery to a push service gives up after this long. */
export const PUSH_TIMEOUT_MS = 5_000;
/** How long the push service keeps an undelivered notification (seconds). */
export const PUSH_TTL_SECONDS = 24 * 60 * 60;
/** A device that failed this many times in a row stops getting pushes until it re-subscribes or a test succeeds. */
export const PUSH_MAX_FAILURES = 5;
/** Devices per account. */
export const PUSH_MAX_DEVICES = 10;
/** push_log rows older than this are pruned (dedupe only needs recent ones). */
export const PUSH_LOG_RETENTION_DAYS = 30;

/** Rate limits (per account, and per IP for signed-out callers). */
export const SUBSCRIBE_RATE_LIMIT = { limit: 10, windowMs: 10 * 60_000 } as const;
export const TEST_RATE_LIMIT = { limit: 3, windowMs: 60_000 } as const;

/**
 * Where a browser's push subscription may point. The server POSTs to the
 * endpoint, so an arbitrary URL would be a server-side request forgery hole:
 * only the real browser push services are accepted.
 */
export const PUSH_HOST_SUFFIXES = [
  "fcm.googleapis.com", // Chrome, Edge (Chromium), Android, Brave, Opera, Samsung
  "android.googleapis.com",
  "push.services.mozilla.com", // Firefox
  "push.apple.com", // Safari (macOS, iOS 16.4+ installed apps)
  "notify.windows.com", // legacy Edge / Windows
] as const;

export function isAllowedPushEndpoint(endpoint: unknown): endpoint is string {
  if (typeof endpoint !== "string" || endpoint.length > 1024) return false;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
  const host = url.hostname.toLowerCase();
  return PUSH_HOST_SUFFIXES.some((s) => host === s || host.endsWith("." + s));
}

/** base64url, as browsers encode a subscription's keys. */
const B64URL = /^[A-Za-z0-9_-]+={0,2}$/;
export function isPushKey(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && B64URL.test(value);
}

/** A short, non-identifying device label from a User-Agent ("iPhone · Safari"). */
export function deviceLabel(ua: string | null | undefined): string {
  const s = ua ?? "";
  const device = /iPhone/.test(s)
    ? "iPhone"
    : /iPad/.test(s)
      ? "iPad"
      : /Android/.test(s)
        ? "Android"
        : /Macintosh|Mac OS X/.test(s)
          ? "Mac"
          : /Windows/.test(s)
            ? "Windows"
            : /CrOS/.test(s)
              ? "Chromebook"
              : /Linux/.test(s)
                ? "Linux"
                : "Device";
  const browser = /Edg\//.test(s)
    ? "Edge"
    : /OPR\/|Opera/.test(s)
      ? "Opera"
      : /SamsungBrowser/.test(s)
        ? "Samsung Internet"
        : /Firefox\/|FxiOS/.test(s)
          ? "Firefox"
          : /CriOS|Chrome\//.test(s)
            ? "Chrome"
            : /Safari\//.test(s)
              ? "Safari"
              : "Browser";
  return `${device} · ${browser}`;
}

/**
 * Apple's rule: on iPhone/iPad, web push exists only inside a web app added to
 * the Home Screen (iOS 16.4+). In a Safari tab we show install steps instead.
 * iPadOS reports itself as a Mac, so a touch Mac counts as an iPad.
 */
export function needsHomeScreenInstall(ua: string, standalone: boolean, maxTouchPoints = 0): boolean {
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1);
  return ios && !standalone;
}
