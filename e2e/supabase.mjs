// Real-Supabase integration tests — the security-critical coverage the
// mock-mode suite CANNOT exercise: Row-Level-Security tenant isolation and the
// SECURITY DEFINER self-update RPCs (set_chat_settings / set_leaderboard_enabled
// / set_onboarding_dismissed — the class of the prod-only chat-settings bug).
//
// Headless (no browser): it creates two ephemeral creator accounts via the
// admin API, signs them in, and asserts that creator A cannot read/update/
// delete creator B's data — and that the self-update RPCs only ever touch the
// caller's own profile. Cleans up both users (cascades their rows) at the end.
//
// SKIPS cleanly (exit 0) when Supabase env vars are absent, so it's safe to run
// anywhere; the secrets-gated CI job provides them. NOTE: this path is only
// meaningful against a real project whose schema.sql (incl. migration 0023) has
// been applied.

import { createClient } from "@supabase/supabase-js";
import { writeSync } from "node:fs";

const log = (s = "") => writeSync(1, s + "\n");

// Trim whitespace/newlines (mobile copy-paste often appends them).
const clean = (v) => (v || "").trim();
const RAW_URL = clean(process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL);
const ANON = clean(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
const SERVICE = clean(process.env.SUPABASE_SERVICE_ROLE_KEY);

if (!RAW_URL || !ANON || !SERVICE) {
  log(
    "⏭  Supabase integration tests skipped — set NEXT_PUBLIC_SUPABASE_URL, " +
      "NEXT_PUBLIC_SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY to run them."
  );
  process.exit(0);
}

// Normalize the URL to its origin so a stray trailing slash or path can't
// break admin endpoint paths. Validate by parsing (forgiving) and emit precise,
// NON-SECRET diagnostics so a misconfigured secret is obvious without leaking it.
let URL = RAW_URL;
{
  const startsWithHttps = /^https:\/\//i.test(RAW_URL);
  let parsed = null;
  try {
    parsed = new globalThis.URL(RAW_URL);
  } catch {
    /* not a URL */
  }
  const host = parsed?.hostname ?? "";
  const hostIsSupabase = /\.supabase\.(co|in|net|io)$/i.test(host);
  const looksLikeJwt = RAW_URL.startsWith("eyJ");
  const looksLikeDashboard = /supabase\.com/i.test(RAW_URL) || /\/dashboard\/|\/project\//.test(RAW_URL);

  if (parsed && hostIsSupabase) {
    URL = parsed.origin; // drop any path/slash; e.g. https://<ref>.supabase.co
  } else {
    log("❌ NEXT_PUBLIC_SUPABASE_URL is not a valid Supabase project API URL.");
    log("   It must be EXACTLY:  https://<your-project-ref>.supabase.co");
    log("   Find it in Supabase → Settings → API → 'Project URL' (or 'Data API').");
    log("   Common mistakes: missing https://, just the project ref, the browser");
    log("   dashboard URL, a connection string, or the wrong value in this secret.");
    log(
      `   diagnostics (no secret shown) → length=${RAW_URL.length} ` +
        `startsWithHttps=${startsWithHttps} parsesAsUrl=${!!parsed} ` +
        `hostIsSupabase=${hostIsSupabase} looksLikeJwtKey=${looksLikeJwt} ` +
        `looksLikeDashboard=${looksLikeDashboard}`
    );
    process.exit(1);
  }

  if (!ANON.startsWith("eyJ"))
    log("⚠  NEXT_PUBLIC_SUPABASE_ANON_KEY doesn't start with 'eyJ' — use the Legacy 'anon public' key.");
  if (!SERVICE.startsWith("eyJ"))
    log("⚠  SUPABASE_SERVICE_ROLE_KEY doesn't start with 'eyJ' — use the Legacy 'service_role secret' key.");
}

// ---- tiny assert/report (self-contained; no playwright import) -------------
const results = [];
let failures = 0;
async function step(name, fn) {
  try {
    await fn();
    results.push([true, name, ""]);
  } catch (e) {
    failures++;
    results.push([false, name, String(e?.message || e).slice(0, 200)]);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error("assertion failed: " + msg);
}

const admin = createClient(URL, SERVICE, { auth: { persistSession: false } });
const rand = Math.random().toString(36).slice(2, 8);
const users = []; // { id, email, password, client }

async function makeCreator(tag) {
  const email = `e2e-${tag}-${rand}@fanfunnel.test`;
  const password = "Test-" + Math.random().toString(36).slice(2) + "-Aa1!";
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error) throw new Error(`createUser(${tag}): ${error.message}`);
  const id = data.user.id;

  // handle_new_user runs in the same txn as the auth insert, but poll briefly
  // in case of replication lag before asserting the profile exists.
  let role = null;
  for (let i = 0; i < 10; i++) {
    const { data: prof } = await admin
      .from("profiles")
      .select("id, role")
      .eq("id", id)
      .maybeSingle();
    if (prof) {
      role = prof.role;
      break;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  if (!role) throw new Error(`profile row for ${tag} was never created`);

  const client = createClient(URL, ANON, { auth: { persistSession: false } });
  const { error: signInErr } = await client.auth.signInWithPassword({ email, password });
  if (signInErr) throw new Error(`signIn(${tag}): ${signInErr.message}`);

  const rec = { id, email, password, client, role };
  users.push(rec);
  return rec;
}

async function cleanup() {
  for (const u of users) {
    try {
      await admin.auth.admin.deleteUser(u.id); // cascades profile + owned rows
    } catch {
      /* best effort */
    }
  }
}

let exitCode = 1;
try {
  log(`Supabase integration tests → ${URL}`);

  let A, B, wheelId;

  await step("create two creator accounts (handle_new_user → profiles)", async () => {
    A = await makeCreator("a");
    B = await makeCreator("b");
    assert(A.role === "creator" && B.role === "creator", `both are creators (got ${A?.role}/${B?.role})`);
  });

  await step("creator A can insert its own wheel (RLS write)", async () => {
    const { data, error } = await A.client
      .from("wheels")
      .insert({ creator_id: A.id, title: "A's secret wheel", brand_color: "#ec4899" })
      .select("id, title")
      .single();
    assert(!error, `insert failed: ${error?.message}`);
    wheelId = data.id;
    assert(data.title === "A's secret wheel", "wheel created with expected title");
  });

  await step("creator B CANNOT read A's wheel (RLS select isolation)", async () => {
    const { data } = await B.client.from("wheels").select("id, title").eq("id", wheelId);
    assert(Array.isArray(data) && data.length === 0, `B saw ${data?.length ?? "?"} of A's wheels (must be 0)`);
  });

  await step("creator B CANNOT update A's wheel (RLS write isolation)", async () => {
    const { data } = await B.client
      .from("wheels")
      .update({ title: "hacked by B" })
      .eq("id", wheelId)
      .select("id");
    assert((data?.length ?? 0) === 0, "B's update affected 0 rows");
    // Confirm A's title is untouched.
    const { data: a } = await A.client.from("wheels").select("title").eq("id", wheelId).single();
    assert(a.title === "A's secret wheel", "A's wheel title unchanged after B's attempt");
  });

  await step("creator B CANNOT delete A's wheel (RLS delete isolation)", async () => {
    const { data } = await B.client.from("wheels").delete().eq("id", wheelId).select("id");
    assert((data?.length ?? 0) === 0, "B's delete affected 0 rows");
    const { data: a } = await A.client.from("wheels").select("id").eq("id", wheelId);
    assert((a?.length ?? 0) === 1, "A's wheel still exists");
  });

  await step("creator B CANNOT read A's profile row (RLS)", async () => {
    const { data } = await B.client.from("profiles").select("id").eq("id", A.id);
    assert((data?.length ?? 0) === 0, "B cannot see A's profile");
  });

  await step("set_chat_settings RPC persists for the caller (prod-bug regression)", async () => {
    const { error } = await A.client.rpc("set_chat_settings", {
      p_intro: "Welcome, spin away!",
      p_outro: "Out of spins — tip for more 💖",
    });
    assert(!error, `rpc failed: ${error?.message}`);
    const { data } = await A.client
      .from("profiles")
      .select("chat_intro, chat_outro")
      .eq("id", A.id)
      .single();
    assert(data.chat_intro === "Welcome, spin away!", "chat_intro persisted");
    assert(/Out of spins/.test(data.chat_outro), "chat_outro persisted");
  });

  await step("set_leaderboard_enabled RPC is scoped to the caller", async () => {
    const { error } = await A.client.rpc("set_leaderboard_enabled", { p_enabled: true });
    assert(!error, `rpc failed: ${error?.message}`);
    const { data: a } = await A.client.from("profiles").select("leaderboard_enabled").eq("id", A.id).single();
    assert(a.leaderboard_enabled === true, "A's leaderboard flag turned on");
    const { data: b } = await B.client.from("profiles").select("leaderboard_enabled").eq("id", B.id).single();
    assert(b.leaderboard_enabled === false, "B's leaderboard flag is unaffected by A's RPC");
  });

  await step("set_onboarding_dismissed RPC is scoped to the caller", async () => {
    const { error } = await A.client.rpc("set_onboarding_dismissed", { p_dismissed: true });
    assert(!error, `rpc failed: ${error?.message}`);
    const { data: a } = await A.client.from("profiles").select("onboarding_dismissed").eq("id", A.id).single();
    assert(a.onboarding_dismissed === true, "A's onboarding flag set");
    const { data: b } = await B.client.from("profiles").select("onboarding_dismissed").eq("id", B.id).single();
    assert(b.onboarding_dismissed === false, "B's onboarding flag is unaffected");
  });

  await step("creator A cannot self-promote to admin (profiles_update is admin-only)", async () => {
    const { data } = await A.client.from("profiles").update({ role: "admin" }).eq("id", A.id).select("id");
    assert((data?.length ?? 0) === 0, "direct role update is blocked by RLS");
    const { data: a } = await A.client.from("profiles").select("role").eq("id", A.id).single();
    assert(a.role === "creator", "A is still a creator");
  });

  // ---- report ----
  const lines = ["\n================ SUPABASE INTEGRATION ================"];
  for (const [ok, name, note] of results)
    lines.push(`  ${ok ? "✓" : "✗"} ${name}${note ? "  — " + note : ""}`);
  const passed = results.filter((r) => r[0]).length;
  lines.push(`\nRESULT: ${passed}/${results.length} checks passed`);
  const ok = failures === 0;
  lines.push(ok ? "\n✅ SUPABASE INTEGRATION PASSED" : "\n❌ SUPABASE INTEGRATION FAILED");
  log(lines.join("\n"));
  exitCode = ok ? 0 : 1;
} catch (e) {
  log("Supabase integration harness error: " + (e?.stack || e));
  exitCode = 1;
} finally {
  await cleanup();
  process.exit(exitCode);
}
