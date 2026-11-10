import { NextResponse } from "next/server";
import { completeReadResponse } from "@/lib/api/completeRead";
import { listFans } from "@/lib/data";
import { limitRoute } from "@/lib/api/limit";
import { csvDateStamp, csvHeaders, toCsv } from "@/lib/csv";

// PR-07: the creator's fans as a spreadsheet (every fan; the complete-read
// bound still applies, so a very large account gets 503 data_unavailable
// rather than a partial file). Cells are formula-safe (src/lib/csv.ts).
export async function GET(req: Request) {
  const rateLimited = await limitRoute(req, "fans/export:GET", "costly");
  if (rateLimited) return rateLimited;
  return completeReadResponse(async () => {
    const fans = await listFans();
    const rows: unknown[][] = [["Fan", "Spins left", "Spins granted", "Tips recorded (USD)", "Campaigns", "Tags", "Last win", "Last win at", "Blocked", "Paused by fan", "Visits (7 days)", "Fan id"]];
    for (const f of fans) {
      rows.push([
        f.name, f.spinsRemaining, f.grantedTotal, (f.totalSpent / 100).toFixed(2), f.campaignNames.join("; "), f.tags.join("; "),
        f.lastWin?.label ?? "", f.lastWin?.at ?? "", f.blocked ? "yes" : "no", f.selfExcluded ? "yes" : "no", f.visits7 ?? 0, f.fanId,
      ]);
    }
    return new NextResponse(toCsv(rows), { headers: csvHeaders(`fanfunnel-fans-${csvDateStamp()}.csv`) });
  });
}
