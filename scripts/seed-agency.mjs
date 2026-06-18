/**
 * Seed test accounts + an agency + sample data so you can exercise the whole
 * agency / autopilot / fan-view flow end to end.
 *
 * Run:  node scripts/seed-agency.mjs
 * Needs (from .env.local — loaded automatically if present):
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY   (server-only key; bypasses RLS)
 *
 * Idempotent: re-running re-uses existing auth users and rebuilds sample data.
 * A fresh strong random password is generated for every account on each run and
 * printed to the console at the end — use those credentials to sign in.
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

// --- Tiny .env.local loader (no extra deps) ---------------------------------
try {
  for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {
  /* no .env.local — rely on real env */
}

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL_ || !KEY) {
  console.error("✗ Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (in .env.local).");
  process.exit(1);
}
const sb = createClient(URL_, KEY, { auth: { autoRefreshToken: false, persistSession: false } });

// Generate a strong, random password (no hardcoded credentials). 24 url-safe
// chars from 18 random bytes (~144 bits of entropy).
const generatePassword = () => randomBytes(18).toString("base64url");
const PEOPLE = [
  { key: "owner", email: "owner@fanfunnel.test", name: "Agency Owner" },
  { key: "aria", email: "aria@fanfunnel.test", name: "Aria Rose" },
  { key: "mia", email: "mia@fanfunnel.test", name: "Mia Knight" },
  { key: "chatter", email: "chatter@fanfunnel.test", name: "Sam Chatter" },
  { key: "fulfiller", email: "fulfiller@fanfunnel.test", name: "Jo Fulfiller" },
];

async function findUserByEmail(email) {
  // Paginate listUsers (no direct get-by-email in the admin API).
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await sb.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const hit = data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
    if (hit) return hit;
    if (data.users.length < 200) return null;
  }
  // Reached the page cap with the last page still full: more users may exist
  // beyond what we scanned, so a "not found" result here is not authoritative
  // and could lead to creating a duplicate user.
  console.warn(
    `  ⚠ user scan for ${email} hit the 20-page limit (4000 users) without exhausting the list; ` +
      `an existing user may have been missed and a duplicate could be created.`,
  );
  return null;
}

async function ensureUser(p) {
  // Fresh strong password for this account; recorded on the person for the
  // end-of-run summary so the developer can sign in.
  p.password = generatePassword();
  let user = await findUserByEmail(p.email);
  if (!user) {
    const { data, error } = await sb.auth.admin.createUser({
      email: p.email,
      password: p.password,
      email_confirm: true,
      user_metadata: { display_name: p.name },
    });
    if (error) throw error;
    user = data.user;
    console.log(`  + created ${p.email}`);
  } else {
    // Reset the existing user's password so the logged credentials are valid.
    const { error } = await sb.auth.admin.updateUserById(user.id, { password: p.password });
    if (error) throw error;
    console.log(`  · exists  ${p.email} (password reset)`);
  }
  // Ensure the profile is approved/active with a display name (the trigger
  // creates it as pending). Service-role bypasses RLS.
  await sb
    .from("profiles")
    .update({
      display_name: p.name,
      approval_status: "approved",
      is_active: true,
      org_id: null, // reset; we set memberships explicitly below
      leaderboard_enabled: true,
    })
    .eq("id", user.id);
  return user.id;
}

async function wipeCreatorData(creatorId) {
  // Order respects FKs; cascades handle the rest.
  await sb.from("spins").delete().eq("creator_id", creatorId);
  await sb.from("grants").delete().eq("creator_id", creatorId);
  await sb.from("fan_passes").delete().eq("creator_id", creatorId);
  await sb.from("fans").delete().eq("creator_id", creatorId);
  await sb.from("wheels").delete().eq("creator_id", creatorId);
}

const RARITIES = ["common", "common", "uncommon", "rare", "epic", "legendary"];
const token = () => Math.random().toString(36).slice(2, 10);

