import { NextResponse } from "next/server";
import { reportPublicPhoto } from "@/lib/data";
import { PHOTO_REPORTS_PER_IP, PHOTO_REPORTS_PER_PAGE, PUBLIC_PHOTO_NOTE_MAX } from "@/lib/data/publicReports";
import { PHOTO_REPORT_REASON } from "@/lib/creatorTheme/config";
import { clientIp } from "@/lib/api/clientIp";
import { rateLimitOr429 } from "@/lib/api/limit";
import { BAD_REQUEST, badRequest, errorResponse, parseJsonBody } from "@/lib/api/handler";
import { runAfterResponse } from "@/lib/afterResponse";
import { alertUrgentReport } from "@/lib/reports/alert";

const SLUG = /^[a-z0-9-]{1,80}$/i;
const MEDIA_ID = /^[A-Za-z0-9_-]{1,64}$/;

// A31: report a photo on a public /c/<slug> page without a spin link. Reviewed
// in Admin › Reports. The reason is fixed here (never taken from the request)
// and nothing identifying the visitor is stored or returned.
export async function POST(req: Request) {
  const limited = await rateLimitOr429("report-photo:" + clientIp(req), PHOTO_REPORTS_PER_IP, 10 * 60_000);
  if (limited) return limited;

  const body = await parseJsonBody<{ slug?: unknown; mediaId?: unknown; note?: unknown }>(req);
  if (body === BAD_REQUEST || body === null || typeof body !== "object") return badRequest();
  const { slug, mediaId, note } = body;
  if (typeof slug !== "string" || !SLUG.test(slug) || typeof mediaId !== "string" || !MEDIA_ID.test(mediaId)) {
    return badRequest();
  }
  if (note !== undefined && note !== null && (typeof note !== "string" || note.length > PUBLIC_PHOTO_NOTE_MAX)) {
    return badRequest();
  }

  // Many visitors can't flood one creator's queue (or the urgent alert). Only
  // a report on a real photo of a real page counts, keyed by its creator, so
  // junk requests can't use up the budget and block genuine reports.
  const page: { limited: NextResponse | null } = { limited: null };
  const result = await reportPublicPhoto(slug, mediaId, typeof note === "string" ? note : null, async (creatorId) => {
    page.limited = await rateLimitOr429("report-photo-page:" + creatorId, PHOTO_REPORTS_PER_PAGE, 60 * 60_000);
    return page.limited === null;
  });
  if (page.limited) return page.limited;
  if ("error" in result) return errorResponse(result.error);
  runAfterResponse(() => alertUrgentReport({ reason: PHOTO_REPORT_REASON, at: new Date().toISOString() }));
  return NextResponse.json({ ok: true });
}
