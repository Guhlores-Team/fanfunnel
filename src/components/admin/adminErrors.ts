// Server → user copy for the admin console. Every mapper takes the raw `error`
// field from an API response (unknown shape) and returns a friendly sentence,
// so no server or Supabase wording ever reaches the UI.

/** `POST /api/admin/invite` — the data layer forwards Supabase Auth's own
 *  message for a failed `createUser`, so this matches on the few messages that
 *  carry meaning for the admin and falls back to a generic sentence. */
export function inviteErrorMessage(err: unknown): string {
  const raw = typeof err === "string" ? err.trim() : "";
  const code = raw.toLowerCase();
  if (code === "unauthorized" || code === "forbidden") return "Admins only.";
  if (code === "rate_limited") return "Too many attempts — wait a moment and try again.";
  if (code === "bad_request" || code === "create_failed") return "Couldn't create account. Try again.";
  if (code.includes("already") || code.includes("exists") || code.includes("registered")) {
    return "An account with that email already exists.";
  }
  if (code.includes("email") && (code.includes("invalid") || code.includes("validate"))) {
    return "That email address doesn't look right.";
  }
  if (code.includes("password")) {
    return "Password needs 8+ characters with a letter and a number.";
  }
  return "Couldn't create account. Try again.";
}

/** `POST /api/admin/account/delete` — the server owns the self / last-admin /
 *  typed-email guards; we only translate its codes. */
export function deleteErrorMessage(err: unknown): string {
  switch (err) {
    case "cannot_delete_self":
      return "You can't delete your own admin account.";
    case "last_admin":
      return "Can't delete the last remaining admin.";
    case "email_mismatch":
      return "Email didn't match — deletion cancelled.";
    case "unauthorized":
    case "forbidden":
      return "Admins only.";
    default:
      return "Couldn't delete account. Try again.";
  }
}

/** `POST /api/admin/claim` — the env-allowlisted one-time bootstrap. */
export function claimErrorMessage(err: unknown): string {
  switch (err) {
    case "not_allowed":
      return "Your email isn't on the admin allowlist.";
    case "not_configured":
      return "Admin allowlist (ADMIN_EMAILS) isn't set on the server yet.";
    case "already_bootstrapped":
      return "An admin already exists — ask them to grant you access.";
    default:
      return "Couldn't claim admin. Try again.";
  }
}
