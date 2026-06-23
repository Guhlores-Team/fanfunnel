import { NextResponse } from "next/server";
import { createPass } from "@/lib/data";
import { createClient, isSupabaseConfigured } from "@/lib/supabase/server";
import { clientIp, rateLimitOr429 } from "@/lib/api/limit";
import { BAD_REQUEST, badRequest, parseJsonBody } from "@/lib/api/handler";

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

  const body = await parseJsonBody<{ rows?: ImportRow[] }>(req);
  if (body === BAD_REQUEST) return badRequest();

  const rows = body.rows;
  if (!Array.isArray(rows) || rows.length === 0) {
    return badRequest();
  }
  if (rows.length > MAX_ROWS) {
    return badRequest("too_many_rows");
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
