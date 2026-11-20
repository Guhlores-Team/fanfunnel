import type { SupabaseClient } from "@supabase/supabase-js";
import { displayNameInputError } from "@/lib/profileErrors";

/** The slice of the service-role client that creator provisioning uses. The
 *  caller passes `createServiceClient()`, after its own `requireAdmin` check. */
export type CreatorProvisioningClient = Pick<SupabaseClient, "auth" | "from">;

/** Stable `error` codes `POST /api/admin/invite` returns for a failed invite. */
export type CreateUserErrorCode = "email_taken" | "weak_password" | "invalid_email" | "rate_limited" | "create_failed";

/** Map a Supabase Auth create/invite error to a stable code. Prefers the
 *  error's `code`; falls back to the message for older Auth servers that omit it. */
export function createUserErrorCode(
  err: { code?: string; message?: string } | null | undefined
): CreateUserErrorCode {
  if (!err) return "create_failed";
  const code = err.code ?? "";
  const msg = (err.message ?? "").toLowerCase();
  if (
    code === "email_exists" ||
    code === "user_already_exists" ||
    /already (been )?registered|already exists/.test(msg)
  ) {
    return "email_taken";
  }
  if (code === "over_email_send_rate_limit" || code === "over_request_rate_limit" || /rate limit/.test(msg)) {
    return "rate_limited";
  }
  if (code === "weak_password" || msg.includes("password")) return "weak_password";
  if (
    code === "email_address_invalid" ||
    (msg.includes("email") && /invalid|validate/.test(msg))
  ) {
    return "invalid_email";
  }
  return "create_failed";
}

/**
 * C8: an admin's "New account" e-mails the creator an invite (Supabase Auth's
 * invite, branded by supabase/templates/invite.html) instead of the admin
 * choosing a password to pass on. The link signs them in through
 * /auth/callback and lands on /set-password, where they choose their own.
 * The account is approved straight away: an admin made it.
 */
export async function inviteCreatorUser(
  svc: CreatorProvisioningClient,
  email: string,
  displayName: string,
  redirectTo: string
): Promise<{ ok: true; id: string } | { error: CreateUserErrorCode }> {
  // M1: a missing display name stays empty, never the e-mail: the name is
  // shown on the creator's public pages. One the profile rules refuse is
  // dropped too (the creator sets it in Settings).
  const trimmed = displayName.trim();
  const name = trimmed && !displayNameInputError(trimmed) ? trimmed : null;
  const { data, error } = await svc.auth.admin.inviteUserByEmail(email, {
    redirectTo,
    ...(name ? { data: { display_name: name } } : {}),
  });
  if (error || !data.user) {
    // Raw Auth wording stays in the server log; the client gets a stable code.
    console.error("admin invite: inviteUserByEmail failed", {
      code: error?.code,
      status: error?.status,
      message: error?.message ?? "no user returned",
    });
    return { error: createUserErrorCode(error) };
  }

  const { error: approveError } = await svc
    .from("profiles")
    .update({ approval_status: "approved" })
    .eq("id", data.user.id);
  if (approveError) console.error("admin invite: approving the profile failed", approveError.code ?? "error");
  if (name) {
    // Separate write: a name the database refuses (it also rejects one that
    // contains the account's e-mail) must not undo the approval.
    const { error: nameError } = await svc.from("profiles").update({ display_name: name }).eq("id", data.user.id);
    if (nameError) console.error("admin invite: setting the display name failed", nameError.code ?? "error");
  }
  return { ok: true, id: data.user.id };
}
