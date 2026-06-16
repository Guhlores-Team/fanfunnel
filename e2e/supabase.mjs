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
import { log, requireSupabaseEnvOrExit } from "./supabase-env.mjs";

// Resolve + validate config (skips/exits with clear diagnostics if missing/bad).
const { URL, ANON, SERVICE } = requireSupabaseEnvOrExit();

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

  // The creator-owned tables share one RLS pattern (creator_id = auth.uid() or
  // can_act_for(...)). Prove the isolation holds beyond `wheels` by spot-checking
  // a couple more tables: A inserts a row, B can neither see nor delete it.
  for (const t of [
    { table: "fans", row: () => ({ creator_id: A.id, display_name: "A's fan" }) },
    { table: "dm_templates", row: () => ({ creator_id: A.id, title: "A's template", body: "secret {link}" }) },
  ]) {
    await step(`RLS isolation on '${t.table}' (B can't see or delete A's row)`, async () => {
      const { data: ins, error: insErr } = await A.client
        .from(t.table)
        .insert(t.row())
        .select("id")
        .single();
      assert(!insErr, `A insert into ${t.table} failed: ${insErr?.message}`);
      const id = ins.id;
      const { data: bSees } = await B.client.from(t.table).select("id").eq("id", id);
      assert((bSees?.length ?? 0) === 0, `B must not read A's ${t.table} row`);
      const { data: bDel } = await B.client.from(t.table).delete().eq("id", id).select("id");
      assert((bDel?.length ?? 0) === 0, `B's delete on A's ${t.table} row affects 0 rows`);
      const { data: aStill } = await A.client.from(t.table).select("id").eq("id", id);
      assert((aStill?.length ?? 0) === 1, `A's ${t.table} row still exists`);
    });
  }

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
