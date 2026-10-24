import assert from "node:assert";
import { provisionCreatorUser, type CreatorProvisioningClient } from "./creatorAccount";

// Regression: a failed admin invite used to forward Supabase Auth's raw
// `createUser` message as the API `error` string. The client got Supabase's own
// wording (which can echo the submitted email) instead of a stable code it can
// map to copy. Raw detail now goes to the server log only.

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

type FakeAuthError = { message: string; code?: string; status?: number };

/** A fake service client: `createUser` resolves to the given result; profile
 *  updates are recorded. */
function fakeClient(result: { user: { id: string } | null; error: FakeAuthError | null }) {
  const updates: Record<string, unknown>[] = [];
  const client = {
    auth: {
      admin: {
        createUser: async () => ({ data: { user: result.user }, error: result.error }),
      },
    },
    from: () => ({
      update: (row: Record<string, unknown>) => {
        updates.push(row);
        return { eq: async () => ({ error: null }) };
      },
    }),
  };
  return { client: client as unknown as CreatorProvisioningClient, updates };
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

async function expectCode(label: string, error: FakeAuthError | null, expected: string) {
  const { client, updates } = fakeClient({ user: null, error });
  const { result, logged } = await withLoggedErrors(() =>
    provisionCreatorUser(client, EMAIL, "abc12345", "Taken")
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

  // Success: ok, and the profile row is approved with the display name.
  {
    const { client, updates } = fakeClient({ user: { id: "u1" }, error: null });
    const result = await provisionCreatorUser(client, EMAIL, "abc12345", "");
    check("success returns { ok: true }", "ok" in result && result.ok === true);
    check(
      "success approves the profile, display name falls back to email",
      updates.length === 1 && updates[0].approval_status === "approved" && updates[0].display_name === EMAIL
    );
  }

  console.log(`creatorAccount.test: ${passed} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
