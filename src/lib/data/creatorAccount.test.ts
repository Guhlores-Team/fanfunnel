import assert from "node:assert";
import { inviteCreatorUser, type CreatorProvisioningClient } from "./creatorAccount";

// C8: "New account" invites by e-mail (inviteUserByEmail) and never takes a
// password. Regression kept: a failed invite never forwards Supabase Auth's raw
// message (which can echo the submitted email) as the API `error` string; the
// client gets a stable code, the raw detail goes to the server log only.

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

type FakeAuthError = { message: string; code?: string; status?: number };

/** A fake service client: `inviteUserByEmail` resolves to the given result;
 *  profile updates are recorded. */
function fakeClient(result: { user: { id: string } | null; error: FakeAuthError | null }) {
  const updates: Record<string, unknown>[] = [];
  const created: Record<string, unknown>[] = [];
  const client = {
    auth: {
      admin: {
        inviteUserByEmail: async (email: string, options: Record<string, unknown>) => {
          created.push({ email, ...options });
          return { data: { user: result.user }, error: result.error };
        },
      },
    },
    from: () => ({
      update: (row: Record<string, unknown>) => {
        updates.push(row);
        return { eq: async () => ({ error: null }) };
      },
    }),
  };
  return { client: client as unknown as CreatorProvisioningClient, updates, created };
}

/** Run with console.error captured, so the test can assert what reached the log. */
async function withLoggedErrors<T>(fn: () => Promise<T>): Promise<{ result: T; logged: string }> {
  const original = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => {
    lines.push(
      args.map((a) => (a && typeof a === "object" ? Object.values(a).join(" ") : String(a))).join(" ")
    );
  };
  try {
    return { result: await fn(), logged: lines.join("\n") };
  } finally {
    console.error = original;
  }
}

const EMAIL = "taken@example.com";
const REDIRECT = "https://app.example/auth/callback?next=/set-password";

async function expectCode(label: string, error: FakeAuthError | null, expected: string) {
  const { client, updates } = fakeClient({ user: null, error });
  const { result, logged } = await withLoggedErrors(() =>
    inviteCreatorUser(client, EMAIL, "Taken", REDIRECT)
  );
  check(`${label}: returns { error: "${expected}" }`, "error" in result && result.error === expected);
  if (error) {
    check(`${label}: raw message is NOT in the result`, !JSON.stringify(result).includes(error.message));
    check(`${label}: raw message IS logged server-side`, logged.includes(error.message));
  }
  check(`${label}: no profile update on failure`, updates.length === 0);
}

async function main() {
  // Duplicate email — by Supabase error code and by message alone.
  await expectCode(
    "email_exists code",
    { code: "email_exists", status: 422, message: "A user with this email address has already been registered" },
    "email_taken"
  );
  await expectCode(
    "user_already_exists code",
    { code: "user_already_exists", status: 422, message: "User already registered" },
    "email_taken"
  );
  await expectCode(
    "already-registered message without a code",
    { status: 422, message: "A user with this email address has already been registered" },
    "email_taken"
  );

  // Weak password.
  await expectCode(
    "weak_password code",
    { code: "weak_password", status: 422, message: "Password should be at least 6 characters." },
    "weak_password"
  );
  await expectCode(
    "password message without a code",
    { status: 422, message: "Password should contain at least one character of each: abc, 123" },
    "weak_password"
  );

  // Invalid email (the raw message echoes the submitted address).
  await expectCode(
    "email_address_invalid code",
    { code: "email_address_invalid", status: 400, message: `Email address "${EMAIL}" is invalid` },
    "invalid_email"
  );
  await expectCode(
    "validate-email message without a code",
    { status: 400, message: "Unable to validate email address: invalid format" },
    "invalid_email"
  );

  // Anything else, and a "success" with no user, collapse to create_failed.
  await expectCode(
    "unexpected_failure code",
    { code: "unexpected_failure", status: 500, message: "Database error creating new user" },
    "create_failed"
  );
  await expectCode("no error but no user", null, "create_failed");

  await expectCode(
    "e-mail rate limit",
    { code: "over_email_send_rate_limit", status: 429, message: "email rate limit exceeded" },
    "rate_limited"
  );

  // Success: ok, the invite goes out with the set-password redirect, and the
  // profile row is approved; no password anywhere.
  {
    const { client, updates, created } = fakeClient({ user: { id: "u1" }, error: null });
    const result = await inviteCreatorUser(client, EMAIL, "", REDIRECT);
    check("success returns { ok: true }", "ok" in result && result.ok === true);
    check("one invite e-mail to that address, ending on /set-password", created.length === 1 && created[0].email === EMAIL && created[0].redirectTo === REDIRECT);
    check("no password is set or sent", !created.some((c) => "password" in c));
    check("the profile is approved", updates.length === 1 && updates[0].approval_status === "approved");
    // M1 negative: the e-mail never becomes the (public) display name.
    check("a missing display name is never written (stays empty)", !updates.some((u) => "display_name" in u));
    check("no e-mail is written as the display name anywhere", !JSON.stringify([updates, created]).includes(`"display_name":"${EMAIL}"`));
    check("the auth user gets no display-name metadata at all", !("data" in created[0]));
  }
  {
    const { client, updates, created } = fakeClient({ user: { id: "u2" }, error: null });
    await inviteCreatorUser(client, EMAIL, "  Bella  ", REDIRECT);
    check("a given display name is stored trimmed", updates.some((u) => u.display_name === "Bella"));
    check("…and on the invite's metadata", (created[0].data as { display_name?: string }).display_name === "Bella");
    check("the approval is its own write (a refused name cannot undo it)", updates[0].approval_status === "approved" && !("display_name" in updates[0]));
  }
  {
    const { client, updates } = fakeClient({ user: { id: "u3" }, error: null });
    await inviteCreatorUser(client, EMAIL, "someone@example.com", REDIRECT);
    check("an e-mail-shaped display name is dropped", !updates.some((u) => "display_name" in u));
  }

  console.log(`creatorAccount.test: ${passed} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
