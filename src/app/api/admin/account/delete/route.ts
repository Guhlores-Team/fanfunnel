import { NextResponse } from "next/server";
import {
  isSupabaseConfigured,
  createClient,
  createServiceClient,
} from "@/lib/supabase/server";

/**
 * Hard-delete a creator account and ALL of its tenant data — irreversible.
 *
 * This is deliberately separate from the reversible "suspend" action in
 * `../route.ts`. It is guarded several ways (defense in depth):
 *   1. Caller must be an ACTIVE admin (verified server-side against
 *      `profiles.role` AND `profiles.is_active` — a suspended admin is rejected).
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
    return NextResponse.json({ ok: true });
  }

  // (1) Caller must be a signed-in admin.
  const sb = await createClient();
  const {
    data: { user: caller },
  } = await sb.auth.getUser();
  if (!caller) {
    return NextResponse.json({ error: "unauthorized" }, { status: 403 });
  }
  const { data: callerProfile } = await sb
    .from("profiles")
    .select("role, is_active")
    .eq("id", caller.id)
    .maybeSingle();
  // A suspended admin (is_active=false) loses destructive power, mirroring the
  // DB is_admin() policy. This route uses the service role (bypasses RLS), so the
  // active-state check must be enforced here in code, not just at the RLS layer.
  if (callerProfile?.role !== "admin" || callerProfile?.is_active !== true) {
    return NextResponse.json({ error: "unauthorized" }, { status: 403 });
  }

  // (3) Refuse self-deletion.
  if (id === caller.id) {
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

  // (4) Atomically guard the last-admin invariant + RESERVE the deletion. The
  // plain JS count above is TOCTOU (two concurrent deletes of the final two
  // admins could both pass and leave zero admins). This SECURITY DEFINER RPC
  // locks the admin rows and, for an admin target, refuses if it is the last
  // admin or demotes it as an atomic reservation so a concurrent call sees one
  // fewer admin. Runs as the caller (auth client) — auth.uid() is the admin.
  const { data: reserve, error: reserveErr } = await sb.rpc(
    "admin_reserve_account_deletion",
    { p_target: id }
  );
  if (reserveErr) {
    return NextResponse.json({ error: "db_error" }, { status: 500 });
  }
  if (reserve === "last_admin") {
    return NextResponse.json({ error: "last_admin" }, { status: 400 });
  }
  if (reserve !== "ok") {
    // forbidden / not_found / cannot_delete_self — already checked above; fail
    // closed on any unexpected status rather than deleting.
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  // Permanently remove the auth user; FK cascades wipe all tenant data.
  const { error: delErr } = await svc.auth.admin.deleteUser(id);
  if (delErr) {
    // The reservation above demoted an admin target (admin -> creator) to hold
    // the last-admin invariant atomically. The delete failed, so compensate by
    // restoring the role — otherwise the target is left permanently altered (and
    // the admin count reduced) without ever being deleted.
    if (target.role === "admin") {
      await svc.from("profiles").update({ role: "admin" }).eq("id", id);
    }
    return NextResponse.json({ error: "delete_failed" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
