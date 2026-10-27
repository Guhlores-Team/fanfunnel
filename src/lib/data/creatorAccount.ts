import type { SupabaseClient } from "@supabase/supabase-js";

/** The slice of the service-role client that creator provisioning uses. The
 *  caller passes `createServiceClient()`, after its own `requireAdmin` check. */
export type CreatorProvisioningClient = Pick<SupabaseClient, "auth" | "from">;

/** Stable `error` codes `POST /api/admin/invite` returns for a failed create. */
export type CreateUserErrorCode = "email_taken" | "weak_password" | "invalid_email" | "create_failed";

/** Map a Supabase Auth `createUser` error to a stable code. Prefers the error's
 *  `code`; falls back to the message for older Auth servers that omit it. */
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
  if (code === "weak_password" || msg.includes("password")) return "weak_password";
  if (
    code === "email_address_invalid" ||
    (msg.includes("email") && /invalid|validate/.test(msg))
  ) {
    return "invalid_email";
  }
  return "create_failed";
}

export async function provisionCreatorUser(
  svc: CreatorProvisioningClient,
  email: string,
  password: string,
  displayName: string
): Promise<{ ok: true; id: string } | { error: CreateUserErrorCode }> {
  const { data, error } = await svc.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { display_name: displayName || email },
  });
  if (error || !data.user) {
    // Raw Auth wording stays in the server log; the client gets a stable code.
    console.error("admin invite: createUser failed", {
      code: error?.code,
      status: error?.status,
      message: error?.message ?? "no user returned",
    });
    return { error: createUserErrorCode(error) };
  }

  await svc
    .from("profiles")
    .update({ display_name: displayName || email, approval_status: "approved" })
    .eq("id", data.user.id);
  return { ok: true, id: data.user.id };
}
