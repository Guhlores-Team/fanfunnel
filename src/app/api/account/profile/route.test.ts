import assert from "node:assert";
import { mock } from "node:test";

// 0071 (L2, M1): set_display_name and set_public_profile raise SQLSTATE 22023
// for a value they refuse (an e-mail as the name, a bad length, a bad slug,
// tagline or tip link), and a taken slug is 23505. The routes answer a 4xx
// with a stable code and never the database's own text; anything else stays
// the generic db_error. The Settings UI turns each code into a clear message.

const calls: { name: string; args: Record<string, unknown> }[] = [];
let answer: { data: unknown; error: unknown } = { data: null, error: null };
const revalidated: string[] = [];

mock.module("@/lib/supabase/server", { namedExports: {
  isSupabaseConfigured: () => true,
  createClient: async () => {
    const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: { public_slug: "demo-creator" }, error: null }) };
    return {
      auth: { getUser: async () => ({ data: { user: { id: "u", email: "me@example.com" } }, error: null }) },
      rpc: async (name: string, args: Record<string, unknown>) => { calls.push({ name, args }); return answer; },
      from: () => q,
    };
  },
  createServiceClient: () => { throw new Error("profile edits never use the service role"); },
} });
mock.module("@/lib/api/limit", { namedExports: { rateLimitOr429: async () => null, limitRoute: async () => null } });
mock.module("next/cache", { namedExports: { revalidatePath: (p: string) => { revalidated.push(p); } } });

