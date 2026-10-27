// Data layer — creator Terms acceptance (migration 0055).
//
// Reads use the signed-in creator's session client (profiles_select allows a
// creator to read their own row). The write goes through the server-only
// record_terms_acceptance() RPC on the service client, keyed to the SESSION
// user's id and the server's LEGAL.version: nothing in the request picks the
// account, the version or the time (the RPC stamps now()).
import { isSupabaseConfigured, createServiceClient, createClient } from "@/lib/supabase/server";
import { LEGAL, acceptedCurrentTerms } from "@/lib/legal";
import { mockAcceptMyTerms, mockGetMyTerms } from "./mock";

export interface TermsStatus {
  /** The version this account agreed to (null = never recorded). */
  version: string | null;
  acceptedAt: string | null;
  /** The current version (LEGAL.version). */
  current: string;
  /** True when the account must (re)accept before continuing. */
  needsAcceptance: boolean;
}

function toStatus(version: string | null, acceptedAt: string | null): TermsStatus {
  return { version, acceptedAt, current: LEGAL.version, needsAcceptance: !acceptedCurrentTerms(version) };
}

/** The signed-in creator's Terms acceptance. */
export async function getMyTermsStatus(): Promise<TermsStatus | { error: "unauthorized" }> {
  if (!isSupabaseConfigured()) {
    const t = mockGetMyTerms();
    return toStatus(t.version, t.acceptedAt);
  }
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { error: "unauthorized" };
  const { data, error } = await sb
    .from("profiles")
    .select("terms_version, terms_accepted_at")
    .eq("id", user.id)
    .maybeSingle();
  if (error) {
    // A database without 0055 yet: don't block the dashboard on a prompt whose
    // answer couldn't be saved.
    console.error("terms: status read failed", error.message);
    return { ...toStatus(null, null), needsAcceptance: false };
  }
  const row = data as { terms_version: string | null; terms_accepted_at: string | null } | null;
  return toStatus(row?.terms_version ?? null, row?.terms_accepted_at ?? null);
}

/** Record that the signed-in creator accepts the CURRENT Terms and Privacy Policy. */
export async function acceptMyTerms(): Promise<TermsStatus | { error: "unauthorized" | "db_error" }> {
  if (!isSupabaseConfigured()) {
    const t = mockAcceptMyTerms();
    return toStatus(t.version, t.acceptedAt);
  }
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { error: "unauthorized" };
  const svc = createServiceClient();
  const { data, error } = await svc.rpc("record_terms_acceptance", {
    p_user: user.id,
    p_version: LEGAL.version,
  });
  if (error || !data) {
    console.error("terms: acceptance write failed", error?.message ?? "no row");
    return { error: "db_error" };
  }
  return toStatus(LEGAL.version, data);
}
