import { NextResponse } from "next/server";
import { createPass } from "@/lib/data";
import { createClient, isSupabaseConfigured } from "@/lib/supabase/server";
import { clientIp, rateLimitOr429 } from "@/lib/api/limit";

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

// Safe, consistent parse for numeric fields (spins, amountCents). Non-numeric or
// negative values become 0 instead of leaking NaN into the data layer.
function safeCount(val: unknown): number {
  const n = parseInt(String(val), 10);
  return !Number.isNaN(n) && n > 0 ? n : 0;
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

  // Normalize/validate every row once, preserving order. Blank-name rows fail
  // immediately exactly as before; the rest become insertable slots.
  const slots: Slot[] = rows.map((row) => {
    const name = typeof row?.name === "string" ? row.name.trim().slice(0, 80) : "";
    const spins = safeCount(row?.spins);
    if (!name) {
      return { name: "(blank)", spins: 0, amountCents: 0, error: "missing_name" };
    }
    if (spins > MAX_SPINS) {
      return { name, spins: 0, amountCents: 0, error: "spins_too_large" };
    }
    const amountCents = safeCount(row?.amountCents);
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
      if (!wheelId) s.error = "no_wheel";
      else s.wheelId = wheelId;
    }

    const buildable = pending.filter((s) => !s.error);
    if (buildable.length > 0) {
      const { data: fansData, error: fansErr } = await sb
        .from("fans")
        .insert(
          buildable.map((s) => ({
            creator_id: userId,
            display_name: s.name || "Fan",
            spins_remaining: s.spins,
            spins_granted_total: s.spins,
          }))
        )
        .select("id");
      const fanIds = (fansData as { id: string }[] | null) ?? [];

      if (fansErr || fanIds.length !== buildable.length) {
        for (const s of buildable) s.error = "db_error";
      } else {
        const tokens = buildable.map(() => randomToken());
        const { data: passData, error: passErr } = await sb
          .from("fan_passes")
          .insert(
            buildable.map((s, i) => ({
              token: tokens[i],
              creator_id: userId,
              wheel_id: s.wheelId,
              fan_id: fanIds[i].id,
              campaign_id: s.campaignId ?? null,
              spins_remaining: s.spins,
              spins_granted_total: s.spins,
            }))
          )
          .select("id");
        const passIds = (passData as { id: string }[] | null) ?? [];

        if (passErr || passIds.length !== buildable.length) {
          for (const s of buildable) s.error = "db_error";
        } else {
          const { error: grantErr } = await sb.from("grants").insert(
            buildable.map((s, i) => ({
              creator_id: userId,
              fan_id: fanIds[i].id,
              fan_pass_id: passIds[i].id,
              campaign_id: s.campaignId ?? null,
              spins: s.spins,
              amount_cents: s.amountCents,
              bonus_spins: 0,
            }))
          );
          if (grantErr) {
            for (const s of buildable) s.error = "db_error";
          } else {
            buildable.forEach((s, i) => {
              s.token = tokens[i];
            });
          }
        }
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
