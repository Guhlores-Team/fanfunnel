// TEST-only fixtures use the application's durable economic writers. This file
// never enables bypass settings or writes balances, grants or spins directly.
import { createHash, randomBytes, randomUUID } from "node:crypto";

export const TEST_PROJECT = "snmcrmhgevfqggxdiomu";
export const FIXTURE_TERMS_VERSION = "2026-10-27";
export function requireTestProject(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.hostname !== `${TEST_PROJECT}.supabase.co` || parsed.username || parsed.password || parsed.port) {
    throw new Error("Refusing fixture writes: use the dedicated FanFunnel TEST project, never Production or an arbitrary project.");
  }
}
export function requireLocalTestServer(value) {
  if (!value) throw new Error("Set FANFUNNEL_TEST_BASE_URL to your running, TEST-configured local FanFunnel server (for example http://127.0.0.1:3202).");
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("FANFUNNEL_TEST_BASE_URL must be a loopback HTTP origin for your TEST-configured local server.");
  }
  return parsed.origin;
}
export function fixtureData(reply, label) {
  if (reply.error || reply.data == null) throw new Error(`${label}: ${reply.error?.message ?? "no data"}`);
  return reply.data;
}

/** The actor is a real signed-in fixture user, not a service-key role hint. */
export async function createFixturePass(admin, actor, { wheelId, fanId = null, name = "Integration fan", spins, amountCents = 0, requestId = randomUUID() }) {
  const auth = await actor.client.auth.getUser();
  if (auth.error || auth.data?.user?.id !== actor.id) throw new Error("Fixture actor must be the authenticated creator.");
  const profile = fixtureData(await admin.from("profiles").select("is_active,approval_status,role").eq("id", actor.id).single(), "fixture actor profile");
  if (!profile.is_active || profile.approval_status !== "approved" || profile.role !== "creator") throw new Error("Fixture actor must be an approved, active creator.");
  const result = fixtureData(await admin.rpc("create_pass_grant", {
    p_request: requestId, p_actor: actor.id, p_creator: actor.id, p_fan: fanId, p_wheel: wheelId,
    p_name: name, p_spins: spins, p_bonus: 0, p_amount: amountCents, p_campaign: null,
  }), "create durable fixture grant");
  if (result.status !== "granted") throw new Error(`Fixture grant refused: ${result.status}`);
  return result;
}

const sha = value => createHash("sha256").update(value).digest("hex");
const canonical = value => value === null || typeof value !== "object" ? JSON.stringify(value)
  : Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
    : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;

/**
 * A deterministic, single-common-prize DB fixture. This tests the real atomic
 * writer without duplicating the probabilistic engine. Multiple-prize demo
 * seeds use the actual HTTP application instead. Re-preparation retains the
 * SAME request identity; a nonterminal response is a test failure, not success.
 */
export async function commitSinglePrizeFixture(admin, token, { requestId = randomUUID() } = {}) {
  const clientSeed = "integration-fixture";
  const binding = { p_attempt: requestId, p_token: token,
    p_request_hash: sha(JSON.stringify(["spin-attempt-v1", "wheel", clientSeed, null])) };
  const nextSeed = randomBytes(32).toString("hex");
  for (let retry = 0; retry < 16; retry++) {
    const prepared = fixtureData(await admin.rpc("prepare_spin_attempt", binding), "prepare atomic fixture play");
    if (prepared.status !== "ready") return { ...prepared, requestId };
    const c = prepared.context;
    const eligible = c.prizes.filter(prize => prize.weight > 0 && (prize.stock === null || prize.stock > 0));
    if (c.focus || eligible.length !== 1 || eligible[0].rarity !== "common" || eligible[0].delivery !== "manual" || c.wheel.game_kind && c.wheel.game_kind !== "wheel") {
      throw new Error("Atomic fixture requires exactly one available manual common prize, a wheel game, and no focus.");
    }
    const prize = eligible[0];
    const snapshot = { v: 3, rules: "focus-v1", game: "wheel",
      prizes: [{ id: prize.id, label: prize.label, emoji: prize.emoji ?? null, rarity: prize.rarity, w: prize.weight, baseW: prize.weight }],
      modifiers: { happyHour: { multiplier: c.happyHourMultiplier ?? 1 }, pity: { counter: c.pityCounter, threshold: 10 }, focus: null, chase: null } };
    const spin = { id: requestId, creator_id: c.creatorId, fan_id: c.fanId, fan_pass_id: c.passId, wheel_id: c.wheelId,
      campaign_id: c.campaignId, prize_id: prize.id, prize_label: prize.label, prize_rarity: prize.rarity, prize_image_url: prize.image_url ?? null,
      server_seed: c.serverSeed, server_seed_hash: c.serverSeedHash, nonce: c.nonce, client_seed: clientSeed, fair_version: 3,
      pool_snapshot: snapshot, pool_hash: sha(canonical(snapshot)), fair_trace: { excluded: [], won: prize.id },
      next_pity_counter: c.pityCounter + 1, pity_awarded: false, focus_consumed: false, chase_consumed: false,
      chase_completed: false, chase_awarded: false, next_focus_spins_left: null, next_chase_counter: null,
      response_prize: { id: prize.id, label: prize.label, rarity: prize.rarity, weight: prize.weight },
      response_prize_index: c.prizes.findIndex(item => item.id === prize.id), response_show_stock: c.wheel.show_stock === true };
    const result = fixtureData(await admin.rpc("commit_spin_attempt", { ...binding, p_context: { contextHash: c.contextHash }, p_spin: spin,
      p_expected_reward: { delivery: "manual" }, p_next_seed: { seed: nextSeed, hash: sha(nextSeed) } }), "commit atomic fixture play");
    if (result.status === "retry_context") continue;
    if (!["committed", "declined", "unavailable", "conflict"].includes(result.status)) throw new Error(`Atomic fixture outcome unresolved: ${result.status}`);
    return { ...result, requestId };
  }
  throw new Error("Atomic fixture context remained contended; no committed outcome was assumed.");
}
