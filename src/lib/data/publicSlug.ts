// The public page's link name (/c/<slug>): its stored form and what the
// Settings field can say about it while the creator types. Pure, so the
// dashboard, the save route and the data layer share one rule.

import { isReservedName } from "@/lib/reservedNames";

export const MAX_SLUG_LEN = 64;
/** Characters the save route accepts in the raw field (it is normalized after). */
export const SLUG_INPUT_RE = /^[A-Za-z0-9 _-]*$/;

/** The stored form of a public slug (the `/c/<slug>` path segment). */
export function normalizePublicSlug(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export interface SlugHint {
  /** What a save would store. Empty when the field holds nothing usable. */
  normalized: string;
  /** The save route would refuse this input, with the code it would answer. */
  problem: "invalid_slug" | "slug_reserved" | null;
  /** Shown when the stored form differs from what was typed. */
  savedAs: string | null;
  /** The live link a save would retire (a rename or a removal). */
  retires: string | null;
}

export function slugHint(typed: string, saved: string): SlugHint {
  const normalized = normalizePublicSlug(typed);
  const problem =
    typed.length > MAX_SLUG_LEN || !SLUG_INPUT_RE.test(typed) ? "invalid_slug" : isReservedName(typed) ? "slug_reserved" : null;
  return {
    normalized,
    problem,
    savedAs: problem === null && normalized !== "" && normalized !== typed ? normalized : null,
    retires: saved !== "" && normalized !== saved ? saved : null,
  };
}
