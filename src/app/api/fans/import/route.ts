import { NextResponse } from "next/server";
import { createPass } from "@/lib/data";
import { createClient, isSupabaseConfigured } from "@/lib/supabase/server";
import { clientIp, rateLimitOr429 } from "@/lib/api/limit";
import { BAD_REQUEST, badRequest, parseJsonBody } from "@/lib/api/handler";

const MAX_ROWS = 500;
// Match the per-pass caps enforced by /api/passes so a single import row cannot
// grant an absurd spin count or amount.
const MAX_SPINS = 1_000_000;
const MAX_AMOUNT_CENTS = 100_000_000;

interface ImportRow {
  name: string;
  spins: number;
  amountCents?: number;
  campaignId?: string;
}

// Safe, consistent parse for numeric fields (spins, amountCents). Empty/missing
// values become 0 and negatives are floored to 0, but a non-integer input
// (e.g. "5.9", NaN) returns null so the caller can reject the row instead of
// silently truncating it, mirroring the Number.isInteger checks in /api/passes.
function safeCount(val: unknown): number | null {
  if (val == null || val === "") return 0;
  const n = Number(val);
  if (!Number.isInteger(n)) return null;
  return n > 0 ? n : 0;
}

// URL-safe, unguessable token for a fan link (mirrors @/lib/data randomToken).
function randomToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// A single normalized result slot, kept in original row order.
type Slot = {
  name: string;
  spins: number;
  amountCents: number;
  campaignId?: string;
  // Filled in as processing proceeds:
  wheelId?: string;
  token?: string;
  error?: string;
};

