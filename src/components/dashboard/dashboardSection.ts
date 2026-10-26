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
