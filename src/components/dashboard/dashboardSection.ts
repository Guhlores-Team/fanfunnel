import type { Tab } from "./DashboardShell";

/** Sections that `/dashboard?section=` can open (the /admin route uses "admin"). */
export const SECTIONS: readonly Tab[] = [
  "today",
  "inbox",
  "prizes",
  "editor",
  "campaigns",
  "fans",
  "boosts",
  "analytics",
  "settings",
  "admin",
];

/**
 * The section a `?section=` deep link may open. `adminSection` is the
 * server-derived gate (an active admin per is_admin(), or demo mode); without
 * it "admin" resolves to nothing, so the shell falls back to its default.
 */
export function resolveSection(
  param: string | string[] | undefined,
  adminSection: boolean
): Tab | undefined {
  const value = Array.isArray(param) ? param[0] : param;
  const tab = SECTIONS.find((t) => t === value);
  if (tab === "admin" && !adminSection) return undefined;
  return tab;
}

/**
 * The URL for a section (QA b5 m5: the section lives in `?section=` so a
 * reload stays put and Back/Forward move between sections). Only the
 * section is kept: per-section state such as an open fan (`fan=`) is dropped.
 */
export function sectionHref(tab: Tab, pathname = "/dashboard"): string {
  return `${pathname}?section=${encodeURIComponent(tab)}`;
}

/** The section a URL's query asks for, or "today" (the shell's default). */
export function sectionFromSearch(search: string, adminSection: boolean): Tab {
  return resolveSection(new URLSearchParams(search).get("section") ?? undefined, adminSection) ?? "today";
}

/** `?section=fans&fan=<id>`: the fan drawer as its own history entry. */
export function fanHref(fanId: string, pathname = "/dashboard"): string {
  return `${sectionHref("fans", pathname)}&fan=${encodeURIComponent(fanId)}`;
}

export function fanFromSearch(search: string): string | null {
  const id = new URLSearchParams(search).get("fan");
  return id && id.length <= 200 ? id : null;
}
