import assert from "node:assert/strict";
import { mock } from "node:test";
import { FakeTables } from "@/lib/privacy/fakeTables";

// M1 + L5 on the Supabase path: every unauthenticated creator surface (the
// wheel teaser and its API, the /c/<slug> page, share cards and their API,
// the leaderboard page/API and the recent-wins feed) reads the creator through
// readPublicCreator. Negative tests: a suspended, pending or rejected account
// answers exactly like an unknown one (null / 404 / empty), a display name
// that is an e-mail address is never sent, and a closed leaderboard never
// names the creator.
const C = "a0000000-0000-4000-8000-000000000001";
const EMAIL = "bella.private@example.com";
const profile = {
  id: C, public_slug: "bella", display_name: "Bella" as string | null, is_active: true, approval_status: "approved",
  role: "creator", leaderboard_enabled: true, public_tagline: null, tip_url: "https://tips.example/bella", avatar_url: null, theme: null,
};
const db = new FakeTables({
  profiles: [profile],
  wheels: [{
    id: "w1", creator_id: C, title: "Live", subtitle: null, brand_color: "#123456", label_color: null, label_size: null, show_stock: false,
    game_kind: "wheel", game_config: {}, game_ready: true, is_active: true, active_from: null, active_until: null, archived_at: null,
    created_at: "2026-01-01T00:00:00Z", prizes: [],
  }],
  happy_hours: [],
  creator_media: [],
  spins: [{ id: "s1", share_id: "share-1", creator_id: C, fan_id: "f1", prize_label: "Signed photo", prize_rarity: "rare", prize_image_url: null,
    created_at: "2026-01-01T00:00:00Z", game_kind: "wheel", kind: "play", server_seed: "abc", nonce: 1, client_seed: null,
    server_seed_hash: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" }],
  fans: [{ id: "f1", creator_id: C, handle: "top_fan", leaderboard_opt_in: true, created_at: "2026-01-01T00:00:00Z" }],
});
mock.module("@/lib/supabase/server", { namedExports: {
  isSupabaseConfigured: () => true,
  createServiceClient: () => db,
  createClient: async () => { throw new Error("a public read never uses a session"); },
} });

let passed = 0;
const check = (label: string, cond: unknown) => { assert.ok(cond, label); passed++; };

const STATES = [
  ["suspended", { is_active: false }],
  ["pending", { approval_status: "pending" }],
  ["rejected", { approval_status: "rejected" }],
  ["suspended admin", { is_active: false, role: "admin", approval_status: "pending" }],
] as const;

async function main() {
  const { getPublicWheelTeaser, getPublicProfileBySlug } = await import("./publicProfile");
  const { getShareCard, getLeaderboard, getRecentWins, getSpinVerification } = await import("./boosts");
  const { GET: boardApi } = await import("@/app/api/leaderboard/[creatorId]/route");
  const { GET: teaserApi } = await import("@/app/api/public/wheel/[creatorId]/route");
  const { GET: shareApi } = await import("@/app/api/share-cards/[shareId]/route");
  let ip = 0;
  const req = (path: string) => new Request(`http://localhost${path}`, { headers: { "x-real-ip": `198.51.100.${++ip}` } });
  const surfaces = async () => ({
    teaser: await getPublicWheelTeaser(C),
    page: await getPublicProfileBySlug("bella"),
    card: await getShareCard("share-1"),
    verify: await getSpinVerification("share-1"),
    board: await getLeaderboard(C),
    boardBySlug: await getLeaderboard("bella"),
    wins: await getRecentWins(C),
    boardApi: (await boardApi(req(`/api/leaderboard/${C}`), { params: Promise.resolve({ creatorId: C }) })).status,
    teaserApi: (await teaserApi(req(`/api/public/wheel/${C}`), { params: Promise.resolve({ creatorId: C }) })).status,
    shareApi: (await shareApi(req("/api/share-cards/share-1"), { params: Promise.resolve({ shareId: "share-1" }) })).status,
  });

  // Active and approved: every surface is served, with the creator's name.
  let s = await surfaces();
  check("active: the teaser names the creator", s.teaser?.creatorTitle === "Bella");
  check("active: the link-in-bio page names the creator", s.page?.profile.creatorTitle === "Bella" && s.page.tipUrl === profile.tip_url);
  check("active: the share card names the creator", s.card?.creatorTitle === "Bella");
  check("active: the spin is verifiable (/verify)", s.verify?.hashOk === true);
  check("active: the open board names the creator, by id and by slug", s.board?.enabled === true && s.board.creatorTitle === "Bella" && s.boardBySlug?.creatorTitle === "Bella");
  check("active: the board lists the opted-in fan", s.board?.entries.length === 1 && s.board.entries[0].handle === "top_fan");
  check("active: recent wins are served", s.wins.length === 1);
  check("active: the public APIs answer 200", s.boardApi === 200 && s.teaserApi === 200 && s.shareApi === 200);

  // M1: an address stored as the display name is never sent anywhere.
  profile.display_name = EMAIL;
  s = await surfaces();
  check("e-mail name: no public surface carries the address", !JSON.stringify(s).includes("@"));
  check("e-mail name: every title is the neutral label", [s.teaser?.creatorTitle, s.page?.profile.creatorTitle, s.card?.creatorTitle, s.board?.creatorTitle].every((t) => t === "Creator"));
  profile.display_name = null;
  s = await surfaces();
  check("no name: every title is the neutral label", [s.teaser?.creatorTitle, s.page?.profile.creatorTitle, s.card?.creatorTitle, s.board?.creatorTitle].every((t) => t === "Creator"));
  profile.display_name = "Bella";

  // M1: a closed board returns no creator name.
  profile.leaderboard_enabled = false;
  const closed = await getLeaderboard(C);
  check("closed board: enabled:false, no entries and the neutral title (not the name)", closed?.enabled === false && closed.entries.length === 0 && closed.creatorTitle === "Creator");
  check("closed board: no recent wins", (await getRecentWins(C)).length === 0);
  profile.leaderboard_enabled = true;

  // L5: inactive or unapproved accounts answer like unknown ones.
  for (const [label, patch] of STATES) {
    const saved = { ...profile };
    Object.assign(profile, patch);
    s = await surfaces();
    check(`${label}: no teaser, no page, no share card`, s.teaser === null && s.page === null && s.card === null);
    check(`${label}: no public verification (batch 6 N2)`, s.verify === null);
    check(`${label}: no leaderboard (by id or slug) and no recent wins`, s.board === null && s.boardBySlug === null && s.wins.length === 0);
    check(`${label}: the public APIs answer 404`, s.boardApi === 404 && s.teaserApi === 404 && s.shareApi === 404);
    check(`${label}: nothing names the creator or the tip link`, !JSON.stringify(s).includes("Bella") && !JSON.stringify(s).includes("tips.example"));
    Object.assign(profile, saved);
  }
  // An approved admin has no approval to wait for; an unknown id is a 404.
  Object.assign(profile, { role: "admin", approval_status: "pending" });
  check("an active admin's pages are served", (await getPublicProfileBySlug("bella")) !== null);
  Object.assign(profile, { role: "creator", approval_status: "approved" });
  check("an unknown creator has no board", (await getLeaderboard("b0000000-0000-4000-8000-000000000002")) === null && (await getLeaderboard("nobody")) === null);

  console.log(`publicCreatorGate: ${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
