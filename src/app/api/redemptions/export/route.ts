import { NextResponse } from "next/server";
import { listRedemptionQueue } from "@/lib/data/redemptionQueue";
import type { RedemptionStatus } from "@/lib/data/types";
import { errorResponse } from "@/lib/api/handler";
import { limitRoute } from "@/lib/api/limit";
import { csvDateStamp, csvHeaders, toCsv } from "@/lib/csv";

const VALID: RedemptionStatus[] = ["pending", "in_progress", "fulfilled", "cancelled"];
/** Pages of 100, newest first: at most 5,000 wins per file. */
export const EXPORT_MAX_ROWS = 5_000;

// PR-07: the prize queue as a spreadsheet, `?status=` optional (all when
// absent), newest first, bounded. Formula-safe cells.
export async function GET(req: Request) {
  const rateLimited = await limitRoute(req, "redemptions/export:GET", "costly");
  if (rateLimited) return rateLimited;
  const raw = new URL(req.url).searchParams.get("status");
  const status = raw ? (VALID as string[]).includes(raw) ? (raw as RedemptionStatus) : null : undefined;
  if (status === null) return errorResponse("bad_request");
  const rows: unknown[][] = [["Fan", "Prize", "Rarity", "Status", "Won at", "Due date", "Notes", "Game", "Win id"]];
  let before: string | null = null;
  let truncated = false;
  while (rows.length - 1 < EXPORT_MAX_ROWS) {
    const page = await listRedemptionQueue({ status, before, limit: 100 });
    if ("error" in page) return errorResponse(page.error);
    for (const r of page.items) {
      rows.push([r.fanName, r.prizeLabel, r.rarity, r.status, r.at, r.dueAt ?? "", r.notes ?? "", r.gameKind ?? "", r.id]);
    }
    if (!page.next) break;
    before = page.next;
    if (rows.length - 1 >= EXPORT_MAX_ROWS) truncated = true;
  }
  const name = `fanfunnel-wins${status ? `-${status}` : ""}-${csvDateStamp()}.csv`;
  return new NextResponse(toCsv(rows), { headers: { ...csvHeaders(name), ...(truncated ? { "X-FanFunnel-Truncated": String(EXPORT_MAX_ROWS) } : {}) } });
}
