import assert from "node:assert";
import { claimErrorMessage, deleteErrorMessage, inviteErrorMessage } from "./adminErrors";

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

// The data layer forwards Supabase Auth's raw `createUser` message as `error`.
// None of these strings may reach the UI verbatim.
const RAW = [
  "A user with this email address has already been registered",
  "User already registered",
  "Unable to validate email address: invalid format",
  "Password should be at least 6 characters",
  "Database error creating new user",
  "create_failed",
  "bad_request",
  "unauthorized",
  "forbidden",
  "rate_limited",
  "",
  undefined,
  null,
  42,
  { nested: true },
];

// --- inviteErrorMessage ------------------------------------------------------
{
  for (const raw of RAW) {
    const msg = inviteErrorMessage(raw);
    check(`invite: never echoes the raw server string (${String(raw)})`, msg !== raw);
    check(`invite: always a sentence (${String(raw)})`, msg.length > 10 && /[.!]$/.test(msg));
  }
  check(
    "invite: Supabase duplicate-email → friendly",
    inviteErrorMessage("A user with this email address has already been registered") ===
      "An account with that email already exists."
  );
  check(
    "invite: 'User already registered' → friendly",
    inviteErrorMessage("User already registered") === "An account with that email already exists."
  );
  check(
    "invite: invalid email format → friendly",
    inviteErrorMessage("Unable to validate email address: invalid format") ===
      "That email address doesn't look right."
  );
  check(
    "invite: password policy → states the rule",
    inviteErrorMessage("Password should be at least 6 characters") ===
      "Password needs 8+ characters with a letter and a number."
  );
  check("invite: unauthorized → Admins only.", inviteErrorMessage("unauthorized") === "Admins only.");
  check("invite: forbidden → Admins only.", inviteErrorMessage("forbidden") === "Admins only.");
  check(
    "invite: rate_limited → wait copy",
    inviteErrorMessage("rate_limited") === "Too many attempts — wait a moment and try again."
  );
  check(
    "invite: unknown DB error → generic",
    inviteErrorMessage("Database error creating new user") === "Couldn't create account. Try again."
  );
  check(
    "invite: non-string → generic",
    inviteErrorMessage(undefined) === "Couldn't create account. Try again." &&
      inviteErrorMessage({ nested: true }) === "Couldn't create account. Try again."
  );
  check(
    "invite: case-insensitive match",
    inviteErrorMessage("EMAIL_EXISTS") === "An account with that email already exists."
  );
}

// --- deleteErrorMessage ------------------------------------------------------
{
  check("delete: self", deleteErrorMessage("cannot_delete_self") === "You can't delete your own admin account.");
  check("delete: last admin", deleteErrorMessage("last_admin") === "Can't delete the last remaining admin.");
  check("delete: mismatch", deleteErrorMessage("email_mismatch") === "Email didn't match — deletion cancelled.");
  check("delete: unauthorized", deleteErrorMessage("unauthorized") === "Admins only.");
  check("delete: forbidden", deleteErrorMessage("forbidden") === "Admins only.");
  check("delete: unknown → generic", deleteErrorMessage("db_error") === "Couldn't delete account. Try again.");
  check("delete: undefined → generic", deleteErrorMessage(undefined) === "Couldn't delete account. Try again.");
}

// --- claimErrorMessage -------------------------------------------------------
{
  check("claim: not_allowed", claimErrorMessage("not_allowed") === "Your email isn't on the admin allowlist.");
  check(
    "claim: not_configured",
    claimErrorMessage("not_configured") === "Admin allowlist (ADMIN_EMAILS) isn't set on the server yet."
  );
  check(
    "claim: already_bootstrapped",
    claimErrorMessage("already_bootstrapped") === "An admin already exists — ask them to grant you access."
  );
  check("claim: unknown → generic", claimErrorMessage("boom") === "Couldn't claim admin. Try again.");
}

console.log(`adminErrors: ${passed} checks passed`);