let checks = 0;
const check = (label: string, condition: unknown) => { assert.ok(condition, label); checks++; };
const put = (url: string, body: unknown) => new Request(`http://localhost${url}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const RAW = /exception|violates|SQLSTATE|e-mail address$|invalid display name|invalid slug|invalid tagline/;

async function main() {
  const profile = await import("./route");
  const publicProfile = await import("@/app/api/public-profile/route");
  const msg = await import("@/lib/account/profileErrors");

  // --- display name: the route's own check (demo parity) --------------------
  for (const [label, name, code] of [
    ["an e-mail address", "fan.me@example.com", "name_looks_like_email"],
    ["an e-mail with spaces around it", "  someone@x.io ", "name_looks_like_email"],
    ["a control character", "Demo\u0007Creator", "invalid_display_name"],
    ["81 characters", "x".repeat(81), "name_too_long"],
    ["a blank name", "   ", "name_required"],
  ] as const) {
    calls.length = 0;
    const res = await profile.PUT(put("/api/account/profile", { displayName: name }));
    const body = await res.json();
    check(`display name, ${label}: 400 ${code}`, res.status === 400 && body.error === code);
    check(`display name, ${label}: never reaches set_display_name`, calls.length === 0);
  }

  // --- display name: the database's 0071 refusals --------------------------
  calls.length = 0;
  revalidated.length = 0;
  answer = { data: null, error: { code: "22023", message: "display name looks like an e-mail address" } };
  // Contains the account's own address without being e-mail shaped: only SQL knows.
  let res = await profile.PUT(put("/api/account/profile", { displayName: "Demo (me@example.com) Creator" }));
  let body = await res.json();
  check("22023 'looks like an e-mail' is a 400 name_looks_like_email, not a 500", res.status === 400 && body.error === "name_looks_like_email");
  check("…sent through set_display_name with the trimmed name", calls.length === 1 && calls[0].name === "set_display_name");
  check("…and the public page is not revalidated after a refusal", revalidated.length === 0);
  check("…and the database's text is not in the response", !RAW.test(JSON.stringify(body)));

  answer = { data: null, error: { code: "22023", message: "invalid display name" } };
  res = await profile.PUT(put("/api/account/profile", { displayName: "Demo Creator" }));
  body = await res.json();
  check("22023 'invalid display name' is a 400 invalid_display_name", res.status === 400 && body.error === "invalid_display_name" && !RAW.test(JSON.stringify(body)));

  answer = { data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } };
  res = await profile.PUT(put("/api/account/profile", { displayName: "Demo Creator" }));
  body = await res.json();
  check("any other database error stays the generic db_error, with no raw text", body.error === "db_error" && !/statement/.test(JSON.stringify(body)));

  answer = { data: null, error: null };
  res = await profile.PUT(put("/api/account/profile", { displayName: "  Demo Creator  " }));
  body = await res.json();
  check("a valid name saves (200) and revalidates the public page", res.status === 200 && body.displayName === "Demo Creator" && revalidated.includes("/c/demo-creator"));

  // --- public profile: slug, tagline, tip link (0071 L2) -------------------
  for (const [label, error, code, status] of [
    ["22023 invalid slug", { code: "22023", message: "invalid slug" }, "invalid_slug", 400],
    ["22023 invalid tagline", { code: "22023", message: "invalid tagline" }, "invalid_tagline", 400],
    ["22023 invalid tip url", { code: "22023", message: "invalid tip url" }, "invalid_tip_url", 400],
    ["22023 from an unknown check", { code: "22023", message: "something new" }, "invalid_profile", 400],
    ["23505 slug taken", { code: "23505", message: "duplicate key value violates unique constraint \"profiles_public_slug_key\"" }, "slug_taken", 409],
    ["another error", { code: "XX000", message: "internal error" }, "db_error", 400],
  ] as const) {
    answer = { data: null, error };
    calls.length = 0;
    revalidated.length = 0;
    const r = await publicProfile.PUT(put("/api/public-profile", { slug: "Demo Creator", tagline: "Spin me" }));
    const b = await r.json();
    check(`public profile, ${label}: ${status} ${code}`, r.status === status && b.error === code);
    check(`public profile, ${label}: reached set_public_profile`, calls.some((c) => c.name === "set_public_profile"));
    check(`public profile, ${label}: no database text, no revalidation`, !RAW.test(JSON.stringify(b)) && !/duplicate key|internal error/.test(JSON.stringify(b)) && revalidated.length === 0);
  }

  // --- what the Settings UI says ------------------------------------------
  for (const code of ["name_required", "name_too_long", "name_looks_like_email", "invalid_display_name", "rate_limited"]) {
    check(`the Profile card has its own message for ${code}`, msg.displayNameErrorMessage(code) !== msg.displayNameErrorMessage("db_error"));
  }
  check("the e-mail message says why", /e-mail/.test(msg.displayNameErrorMessage("name_looks_like_email")));
  for (const code of ["invalid_slug", "slug_taken", "invalid_tip_url", "invalid_tagline", "invalid_note", "rate_limited"]) {
    check(`the Public page card has its own message for ${code}`, msg.publicProfileErrorMessage(code) !== msg.publicProfileErrorMessage("db_error"));
  }
  check("an unknown code gets the generic message, never the code itself", msg.displayNameErrorMessage("<script>") === msg.displayNameErrorMessage("db_error") && msg.publicProfileErrorMessage(undefined) === msg.publicProfileErrorMessage("db_error"));
  check("looksLikeEmail matches the SQL shape", msg.looksLikeEmail(" a@b.co ") && !msg.looksLikeEmail("a @b.co") && !msg.looksLikeEmail("@handle") && !msg.looksLikeEmail("Demo Creator"));

  // The UI reads the code from the response instead of one fixed line.
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const panel = readFileSync(join(import.meta.dirname, "../../../../components/dashboard/SettingsPanel.tsx"), "utf8");
  check("the Profile card shows displayNameErrorMessage(code)", /toast\(displayNameErrorMessage\(/.test(panel) && !/Couldn't save your name\.", \{ tone/.test(panel));
  check("the Public page card shows publicProfileErrorMessage(code)", /toast\(publicProfileErrorMessage\(/.test(panel));

  console.log(`account profile errors: ${checks} checks passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
