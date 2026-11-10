// Data layer — the one read behind every unauthenticated creator surface (L5):
// the profile row, returned only when the account may be shown publicly.
import type { createServiceClient } from "@/lib/supabase/server";
import { PUBLIC_CREATOR_COLUMNS, isPublicCreator, type PublicCreatorRow } from "@/lib/publicCreator";
import { FanPassUnavailableError } from "./unavailable";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The creator behind a public URL segment, or null when there is none or the
 * account is inactive or not approved. `by` says what the segment is: a
 * profile id, a public slug, or either (a UUID is read as an id, anything
 * else as a slug). `extra` names further profile columns the caller needs.
 * `strict` throws FanPassUnavailableError on a read fault (OPS3-02/06: a
 * fan-facing page then shows "temporarily unavailable", not "not found").
 */
export async function readPublicCreator<Extra extends object = Record<never, never>>(
  sb: ReturnType<typeof createServiceClient>,
  key: string,
  opts: { by: "id" | "slug" | "either"; extra?: string; strict?: boolean },
): Promise<(PublicCreatorRow & Extra) | null> {
  if (!key) return null;
  // A non-UUID id simply matches nothing (the database refuses the cast).
  const column = opts.by === "slug" || (opts.by === "either" && !UUID_RE.test(key)) ? "public_slug" : "id";
  const cols = opts.extra ? `${PUBLIC_CREATOR_COLUMNS}, ${opts.extra}` : PUBLIC_CREATOR_COLUMNS;
  const { data, error } = await sb.from("profiles").select(cols).eq(column, key).maybeSingle();
  if (error && opts.strict) throw new FanPassUnavailableError("profiles read failed");
  if (error || !data) return null;
  const row = data as unknown as PublicCreatorRow & Extra;
  return isPublicCreator(row) ? row : null;
}
