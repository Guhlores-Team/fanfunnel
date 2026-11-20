/**
 * One read path for the creator dashboard's lists and tiles, so a failed load
 * is never shown as "no data". Every failure becomes a `LoadError` with a kind:
 *   auth    401: the sign-in ended. The creator is sent to /login?next=<here>
 *           once; a second 401 soon after does not bounce them again.
 *   rate    429: "Too many requests, try again in a moment".
 *   server  any other non-ok answer, or a body that is not the expected JSON.
 *   network fetch itself threw (offline, aborted, DNS).
 */
export type LoadFailureKind = "auth" | "rate" | "server" | "network";

export class LoadError extends Error {
  readonly kind: LoadFailureKind;
  readonly status: number | null;
  constructor(kind: LoadFailureKind, status: number | null = null) {
    super(kind === "network" ? "Request failed" : `Request failed (${status})`);
    this.name = "LoadError";
    this.kind = kind;
    this.status = status;
  }
}

export function loadFailureKind(status: number | null): LoadFailureKind {
  if (status === null) return "network";
  if (status === 401) return "auth";
  if (status === 429) return "rate";
  return "server";
}

export const RATE_LIMITED_MESSAGE = "Too many requests, try again in a moment.";
export const SIGNED_OUT_MESSAGE = "You're signed out. Sign in again to see this.";

/** Plain-words copy for a failed load. `what` names the list ("your fans"). */
export function loadErrorMessage(error: unknown, what = "this"): string {
  const kind = error instanceof LoadError ? error.kind : "network";
  if (kind === "auth") return SIGNED_OUT_MESSAGE;
  if (kind === "rate") return RATE_LIMITED_MESSAGE;
  return `Couldn't load ${what}.`;
}

/** Where a 401 sends the creator: sign in, then come back to this exact view. */
export function loginRedirectHref(location: { pathname: string; search: string }): string {
  return "/login?next=" + encodeURIComponent(location.pathname + location.search);
}

const REDIRECT_KEY = "ff-auth-redirect-at";
/** A second 401 within this window (e.g. right after signing in again) shows the signed-out message instead of redirecting. */
export const AUTH_REDIRECT_COOLDOWN_MS = 60_000;

export interface RedirectEnv {
  location: { pathname: string; search: string; assign: (href: string) => void };
  storage: Pick<Storage, "getItem" | "setItem"> | null;
  now: () => number;
}

let redirecting = false;
/** Test hook: forget that this page already redirected. */
export function resetAuthRedirect() {
  redirecting = false;
}

function browserEnv(): RedirectEnv | null {
  if (typeof window === "undefined") return null;
  let storage: RedirectEnv["storage"] = null;
  try { storage = window.sessionStorage; } catch { storage = null; }
  return { location: window.location, storage, now: Date.now };
}

/**
 * Send the creator to sign in, once. Many panels can 401 at the same moment;
 * only the first redirects. After a redirect the page keeps a timestamp, so if
 * the dashboard still answers 401 straight after signing in again, it stays put
 * and shows the signed-out message rather than looping through /login.
 */
export function redirectToLogin(env: RedirectEnv | null = browserEnv()): boolean {
  if (!env || redirecting) return false;
  if (env.location.pathname.startsWith("/login")) return false;
  let last = 0;
  try { last = Number(env.storage?.getItem(REDIRECT_KEY) ?? 0) || 0; } catch { last = 0; }
  if (last && env.now() - last < AUTH_REDIRECT_COOLDOWN_MS) return false;
  try { env.storage?.setItem(REDIRECT_KEY, String(env.now())); } catch { /* the cooldown is best-effort */ }
  redirecting = true;
  env.location.assign(loginRedirectHref(env.location));
  return true;
}

export interface LoadJsonOptions {
  headers?: Record<string, string>;
  /** Send a 401 to /login?next=. On for creator reads; off for fan pages. */
  authRedirect?: boolean;
  fetchImpl?: typeof fetch;
  redirect?: () => void;
}

/** GET `url` as JSON. Throws `LoadError` for every failure; never returns an empty stand-in. */
export async function loadJson<T = unknown>(url: string, opts: LoadJsonOptions = {}): Promise<T> {
  const { headers, authRedirect = true, fetchImpl = fetch, redirect = () => void redirectToLogin() } = opts;
  let res: Response;
  try {
    res = await fetchImpl(url, { cache: "no-store", ...(headers ? { headers } : {}) });
  } catch {
    throw new LoadError("network");
  }
  if (!res.ok) {
    const kind = loadFailureKind(res.status);
    if (kind === "auth" && authRedirect) redirect();
    throw new LoadError(kind, res.status);
  }
  try {
    return (await res.json()) as T;
  } catch {
    throw new LoadError("server", res.status);
  }
}
