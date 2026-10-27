import "server-only";
import { NextResponse } from "next/server";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { supabaseUrl } from "@/lib/supabase/url";
import { mfaStep, type SessionAssurance } from "./assurance";

/**
 * Step-up checks for account actions that can't be undone or that hand data
 * out (export, close account, remove a two-factor factor). Same pattern as
 * POST /api/account/email: the password is checked on a throwaway client that
 * never persists a session, so the live session cookies are untouched.
 */
export async function verifyCurrentPassword(email: string, password: string): Promise<boolean> {
  if (!email || !password) return false;
  const verifier = createSupabaseClient(
    supabaseUrl(),
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
  const { error } = await verifier.auth.signInWithPassword({ email, password });
  return !error;
}

/**
 * A user who turned two-factor on must have used it in THIS session before a
 * sensitive account action: a stolen password alone (an aal1 session) gets a
 * 403 `mfa_required` here. Users without a verified factor pass.
 */
export function mfaStepUpResponse(assurance: SessionAssurance): NextResponse | null {
  if (mfaStep(assurance, false) === "ok") return null;
  return NextResponse.json(
    { error: "mfa_required", step: "challenge" },
    { status: 403, headers: { "Cache-Control": "no-store, max-age=0" } }
  );
}
