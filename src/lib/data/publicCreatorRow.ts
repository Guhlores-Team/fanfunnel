// Data layer — the one read behind every unauthenticated creator surface (L5):
// the profile row, returned only when the account may be shown publicly.
import type { createServiceClient } from "@/lib/supabase/server";
import { PUBLIC_CREATOR_COLUMNS, isPublicCreator, type PublicCreatorRow } from "@/lib/publicCreator";
import { FanPassUnavailableError } from "./unavailable";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Postgres codes that mean "no such row", never "the database failed":
// 22P02 is the uuid cast a non-UUID id provokes.
const NO_ROW_CODES = new Set(["22P02"]);

/** Whether a PostgREST error is a real failure (not a missing-row shape). */
export function readFailed(error: { code?: string } | null | undefined): error is { code?: string } {
  return !!error && !NO_ROW_CODES.has(error.code ?? "");
}

/**
 * The creator behind a public URL segment, or null when there is none or the
 * account is inactive or not approved. `by` says what the segment is: a
 * profile id, a public slug, or either (a UUID is read as an id, anything
 * else as a slug). `extra` names further profile columns the caller needs.
 * OPS3-02/06: a read that failed (the database refused or is down), as
 * opposed to one that found no row, throws FanPassUnavailableError for every
 * caller: the page then shows "temporarily unavailable" (its error.tsx), not
 * "not found", and a cached public page keeps its last good copy.
 */
export async function readPublicCreator<Extra extends object = Record<never, never>>(
  sb: ReturnType<typeof createServiceClient>,
  key: string,
  opts: { by: "id" | "slug" | "either"; extra?: string },
): Promise<(PublicCreatorRow & Extra) | null> {
  if (!key) return null;
  // A non-UUID id simply matches nothing (the database refuses the cast).
  const column = opts.by === "slug" || (opts.by === "either" && !UUID_RE.test(key)) ? "public_slug" : "id";
  const cols = opts.extra ? `${PUBLIC_CREATOR_COLUMNS}, ${opts.extra}` : PUBLIC_CREATOR_COLUMNS;
  const { data, error } = await sb.from("profiles").select(cols).eq(column, key).maybeSingle();
  if (readFailed(error)) throw new FanPassUnavailableError("profiles read failed");
  if (!data) return null;
  const row = data as unknown as PublicCreatorRow & Extra;
  return isPublicCreator(row) ? row : null;
}
