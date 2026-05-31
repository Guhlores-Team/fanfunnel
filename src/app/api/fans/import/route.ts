import { NextResponse } from "next/server";
import { createPass } from "@/lib/data";

const MAX_ROWS = 500;

interface ImportRow {
  name: string;
  spins: number;
  amountCents?: number;
  campaignId?: string;
}

// Bulk-create fan accounts from parsed CSV rows. Each row mints a fresh fan.
export async function POST(req: Request) {
  let body: { rows?: ImportRow[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const rows = body.rows;
  if (!Array.isArray(rows) || rows.length === 0) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (rows.length > MAX_ROWS) {
    return NextResponse.json({ error: "too_many_rows" }, { status: 400 });
  }

  const results: { name: string; token?: string; error?: string }[] = [];
  let created = 0;
  let failed = 0;

  for (const row of rows) {
    const name = typeof row?.name === "string" ? row.name.trim() : "";
    const spins = Math.max(0, Math.floor(Number(row?.spins)) || 0);
    if (!name) {
      failed += 1;
      results.push({ name: name || "(blank)", error: "missing_name" });
      continue;
    }

    const result = await createPass({
      name,
      spins,
      amountCents:
        row?.amountCents != null ? Math.max(0, Math.floor(row.amountCents)) : undefined,
      campaignId: row?.campaignId || undefined,
    });

    if ("error" in result) {
      failed += 1;
      results.push({ name, error: result.error });
    } else {
      created += 1;
      results.push({ name, token: result.token });
    }
  }

  return NextResponse.json({ created, failed, results });
}
