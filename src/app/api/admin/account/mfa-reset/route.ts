import { NextResponse } from "next/server";
import { createServiceClient, isSupabaseConfigured } from "@/lib/supabase/server";
import { requireAdminRoute } from "@/lib/auth/admin";
import { recordAudit } from "@/lib/data";
import { isUuid } from "@/lib/data/shared";
import { BAD_REQUEST, badRequest, parseJsonBody } from "@/lib/api/handler";

/**
 * Admin-initiated two-factor reset for an account that lost its authenticator
 * (Supabase TOTP has no recovery codes). Removes every MFA factor of the
 * target; they sign in with their password and enrol again (an admin target
 * must, before the admin area opens). Body: { id }.
 *
 * Guarded by requireAdminRoute (active admin on an aal2 session). It resets
 * OTHER accounts only; an admin manages their own factors in Settings ›
 * Security. Service role: deleting another user's factor is an Auth admin API
 * call. Recorded in the activity log.
 */
export async function POST(req: Request) {
  const admin = await requireAdminRoute();
  if (!admin.ok) return admin.response;

  const body = await parseJsonBody<{ id?: unknown }>(req);
  if (body === BAD_REQUEST || typeof body.id !== "string" || !isUuid(body.id)) return badRequest();
  const id = body.id;

  if (!isSupabaseConfigured()) {
    await recordAudit({ actorId: admin.userId, action: "account.mfa_reset", targetType: "profile", targetId: id });
    return NextResponse.json({ ok: true, removed: 0 });
  }
  if (id === admin.userId) {
    return NextResponse.json({ error: "cannot_reset_self" }, { status: 400 });
  }

  const svc = createServiceClient();
  const { data, error } = await svc.auth.admin.mfa.listFactors({ userId: id });
  if (error) return NextResponse.json({ error: "not_found" }, { status: 404 });
  let removed = 0;
  for (const f of data?.factors ?? []) {
    const { error: delErr } = await svc.auth.admin.mfa.deleteFactor({ userId: id, id: f.id });
    if (delErr) return NextResponse.json({ error: "reset_failed" }, { status: 500 });
    removed++;
  }

  await recordAudit({
    actorId: admin.userId,
    action: "account.mfa_reset",
    targetType: "profile",
    targetId: id,
    details: { factorsRemoved: removed },
  });
  return NextResponse.json({ ok: true, removed });
}
