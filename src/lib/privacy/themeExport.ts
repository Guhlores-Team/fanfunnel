import { normalizeTheme, toDbTheme } from "@/lib/creatorTheme/config";

/** A theme is an inventory of preset keys, never arbitrary nested JSON or URLs. */
export function exportCreatorTheme(raw: unknown): Record<string, string> {
  return toDbTheme(normalizeTheme(raw));
}