async function seedCreatorContent(creatorId, slug) {
  await wipeCreatorData(creatorId);
  await sb.from("profiles").update({ public_slug: slug }).eq("id", creatorId);

  const { data: wheel } = await sb
    .from("wheels")
    .insert({ creator_id: creatorId, title: `${slug}'s Wheel`, subtitle: "Every spin wins!" })
    .select("id")
    .single();

  const prizeDefs = [
    { label: "Shoutout", rarity: "common", weight: 30, emoji: "📣" },
    { label: "Custom Voice Note", rarity: "uncommon", weight: 20, emoji: "🎤" },
    { label: "Signed Polaroid", rarity: "rare", weight: 12, emoji: "📸", stock: 5 },
    { label: "VIP Month", rarity: "epic", weight: 5, emoji: "👑", stock: 3 },
    { label: "1-on-1 Call", rarity: "legendary", weight: 2, emoji: "💎", stock: 1 },
  ];
  const { data: prizes } = await sb
    .from("prizes")
    .insert(prizeDefs.map((p, i) => ({ ...p, wheel_id: wheel.id, sort_order: i })))
    .select("id, label, rarity");

  // Three fans, opted into the leaderboard, with grants (revenue) + spins (wins).
  const fanDefs = [
    { handle: "nova", name: "Nova", spent: 4800, spins: 6 },
    { handle: "luna", name: "Luna", spent: 2500, spins: 3 },
    { handle: "rae", name: "Rae", spent: 800, spins: 1 },
  ];
  for (const f of fanDefs) {
    const { data: fan } = await sb
      .from("fans")
      .insert({
        creator_id: creatorId,
        handle: f.handle,
        display_name: f.name,
        spins_remaining: 2,
        spins_granted_total: f.spins + 2,
        leaderboard_opt_in: true,
      })
      .select("id")
      .single();
    const { data: pass } = await sb
      .from("fan_passes")
      .insert({ token: token(), creator_id: creatorId, wheel_id: wheel.id, fan_id: fan.id })
      .select("id, token")
      .single();
    await sb
      .from("grants")
      .insert({ creator_id: creatorId, fan_id: fan.id, spins: f.spins + 2, amount_cents: f.spent });
    // Record a few wins, biased toward rares so the ticker + leaderboard light up.
    for (let i = 0; i < f.spins; i++) {
      const prize = prizes[Math.min(i, prizes.length - 1)];
      await sb.from("spins").insert({
        fan_pass_id: pass.id,
        creator_id: creatorId,
        wheel_id: wheel.id,
        fan_id: fan.id,
        prize_id: prize.id,
        prize_label: prize.label,
        prize_rarity: prize.rarity,
      });
    }
    console.log(`    fan @${f.handle} → /spin/${pass.token}`);
  }
}

async function main() {
  console.log("Seeding accounts…");
  const ids = {};
  for (const p of PEOPLE) ids[p.key] = await ensureUser(p);

  console.log("Building agency…");
  // Org owned by `owner`. Idempotent: re-use an existing owned org.
  let { data: org } = await sb.from("orgs").select("id").eq("owner_id", ids.owner).maybeSingle();
  if (!org) {
    ({ data: org } = await sb
      .from("orgs")
      .insert({ name: "Starlight Agency", owner_id: ids.owner })
      .select("id")
      .single());
  }

  // aria = accepted member (org_id set) with full sample data.
  await sb.from("profiles").update({ org_id: org.id }).eq("id", ids.aria);
  await seedCreatorContent(ids.aria, "aria");

  // mia = PENDING INVITE (org_id stays null) so you can test Accept/Decline.
  await sb.from("profiles").update({ org_id: null }).eq("id", ids.mia);
  await sb.from("org_invites").upsert(
    { org_id: org.id, email: "mia@fanfunnel.test", status: "pending" },
    { onConflict: "org_id,email" }
  );

  // Staff seats: chatter (scoped to aria) + fulfiller (scoped to aria).
  await sb.from("org_members").delete().eq("org_id", org.id);
  for (const [key, role] of [
    ["chatter", "chatter"],
    ["fulfiller", "fulfiller"],
  ]) {
    const { data: m } = await sb
      .from("org_members")
      .insert({ org_id: org.id, profile_id: ids[key], role })
      .select("id")
      .single();
    await sb
      .from("org_member_creators")
      .upsert({ member_id: m.id, creator_id: ids.aria }, { onConflict: "member_id,creator_id" });
  }

  const pw = (key) => PEOPLE.find((p) => p.key === key).password;
  console.log("\n✓ Done. Generated passwords (copy now — not stored anywhere):\n");
  console.table([
    { role: "Agency owner", email: "owner@fanfunnel.test", password: pw("owner"), note: "→ /agency (roster, seats, invites)" },
    { role: "Creator (in org)", email: "aria@fanfunnel.test", password: pw("aria"), note: "has wheel/fans/revenue; rolls up to agency" },
    { role: "Creator (invited)", email: "mia@fanfunnel.test", password: pw("mia"), note: "→ /dashboard shows Accept/Decline banner" },
    { role: "Staff · chatter", email: "chatter@fanfunnel.test", password: pw("chatter"), note: "scoped to Aria (chat only)" },
    { role: "Staff · fulfiller", email: "fulfiller@fanfunnel.test", password: pw("fulfiller"), note: "scoped to Aria (fulfil only)" },
  ]);
}

main().catch((e) => {
  console.error("✗ Seed failed:", e.message ?? e);
  process.exit(1);
});
