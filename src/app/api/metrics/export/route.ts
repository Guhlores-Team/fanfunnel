import { NextResponse } from "next/server";
import { completeReadResponse } from "@/lib/api/completeRead";
import { getMetricsExtra } from "@/lib/data";
import { limitRoute } from "@/lib/api/limit";
import { csvDateStamp, csvHeaders, toCsv } from "@/lib/csv";

// PR-07: daily spins and tips recorded for the last N days (UTC dates).
export async function GET(req: Request) {
  const rateLimited = await limitRoute(req, "metrics/export:GET", "costly");
  if (rateLimited) return rateLimited;
  return completeReadResponse(async () => {
    const raw = Number(new URL(req.url).searchParams.get("days"));
    const days = Number.isFinite(raw) && raw > 0 ? Math.min(90, Math.max(1, Math.floor(raw))) : 30;
    const metrics = await getMetricsExtra(days);
    const cents = new Map(metrics.revenueTrend.map((r) => [r.date, r.cents]));
    const dates = [...new Set([...metrics.trend.map((d) => d.date), ...metrics.revenueTrend.map((r) => r.date)])].sort();
    const spins = new Map(metrics.trend.map((d) => [d.date, d.spins]));
    const rows: unknown[][] = [["Date (UTC)", "Spins", "Tips recorded (USD)"]];
    for (const date of dates) rows.push([date, spins.get(date) ?? 0, ((cents.get(date) ?? 0) / 100).toFixed(2)]);
    return new NextResponse(toCsv(rows), { headers: csvHeaders(`fanfunnel-daily-${days}d-${csvDateStamp()}.csv`) });
  });
}
