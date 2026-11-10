// Data layer: the announced Terms/Privacy change (TS-06, migration 0073).
//
// Read: every page that shows the notice is public or fan-facing, so the read
// goes through the service client on the server (legal_terms_upcoming() is
// not granted to anon) and returns only the version and the date. Write: the
// admin's own session client calls set_legal_terms_notice(), which checks
// is_admin() itself (active admin, aal2) on top of the route's
// requireAdminRoute(); nothing here elevates a caller.
import { createClient, createServiceClient, isSupabaseConfigured } from "@/lib/supabase/server";
import { LEGAL, activeLegalChangeNotice, type LegalChangeNotice } from "@/lib/legal";

type Stored = LegalChangeNotice | null;
const demo = globalThis as { __ffLegalNotice?: Stored };

const CACHE_MS = 60_000;
let cached: { at: number; value: Stored } | null = null;

function fromRow(value: unknown): Stored {
  if (!value || typeof value !== "object") return null;
  const row = value as { version?: unknown; effectiveAt?: unknown };
  if (typeof row.version !== "string" || typeof row.effectiveAt !== "string") return null;
  return { version: row.version, effectiveDate: row.effectiveAt.slice(0, 10) };
}

/** The stored notice as an admin set it (even if its date has passed), else LEGAL.upcoming. */
export async function getStoredLegalNotice(): Promise<Stored> {
  if (!isSupabaseConfigured()) return demo.__ffLegalNotice ?? LEGAL.upcoming;
  try {
    const { data, error } = await createServiceClient().rpc("legal_terms_upcoming").abortSignal(AbortSignal.timeout(3000));
    if (error) {
      // A database without 0073 yet, or a blip: the code-set notice still applies.
      console.error("legal notice: read failed", error.code ?? "error");
      return LEGAL.upcoming;
    }
    return fromRow(data) ?? LEGAL.upcoming;
  } catch {
    return LEGAL.upcoming;
  }
}

/** The notice to show right now (null once its date has passed), cached for a minute per instance. */
export async function getActiveLegalNotice(now: Date = new Date()): Promise<Stored> {
  if (!cached || now.getTime() - cached.at > CACHE_MS) cached = { at: now.getTime(), value: await getStoredLegalNotice() };
  return activeLegalChangeNotice(now, cached.value);
}

/**
 * Announce (or, with null, withdraw) a Terms change. The caller's route has
 * already passed requireAdminRoute(); the database checks is_admin() again.
 */
export async function setLegalNotice(
  input: { version: string; effectiveDate: string } | null,
): Promise<{ ok: true; notice: Stored } | { error: "unauthorized" | "forbidden" | "invalid_notice" | "db_error" }> {
  cached = null;
  if (!isSupabaseConfigured()) {
    demo.__ffLegalNotice = input ? { version: input.version, effectiveDate: input.effectiveDate } : null;
    return { ok: true, notice: demo.__ffLegalNotice };
  }
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { error: "unauthorized" };
  const args = { p_version: input?.version ?? null, p_effective_at: input?.effectiveDate ?? null };
  const { data, error } = await sb.rpc("set_legal_terms_notice", args as unknown as { p_version: string; p_effective_at: string });
  if (error) {
    if (error.code === "42501") return { error: "forbidden" };
    if (error.code === "22023") return { error: "invalid_notice" };
    console.error("legal notice: write failed", error.code ?? "error");
    return { error: "db_error" };
  }
  return { ok: true, notice: fromRow(data) };
}

/**
 * The addresses the announcement e-mail goes to: active, approved creators.
 * Service client, reached only after the route's admin guard.
 */
export async function listCreatorEmailsForLegalNotice(limit = 1000): Promise<string[] | "error"> {
  if (!isSupabaseConfigured()) return [];
  const { data, error } = await createServiceClient()
    .from("profiles")
    .select("email")
    .eq("role", "creator")
    .eq("approval_status", "approved")
    .eq("is_active", true)
    .not("email", "is", null)
    .limit(limit);
  if (error) return "error";
  const seen = new Set<string>();
  for (const row of (data ?? []) as { email: string | null }[]) {
    const email = (row.email ?? "").trim().toLowerCase();
    if (/^[^\s@<>,]+@[^\s@<>,]+\.[^\s@<>,]+$/.test(email)) seen.add(email);
  }
  return [...seen];
}
