import { NextResponse } from "next/server";
import {
  isSupabaseConfigured,
  createServiceClient,
} from "@/lib/supabase/server";
import { requireAdminRoute } from "@/lib/auth/admin";
import { deleteAccountAndTombstoneLinks } from "@/lib/account/deleteAccount";
import { recordAudit } from "@/lib/data";

/**
 * Hard-delete a creator account and ALL of its tenant data — irreversible.
 *
 * This is deliberately separate from the reversible "suspend" action in
 * `../route.ts`. It is guarded several ways (defense in depth):
 *   1. Caller must be an ACTIVE admin (the shared `requireAdminRoute()` guard:
 *      `is_admin()`, i.e. role AND is_active — a suspended admin is rejected).
 *   2. The target's email must be passed AND match the target exactly
 *      (case-insensitive) — a typed-confirmation echoed from the client.
 *   3. An admin may not delete themselves.
 *   4. The last remaining admin may not be deleted (never lock everyone out).
 *
 * Deletion relies on ON DELETE CASCADE: `profiles.id` references
 * `auth.users(id) on delete cascade`, and every tenant table references
 * `public.profiles(id) on delete cascade` via `creator_id` (wheels, fans,
 * prizes, spins, grants, campaigns, fan_passes, redemptions, referrals,
 * messages, orgs, org_members, org_creator_access, …). No foreign key uses
 * RESTRICT/NO ACTION, so removing the Supabase auth user removes everything the
 * account owned — no orphaned rows. We therefore delete the auth user via the
 * service-role admin API and let the database cascade do the rest.
 */
export async function POST(req: Request) {
  const admin = await requireAdminRoute();
  if (!admin.ok) return admin.response;

  let body: { id?: string; email?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const id = typeof body.id === "string" ? body.id : "";
  const confirmEmail =
    typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!id || !confirmEmail) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  // Demo / mock mode: no real backend and no authenticated admin. The in-memory
  // store has no delete primitive we may touch from here, so report success and
  // let the client's optimistic removal stand for the (ephemeral) session.
  if (!isSupabaseConfigured()) {
    await recordAudit({ actorId: null, action: "account.delete", targetType: "profile", targetId: id });
    return NextResponse.json({ ok: true });
  }

  // (1) Caller is an ACTIVE admin — enforced by requireAdminRoute() above. This
  // route uses the service role (bypasses RLS), so that guard is the only thing
  // stopping a suspended admin; it must stay the first statement of the handler.
  const callerId = admin.userId;
  if (!callerId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // (3) Refuse self-deletion.
  if (id === callerId) {
    return NextResponse.json({ error: "cannot_delete_self" }, { status: 400 });
  }

  // Service role: read the target authoritatively (bypasses RLS) so the email
  // confirmation and last-admin checks can't be spoofed by the caller.
  const svc = createServiceClient();
  const { data: target, error: targetErr } = await svc
    .from("profiles")
    .select("id, email, role")
    .eq("id", id)
    .maybeSingle();
  if (targetErr) {
    return NextResponse.json({ error: "db_error" }, { status: 500 });
  }
  if (!target) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // (2) Typed email confirmation must match the target exactly.
  const targetEmail = (target.email ?? "").trim().toLowerCase();
  if (!targetEmail || targetEmail !== confirmEmail) {
    return NextResponse.json({ error: "email_mismatch" }, { status: 400 });
  }

  // Permanently remove the auth user; FK cascades wipe all tenant data. On a
  // failed delete the shared helper restores an admin target's role (the
  // reservation above demoted it); on success each fan link gets a "this
  // creator has left" tombstone.
  const deleted = await deleteAccountAndTombstoneLinks(svc, id, {
    wasAdmin: target.role === "admin",
    actorId: callerId,
    action: "account.delete",
  });
  if ("error" in deleted) {
    return NextResponse.json({ error: deleted.error }, { status: deleted.error === "last_admin" ? 400 : deleted.error === "forbidden" ? 403 : deleted.error === "not_found" ? 404 : 500 });
  }
  if ("pending" in deleted) return NextResponse.json(deleted, { status: 202, headers: { "Cache-Control": "no-store" } });

  if (!deleted.auditRecorded) await recordAudit({
    actorId: callerId,
    action: "account.delete",
    targetType: "profile",
    targetId: id,
    details: { role: target.role === "admin" ? "admin" : "creator", fanLinks: deleted.links },
  });
  return NextResponse.json({ ok: true });
}