// Bulk-create fan accounts from parsed CSV rows. Each row mints a fresh fan.
export async function POST(req: Request) {
  // Require an authenticated creator up front: this is a bulk (up to 500) write,
  // so an unauthenticated caller must not be able to spin the loop at all. (Each
  // createPass re-checks auth too, but we reject early to avoid the amplification.)
  const configured = isSupabaseConfigured();
  let sb: Awaited<ReturnType<typeof createClient>> | null = null;
  let userId: string | null = null;
  if (configured) {
    sb = await createClient();
    const {
      data: { user },
    } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    userId = user.id;
    const limited = await rateLimitOr429("fan-import:" + user.id, 5, 60 * 1000);
    if (limited) return limited;
  } else {
    const limited = await rateLimitOr429("fan-import:" + clientIp(req), 5, 60 * 1000);
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

  // Normalize/validate every row once, preserving order. Blank-name rows fail
  // immediately exactly as before; the rest become insertable slots.
  const slots: Slot[] = rows.map((row) => {
    const name = typeof row?.name === "string" ? row.name.trim().slice(0, 80) : "";
    const spins = safeCount(row?.spins);
    if (!name) {
      return { name: "(blank)", spins: 0, amountCents: 0, error: "missing_name" };
    }
    if (spins === null) {
      return { name, spins: 0, amountCents: 0, error: "invalid_spins" };
    }
    if (spins > MAX_SPINS) {
      return { name, spins: 0, amountCents: 0, error: "spins_too_large" };
    }
    const amountCents = safeCount(row?.amountCents);
    if (amountCents === null) {
      return { name, spins: 0, amountCents: 0, error: "invalid_amount" };
    }
    if (amountCents > MAX_AMOUNT_CENTS) {
      return { name, spins: 0, amountCents: 0, error: "amount_too_large" };
    }
    return { name, spins, amountCents, campaignId: row?.campaignId || undefined };
  });

  const pending = slots.filter((s) => !s.error);

  if (!configured) {
    // Mock/in-memory path: no DB round-trips, so per-row creation is cheap and
    // keeps mock behavior identical.
    for (const s of pending) {
      const result = await createPass({
        name: s.name,
        spins: s.spins,
        amountCents: s.amountCents,
        campaignId: s.campaignId,
      });
      if ("error" in result) s.error = result.error;
      else s.token = result.token;
    }
  } else if (pending.length > 0 && sb && userId) {
    // Configured path: one round-trip per table instead of one per fan. Resolve
    // each row's target wheel (cached per campaign), then bulk-insert fans,
    // passes, and grants.
    const wheelCache = new Map<string, string | null>();
    // Tracks, per provided campaignId, whether it resolved to a campaign owned
    // by this creator. Rows referencing an unknown/non-owned campaign have their
    // campaignId dropped below so we never persist a cross-tenant/invalid
    // campaign_id to fan_passes/grants.
    const campaignOwned = new Map<string, boolean>();
    const resolveWheel = async (campaignId?: string): Promise<string | null> => {
      const key = campaignId ?? "";
      const cached = wheelCache.get(key);
      if (cached !== undefined) return cached;
      let wheelId: string | undefined;
      if (campaignId) {
        const { data: camp } = await sb!
          .from("campaigns")
          .select("pinned_wheel_id")
          .eq("id", campaignId)
          .eq("creator_id", userId!)
          .maybeSingle();
        campaignOwned.set(key, camp != null);
        wheelId = (camp as { pinned_wheel_id: string | null } | null)?.pinned_wheel_id ?? undefined;
      }
      if (!wheelId) {
        const { data: active } = await sb!
          .from("wheels")
          .select("id")
          .eq("creator_id", userId!)
          .eq("is_active", true)
          .is("archived_at", null)
          .maybeSingle();
        wheelId = (active as { id: string } | null)?.id;
      }
      if (!wheelId) {
        const { data: w } = await sb!
          .from("wheels")
          .select("id")
          .eq("creator_id", userId!)
          .is("archived_at", null)
          .order("created_at", { ascending: true })
          .limit(1)
          .maybeSingle();
        wheelId = (w as { id: string } | null)?.id;
      }
      const resolved = wheelId ?? null;
      wheelCache.set(key, resolved);
      return resolved;
    };

    for (const s of pending) {
      const wheelId = await resolveWheel(s.campaignId);
      // Never persist a campaign reference the caller does not own: drop it so
      // the row inserts with campaign_id = null instead of an unvalidated id.
      if (s.campaignId && !campaignOwned.get(s.campaignId)) {
        s.campaignId = undefined;
      }
      if (!wheelId) s.error = "no_wheel";
      else s.wheelId = wheelId;
    }

    const buildable = pending.filter((s) => !s.error);
    if (buildable.length > 0) {
      // Generate the primary keys client-side so fans, passes, and grants stay
      // correlated by explicit id. The import_fans RPC (migration 0034) inserts
      // all three tables in a single transaction, so any failure rolls the whole
      // batch back atomically — no orphaned fans/passes — and it re-verifies that
      // the caller owns every referenced wheel/campaign (SECURITY DEFINER bypasses
      // RLS).
      const fanIds = buildable.map(() => crypto.randomUUID());
      const passIds = buildable.map(() => crypto.randomUUID());
      const tokens = buildable.map(() => randomToken());

      const { error: importErr } = await sb.rpc("import_fans", {
        p_rows: buildable.map((s, i) => ({
          fan_id: fanIds[i],
          pass_id: passIds[i],
          token: tokens[i],
          wheel_id: s.wheelId,
          campaign_id: s.campaignId ?? null,
          name: s.name,
          spins: s.spins,
          amount_cents: s.amountCents,
        })),
      });

      if (importErr) {
        for (const s of buildable) s.error = "db_error";
      } else {
        buildable.forEach((s, i) => {
          s.token = tokens[i];
        });
      }
    }
  }

  const results: { name: string; token?: string; error?: string }[] = [];
  let created = 0;
  let failed = 0;
  for (const s of slots) {
    if (s.error) {
      failed += 1;
      results.push({ name: s.name, error: s.error });
    } else {
      created += 1;
      results.push({ name: s.name, token: s.token });
    }
  }

  return NextResponse.json({ created, failed, results });
}
