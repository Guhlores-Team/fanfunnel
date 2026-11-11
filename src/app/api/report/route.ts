import { NextResponse } from "next/server";
import { withFanMissLimit } from "@/lib/api/fanMiss";
import { reportCreator } from "@/lib/data";
import { clientIp } from "@/lib/api/clientIp";
import { rateLimitOr429 } from "@/lib/api/limit";
import { BAD_REQUEST, badRequest, errorResponse, parseJsonBody } from "@/lib/api/handler";
import { runAfterResponse } from "@/lib/afterResponse";
import { alertUrgentReport } from "@/lib/reports/alert";
import { isValidFanToken } from "@/lib/pwa/manifest";
import { REPORT_REASONS } from "@/lib/reports/config";

// A fan reports the creator behind their token (predatory / rule-breaking).
// Reviewed in Admin › Reports (/api/admin/reports).
export async function POST(req: Request) {
  return withFanMissLimit(req, async () => {
    const limited = await rateLimitOr429("report:" + clientIp(req), 5, 60_000);
    if (limited) return limited;

    const body = await parseJsonBody<{ token?: string; reason?: string; detail?: string }>(req);
    if (body === BAD_REQUEST) return badRequest();
    // The token is stored on the report: only a well-formed link token (the
    // minted shape, at most 128 characters), never an arbitrary string.
    if (
      !isValidFanToken(body.token) ||
      typeof body.reason !== "string" ||
      // TS-08: one of the listed reasons, never free text in the reason field.
      !(REPORT_REASONS as readonly string[]).includes(body.reason) ||
      (body.detail !== undefined &&
        (typeof body.detail !== "string" || body.detail.length > 2000))
    ) {
      return badRequest();
    }
    const result = await reportCreator(body.token, body.reason, body.detail);
    if ("error" in result) return errorResponse(result.error);
    // Urgent reasons e-mail the team after the response (reason + time only).
    const report = { reason: body.reason, at: new Date().toISOString() };
    runAfterResponse(() => alertUrgentReport(report));
    return NextResponse.json(result);
  });
}
