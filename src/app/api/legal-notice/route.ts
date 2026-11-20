import { NextResponse } from "next/server";
import { limitRoute } from "@/lib/api/limit";
import { getActiveLegalNotice } from "@/lib/data/legalNotice";

// TS-06: the announced Terms/Privacy change, for the one-line notice fan
// pages and the dashboard show until it takes effect. Public by nature (the
// notice is shown to everyone): only the version and the date leave the
// server. Briefly cacheable at the edge; browsers always revalidate so a
// notice an admin just set or withdrew shows on the next page load.
export async function GET(req: Request) {
  const rateLimited = await limitRoute(req, "legal-notice:GET", "public");
  if (rateLimited) return rateLimited;
  const notice = await getActiveLegalNotice();
  return NextResponse.json(
    { notice: notice ? { version: notice.version, effectiveDate: notice.effectiveDate, ...(notice.summary ? { summary: notice.summary } : {}) } : null },
    { headers: { "Cache-Control": "public, max-age=0, must-revalidate, s-maxage=60" } },
  );
}
