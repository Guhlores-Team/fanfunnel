// NEGATIVE AUTHZ (AGENTS.md rule 7) for the privacy self-service data layer,
// on the real Supabase code path against an in-memory fake:
//   - a fan token exports and deletes ONLY its own fan, never another fan of
//     the same creator, never another creator's fan with the same name;
//   - the fan export leaves out the creator's private fields (prize cost, the
//     creator's notes/tags, redemption notes, campaign names) and the
//     pre-committed seed of the fan's NEXT spin, and shortens link tokens;
//   - deleting leaves a tombstone (hash only), scrubs the fan's tokens from
//     safety reports and leaves the creator a notice with no PII;
//   - the creator export filters EVERY table to the signed-in creator, even
//     when RLS would show more (an agency member), with no service role.
import assert from "node:assert/strict";
import { mock } from "node:test";
import { createHash } from "node:crypto";
import { FakeTables, eqValue, on } from "@/lib/privacy/fakeTables";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

const CA = "c0000000-0000-4000-8000-00000000000a"; // creator A
const CB = "c0000000-0000-4000-8000-00000000000b"; // creator B
const svc = new FakeTables({
  profiles: [
    { id: CA, display_name: "Creator A" },
    { id: CB, display_name: "Creator B" },
  ],
  fans: [
    { id: "fanA", creator_id: CA, display_name: "Alice", handle: "ali", notes: "VIP whale", tags: ["whale"], spins_remaining: 2, spins_granted_total: 5, created_at: "2026-01-01", last_spin_at: null, referral_code: "R1", referred_by_fan_id: null, acked_at: "2026-01-02", leaderboard_opt_in: true },
    { id: "fanA2", creator_id: CA, display_name: "Other fan", notes: "secret", spins_remaining: 9, spins_granted_total: 9 },
    { id: "fanB", creator_id: CB, display_name: "Alice", notes: "B's notes", spins_remaining: 1, spins_granted_total: 1 },
  ],
  fan_passes: [
    { token: "tokA1aaaaaaa", fan_id: "fanA", creator_id: CA, created_at: "2026-01-01", is_active: true, self_excluded_at: null, spins_remaining: 2, spins_granted_total: 5, last_spin_at: null, next_server_seed: "NEXT-SEED-SECRET" },
    { token: "tokA2bbbbbbb", fan_id: "fanA", creator_id: CA, created_at: "2026-01-03", is_active: false, self_excluded_at: "2026-01-04", spins_remaining: 0, spins_granted_total: 0, last_spin_at: null },
    { token: "tokA2-other1", fan_id: "fanA2", creator_id: CA, is_active: true },
    { token: "tokB1ccccccc", fan_id: "fanB", creator_id: CB, is_active: true },
  ],
  grants: [
    { fan_id: "fanA", creator_id: CA, created_at: "2026-01-01", spins: 5, bonus_spins: 0, amount_cents: 999 },
    { fan_id: "fanA2", creator_id: CA, spins: 9, bonus_spins: 0, amount_cents: 1 },
  ],
  spins: [
    { id: "s1", fan_id: "fanA", creator_id: CA, created_at: "2026-01-05", prize_label: "Selfie", prize_rarity: "common", share_id: "sh1", server_seed: "used-seed", server_seed_hash: "h", client_seed: "c", nonce: 1, seed_commitment: null, fair_version: 3, pool_hash: "p", pool_snapshot: { prizes: [] }, fair_trace: { redraws: [] } },
    { id: "s2", fan_id: "fanA2", creator_id: CA, prize_label: "Other", prize_rarity: "rare" },
    { id: "s3", fan_id: "fanB", creator_id: CB, prize_label: "B prize", prize_rarity: "common" },
  ],
  redemptions: [
    { spin_id: "s1", creator_id: CA, status: "pending", created_at: "2026-01-05", fulfilled_at: null, notes: "ship to his flat", due_at: "2026-02-01" },
    { spin_id: "s2", creator_id: CA, status: "pending", notes: "other" },
  ],
  wishlists: [
    { fan_id: "fanA", creator_id: CA, prize_label: "Video", prize_rarity: "epic", created_at: "2026-01-06" },
    { fan_id: "fanA2", creator_id: CA, prize_label: "Other wish", prize_rarity: "common" },
  ],
  messages: [
    { fan_id: "fanA", creator_id: CA, sender: "fan", body: "hi from Alice", created_at: "2026-01-07" },
    { fan_id: "fanA", creator_id: CA, sender: "creator", body: "creator reply" },
    { fan_id: "fanA2", creator_id: CA, sender: "fan", body: "hi from someone else" },
    { fan_id: "fanB", creator_id: CB, sender: "fan", body: "hi from B's Alice" },
  ],
  referrals: [{ referrer_fan_id: "fanA", referred_fan_id: "fanA2", creator_id: CA }],
  creator_reports: [{ token: "tokA1aaaaaaa", creator_id: CA, reason: "x" }],
  link_tombstones: [],
  creator_notices: [],
});

