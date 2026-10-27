import { NextResponse } from "next/server";
import { clientIp } from "@/lib/api/clientIp";
import { rateLimitOr429 } from "@/lib/api/limit";
import { rateLimit } from "@/lib/rateLimit";
import {
  ERROR_REPORT_GLOBAL,
  ERROR_REPORT_MAX_BYTES,
  ERROR_REPORT_PER_IP,
  ERROR_REPORT_WINDOW_MS,
} from "@/lib/monitoring/config";
import { parseClientReport, readCappedText } from "@/lib/monitoring/report";
import { captureAfterResponse } from "@/lib/monitoring/capture";

// Browser error reports (window errors, unhandled rejections, React error
// boundaries). Unauthenticated by design, so it is built to be boring to abuse:
//   * per-IP rate limit through the shared limiter, plus a global cap;
//   * a hard body-size cap enforced while reading (no oversized buffering);
//   * a strict whitelist schema (unknown keys or wrong types → 400);
//   * the response never echoes input: 204 with no body on success;
//   * everything is redacted server-side before it is stored or e-mailed,
//     and the write + any alert run after the response.
export async function POST(req: Request) {
  const limited = await rateLimitOr429(`errors:${clientIp(req)}`, ERROR_REPORT_PER_IP, ERROR_REPORT_WINDOW_MS);
  if (limited) return limited;
  if (!rateLimit("errors:all", ERROR_REPORT_GLOBAL, ERROR_REPORT_WINDOW_MS).ok) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": "60" } });
  }

  const type = (req.headers.get("content-type") ?? "").toLowerCase();
  if (!type.startsWith("application/json")) {
    return NextResponse.json({ error: "unsupported_media_type" }, { status: 415 });
  }

  const text = await readCappedText(req, ERROR_REPORT_MAX_BYTES);
  if (text === "too_large") return NextResponse.json({ error: "too_large" }, { status: 413 });

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const report = parseClientReport(raw);
  if (!report) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  captureAfterResponse({
    source: "client",
    message: report.message,
    stack: report.stack,
    route: report.route,
    userAgent: req.headers.get("user-agent"),
  });
  return new NextResponse(null, { status: 204 });
}
