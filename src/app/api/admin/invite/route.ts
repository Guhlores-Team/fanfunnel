import { NextResponse } from "next/server";
import { inviteCreatorAccount, recordAudit } from "@/lib/data";
import { requireAdminRoute } from "@/lib/auth/admin";
import { displayNameInputError } from "@/lib/profileErrors";
import { BAD_REQUEST, badRequest, errorResponse, parseJsonBody } from "@/lib/api/handler";

const EMAIL = /^[^\s@<>,]+@[^\s@<>,]+\.[^\s@<>,]+$/;

// Admin "New account" (C8): e-mails the creator an invite. The link signs them
// in (/auth/callback, token_hash or PKCE) and ends on /set-password, where they
// choose their own password; the admin never sets or sees one. Admin-only:
// requireAdminRoute (is_admin(), active, aal2) here, and isActiveAdmin again
// in the data layer before the service role is used.
export async function POST(req: Request) {
  const admin = await requireAdminRoute();
  if (!admin.ok) return admin.response;
  const body = await parseJsonBody<{ email?: unknown; displayName?: unknown }>(req);
  if (body === BAD_REQUEST || body === null || typeof body !== "object") return badRequest();
  const email = typeof body.email === "string" ? body.email.trim() : "";
  const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
  if (!EMAIL.test(email) || email.length > 254) return badRequest("invalid_email");
  // The same rules as Settings: fans see this name.
  const nameError = displayName ? displayNameInputError(displayName) : null;
  if (nameError) return badRequest(nameError);

  const redirectTo = `${new URL(req.url).origin}/auth/callback?next=/set-password`;
  const result = await inviteCreatorAccount(email, displayName, redirectTo);
  if ("error" in result) {
    // A taken email conflicts with an existing account: 409, same `{ error }`
    // shape. Every other code keeps statusForError's mapping.
    if (result.error === "email_taken") {
      return NextResponse.json({ error: "email_taken" }, { status: 409 });
    }
    return errorResponse(result.error);
  }
  await recordAudit({
    actorId: admin.userId,
    action: "account.create",
    targetType: "profile",
    targetId: result.id ?? null,
    details: { invited: true },
  });
  return NextResponse.json({ ok: true });
}