// The schema's foreign keys (0054): deleting a fan cascades its links, top-ups,
// wishlist, chat and referrals, and anonymizes its spins.
svc.onDelete = (table, removed) => {
  if (table !== "fans") return;
  const ids = new Set(removed.map((r) => r.id));
  for (const t of ["fan_passes", "grants", "wishlists", "messages"]) {
    svc.tables[t] = svc.rows(t).filter((r) => !ids.has(r.fan_id));
  }
  svc.tables.referrals = svc.rows("referrals").filter((r) => !ids.has(r.referrer_fan_id) && !ids.has(r.referred_fan_id));
  for (const sp of svc.rows("spins")) if (ids.has(sp.fan_id)) Object.assign(sp, { fan_id: null, fan_pass_id: null });
};

// The creator's session client: RLS here would show creator B's rows too (an
// agency manager acting for B), so the code must filter to its own id.
const session = new FakeTables({
  profiles: [{ id: CA, display_name: "Creator A", role: "creator" }],
  wheels: [
    { id: "w1", creator_id: CA, title: "A wheel" },
    { id: "w2", creator_id: CB, title: "B wheel" },
  ],
  prizes: [
    { id: "p1", wheel_id: "w1", label: "A prize", cost_cents: 500 },
    { id: "p2", wheel_id: "w2", label: "B prize", cost_cents: 900 },
  ],
  fans: [
    { id: "fanA", creator_id: CA, display_name: "Alice", notes: "VIP whale" },
    { id: "fanB", creator_id: CB, display_name: "B fan" },
  ],
  fan_passes: [
    { id: "pp1", token: "tokA1aaaaaaa", creator_id: CA, fan_id: "fanA", next_server_seed: "NEXT-SEED-SECRET", next_server_seed_hash: "nh" },
    { id: "pp2", token: "tokB1ccccccc", creator_id: CB, fan_id: "fanB" },
  ],
  spins: [
    { id: "s1", creator_id: CA },
    { id: "s3", creator_id: CB },
  ],
});
let signedIn = true;
const sessionClient = {
  from: (t: string) => session.from(t),
  auth: {
    getUser: async () => ({
      data: {
        user: signedIn
          ? { id: CA, email: "a@example.com", created_at: "2025-01-01", factors: [{ id: "f1", factor_type: "totp", friendly_name: "Phone", status: "verified", created_at: "2026-01-01", secret: "never" }] }
          : null,
      },
    }),
  },
};
let serviceClientUsedBySession = false;
let mode: "fan" | "creator" = "fan";

mock.module("@/lib/supabase/server", {
  namedExports: {
    isSupabaseConfigured: () => true,
    createClient: async () => sessionClient,
    createServiceClient: () => {
      if (mode === "creator") serviceClientUsedBySession = true;
      return { from: (t: string) => svc.from(t) };
    },
  },
});

let passed = 0;
const check = (label: string, cond: unknown) => {
  assert.ok(cond, label);
  passed++;
};

