import { NextResponse } from "next/server";
import { createPass } from "@/lib/data";
import { createClient, isSupabaseConfigured } from "@/lib/supabase/server";
import { clientIp, rateLimitOr429 } from "@/lib/api/limit";

const MAX_ROWS = 500;

interface ImportRow {
  name: string;
  spins: number;
  amountCents?: number;
  campaignId?: string;
}

// Bulk-create fan accounts from parsed CSV rows. Each row mints a fresh fan.
export async function POST(req: Request) {
  // Require an authenticated creator up front: this is a bulk (up to 500) write,
  // so an unauthenticated caller must not be able to spin the loop at all. (Each
  // createPass re-checks auth too, but we reject early to avoid the amplification.)
  if (isSupabaseConfigured()) {
    const sb = await createClient();
    const {
      data: { user },
    } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const limited = rateLimitOr429("fan-import:" + user.id, 5, 60 * 1000);
    if (limited) return limited;
  } else {
    const limited = rateLimitOr429("fan-import:" + clientIp(req), 5, 60 * 1000);
    if (limited) return limited;
  }

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
    const name = typeof row?.name === "string" ? row.name.trim().slice(0, 80) : "";
    const spins = Math.max(0, Math.floor(Number(row?.spins)) || 0);
    if (!name) {
      failed += 1;
      results.push({ name: name || "(blank)", error: "missing_name" });
      continue;
    }

    let amountCents: number | undefined;
    if (row?.amountCents != null) {
      const n = Number(row.amountCents);
      amountCents = Number.isFinite(n)
        ? Math.min(100_000_000, Math.max(0, Math.floor(n)))
        : undefined;
    }

    const result = await createPass({
      name,
      spins,
      amountCents,
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
