// A31: a visitor to the public /c/<slug> page reports one of the creator's
// gallery photos without a spin link. The report joins the same Admin ›
// Reports queue as fan reports (creator_reports), with no fan, no token and
// nothing about the visitor: the reason is fixed server-side and the detail
// says only which page and photo were reported, plus the visitor's own note.
import { isSupabaseConfigured, createServiceClient } from "@/lib/supabase/server";
import { PHOTO_HUB_ENABLED, PHOTO_REPORT_REASON } from "@/lib/creatorTheme/config";
import { mockGetMedia } from "./mockTheme";
import { MOCK_REPORTED_CREATOR } from "./mock";
import { addMockReport } from "./mockReports";
import { PUBLIC_PHOTO_NOTE_MAX } from "@/lib/reports/config";

export { PUBLIC_PHOTO_NOTE_MAX };
/** Reports per visitor IP per 10 minutes, and per public page per hour. The
 * page ceiling is a sanity bound on one creator's review queue (and the
 * urgent alert), set well above what a single address can send (N-D: at 30 it
 * took two addresses to lock every genuine visitor out of reporting a page
 * for an hour); the per-address cap is what stops one visitor. */
export const PHOTO_REPORTS_PER_IP = 3;
export const PHOTO_REPORTS_PER_PAGE = 300;

function reportDetail(slug: string, mediaId: string, note: string | null): string {
  const where = `Reported from the public page /c/${slug} · photo ${mediaId}`;
  return note ? `${where}\n\nVisitor note: ${note}` : where;
}

/**
 * `admit` runs once the page and photo are known to be real, with the page's
 * creator id, and returns false to refuse (rate limit) before anything is
 * stored: so refused or junk requests never use up a page's report budget.
 */
export async function reportPublicPhoto(
  slug: string,
  mediaId: string,
  note?: string | null,
  admit: (creatorId: string) => Promise<boolean> = async () => true,
): Promise<{ ok: true } | { error: string }> {
  const cleanNote = note?.trim() ? note.trim().slice(0, PUBLIC_PHOTO_NOTE_MAX) : null;
  if (!PHOTO_HUB_ENABLED) return { error: "not_found" };

  if (!isSupabaseConfigured()) {
    // The demo has one creator; any slug renders it, as getPublicProfileBySlug does.
    if (!mockGetMedia(mediaId)) return { error: "not_found" };
    if (!(await admit(MOCK_REPORTED_CREATOR))) return { error: "rate_limited" };
    addMockReport({
      creatorId: MOCK_REPORTED_CREATOR,
      fanId: null,
      token: null,
      reason: PHOTO_REPORT_REASON,
      detail: reportDetail(slug, mediaId, cleanNote),
    });
    return { ok: true };
  }

  const sb = createServiceClient();
  const { data: prof, error: profError } = await sb
    .from("profiles")
    .select("id")
    .eq("public_slug", slug)
    .maybeSingle();
  if (profError) return { error: "db_error" };
  const creatorId = (prof as { id: string } | null)?.id;
  if (!creatorId) return { error: "not_found" };

  // Only a photo this creator's public page actually shows can be reported.
  const { data: media, error: mediaError } = await sb
    .from("creator_media")
    .select("id")
    .eq("id", mediaId)
    .eq("creator_id", creatorId)
    .maybeSingle();
  if (mediaError) return { error: "db_error" };
  if (!media) return { error: "not_found" };
  if (!(await admit(creatorId))) return { error: "rate_limited" };

  const { error } = await sb.from("creator_reports").insert({
    creator_id: creatorId,
    fan_id: null,
    token: null,
    reason: PHOTO_REPORT_REASON,
    detail: reportDetail(slug, mediaId, cleanNote),
  });
  return error ? { error: "db_error" } : { ok: true };
}