async function main() {
  const { exportFanData, deleteFanData, getFanLinkStatus, exportCreatorData } = await import("./privacy");

  // ---------------- fan export ----------------
  const exp = await exportFanData("tokA1aaaaaaa");
  check("export for a real token", exp && exp.format === "fanfunnel.fan-data.v1");
  const text = JSON.stringify(exp);
  check("profile is the token's fan", exp!.profile.displayName === "Alice" && exp!.profile.handle === "ali");
  check("both of this fan's links, masked", exp!.links.length === 2 && exp!.links.every((l) => /^….{4}$/.test(l.linkEndsWith)));
  check("the current link is flagged", exp!.links.filter((l) => l.isThisLink).length === 1);
  check("no full token anywhere in the file", !text.includes("tokA1aaaaaaa") && !text.includes("tokA2bbbbbbb"));
  check("only this fan's spins, with fairness data", exp!.spins.length === 1 && exp!.spins[0].fairness.serverSeed === "used-seed" && exp!.spins[0].fairness.version === 3);
  check("prize status for this fan's spin only", exp!.prizes.length === 1 && exp!.prizes[0].spinId === "s1");
  check("only messages the fan SENT", exp!.messagesYouSent.length === 1 && exp!.messagesYouSent[0].body === "hi from Alice");
  check("wishlist is this fan's", exp!.wishlist.length === 1 && exp!.wishlist[0].prize === "Video");
  check("consents carried", exp!.consents.ageAndTermsAcceptedAt === "2026-01-02" && exp!.consents.leaderboardOptIn === true);
  check("top-ups without amounts", exp!.topUps.length === 1 && !("amount" in exp!.topUps[0]) && !text.includes("999"));
  check("friends referred is a count, no ids", exp!.profile.friendsReferred === 1 && !text.includes("fanA2"));
  for (const secret of ["VIP whale", "whale", "ship to his flat", "2026-02-01", "NEXT-SEED-SECRET", "Other fan", "hi from someone else", "B's notes", "hi from B's Alice", "creator reply"]) {
    check(`the fan export never contains "${secret}"`, !text.includes(secret));
  }
  // Every fan-scoped read was pinned to fan A + creator A.
  for (const t of ["fans", "grants", "wishlists", "messages", "spins"]) {
    for (const s of on(svc, t)) {
      const fanCol = t === "fans" ? "id" : "fan_id";
      check(`${t} read pinned to fan A`, eqValue(s, fanCol) === "fanA" && eqValue(s, "creator_id") === CA);
    }
  }
  check("an unknown token exports nothing", (await exportFanData("tokZZZZZZZZZ")) === null);
  check("a malformed token never reaches the database", (await exportFanData("../../etc")) === null);

  // ---------------- fan delete ----------------
  svc.statements.length = 0;
  const del = await deleteFanData("tokA1aaaaaaa");
  check("delete ok, reports spins kept", "ok" in del && del.spinsKept === 1);
  const fanDeletes = svc.statements.filter((s) => s.op === "delete");
  check("exactly one delete, on fans, for fan A of creator A", fanDeletes.length === 1 && fanDeletes[0].table === "fans" && eqValue(fanDeletes[0], "id") === "fanA" && eqValue(fanDeletes[0], "creator_id") === CA);
  check("the other fans are untouched", svc.rows("fans").map((f) => f.id).sort().join() === "fanA2,fanB");
  check("the other fans' links survive", svc.rows("fan_passes").map((p) => p.token).sort().join() === "tokA2-other1,tokB1ccccccc");
  check("fan A's spin is kept, anonymized", svc.rows("spins").find((x) => x.id === "s1")?.fan_id === null);
  const tombs = svc.rows("link_tombstones");
  check("a tombstone per link, hashes only", tombs.length === 2 && tombs.every((t) => t.reason === "fan_deleted") && tombs.some((t) => t.token_hash === sha("tokA1aaaaaaa")) && !JSON.stringify(tombs).includes("tokA"));
  check("the fan's tokens are scrubbed from safety reports", svc.rows("creator_reports")[0].token === null);
  const notices = svc.rows("creator_notices");
  check("the creator gets one notice, no PII", notices.length === 1 && notices[0].creator_id === CA && notices[0].kind === "fan_deleted_data" && !JSON.stringify(notices[0]).includes("Alice"));
  check("the link now says it was deleted", (await getFanLinkStatus("tokA2bbbbbbb")) === "fan_deleted");
  check("an unknown link has no status (404)", (await getFanLinkStatus("tokNOPE00000")) === null);
  check("deleting again: not found", "error" in (await deleteFanData("tokA1aaaaaaa")));
  svc.failWhen = (s) => (s.table === "fans" && s.op === "delete" ? "boom" : null);
  const failed = await deleteFanData("tokA2-other1");
  check("a failed delete reports db_error and leaves no tombstone or notice", "error" in failed && svc.rows("link_tombstones").length === 2 && svc.rows("creator_notices").length === 1);
  svc.failWhen = null;

  // ---------------- creator export ----------------
  mode = "creator";
  const cexp = await exportCreatorData();
  check("creator export built", cexp && cexp.format === "fanfunnel.creator-data.v1");
  const ctext = JSON.stringify(cexp);
  check("own wheels only", cexp!.sections.wheels.length === 1 && cexp!.sections.wheels[0].id === "w1");
  check("own prizes only (costs are the creator's own)", cexp!.sections.prizes.length === 1 && cexp!.sections.prizes[0].cost_cents === 500);
  check("own fans only, with the creator's notes", cexp!.sections.fans.length === 1 && cexp!.sections.fans[0].notes === "VIP whale");
  check("no B data anywhere", !ctext.includes("B wheel") && !ctext.includes("B prize") && !ctext.includes("B fan") && !ctext.includes(CB));
  check("fan links masked, no next-spin seed", cexp!.sections.fan_links.length === 1 && !ctext.includes("tokA1aaaaaaa") && !ctext.includes("NEXT-SEED-SECRET"));
  check("2FA listed without secrets", ctext.includes("Phone") && !ctext.includes("never"));
  for (const s of session.statements) {
    if (s.table === "prizes") check("prizes read by own wheel ids", JSON.stringify(s.filters).includes("w1") && !JSON.stringify(s.filters).includes("w2"));
    else check(`${s.table} read filtered to creator A`, Object.values(s.filters).some((f) => f.value === CA));
  }
  check("the creator export never builds a service client", !serviceClientUsedBySession);
  check("a complete export lists no failed sections", Array.isArray(cexp!.failed) && cexp!.failed.length === 0);
  session.failWhen = (s) => (s.table === "messages" && s.op === "select" ? "boom" : null);
  const partial = await exportCreatorData();
  session.failWhen = null;
  check("a section that can't be read is named in failed, never silently empty", partial!.failed.includes("messages") && partial!.failed.length === 1);
  signedIn = false;
  check("signed out → no export", (await exportCreatorData()) === null);

  console.log(`privacy data layer: ${passed} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
