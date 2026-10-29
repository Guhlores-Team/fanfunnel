import assert from "node:assert/strict";
import { resolveActiveWheelId, resolveWheelId } from "./wheels";
import type { AnyClient } from "./shared";
import type { WheelConfig } from "@/lib/games/wheel/types";
import { mockResolveActiveWheelId, mockResolvedSpinWheelId } from "./mock";
interface Row extends Record<string, unknown> { id: string; creator_id: string; is_active: boolean; active_from: string | null; active_until: string | null; archived_at: string | null; created_at: string }
const OWNER = "owner", OTHER = "other", NOW = new Date("2026-10-28T12:00:00Z");
let wheels: Row[] = [], campaigns: Record<string, unknown>[] = [];
const old = (id: string, patch: Partial<Row> = {}): Row => ({ id, creator_id: OWNER, is_active: false, active_from: null, active_until: null, archived_at: null, game_ready: true, created_at: "2026-01-01T00:00:00Z", ...patch });
const client = { from: (table: string) => {
  let rows: Record<string, unknown>[] = table === "wheels" ? [...wheels] : [...campaigns];
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.eq = (key: string, value: unknown) => { rows = rows.filter(row => row[key] === value); return chain; };
  chain.is = chain.eq;
  chain.maybeSingle = async () => ({ data: rows[0] ?? null, error: null });
  chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(resolve);
  return chain;
} } as unknown as AnyClient;
const demo = globalThis as unknown as { __ffStore: { wheels: Map<string, WheelConfig>; campaigns: { id: string; name: string; isActive: boolean; createdAt: string; pinnedWheelId: string | null }[] }; __ffWheelMeta: Map<string, { createdAt: string; updatedAt: string }> };
function fixtures(rows: Row[], pin?: { id: string; creator_id: string; pinned_wheel_id: string }) {
  wheels = rows; campaigns = pin ? [pin] : [];
  demo.__ffStore.wheels.clear(); demo.__ffWheelMeta.clear();
  for (const row of rows.filter(row => row.creator_id === OWNER)) {
    demo.__ffStore.wheels.set(row.id, { id: row.id, title: row.id, prizes: [], isActive: row.is_active, activeFrom: row.active_from, activeUntil: row.active_until, archivedAt: row.archived_at });
    demo.__ffWheelMeta.set(row.id, { createdAt: row.created_at, updatedAt: row.created_at });
  }
  demo.__ffStore.campaigns = pin && pin.creator_id === OWNER ? [{ id: pin.id, name: "Pinned", isActive: true, createdAt: "2026-01-01T00:00:00Z", pinnedWheelId: pin.pinned_wheel_id }] : [];
}
let passed = 0;
async function same(label: string, expected: string) {
  assert.equal(await resolveActiveWheelId(client, OWNER, NOW), expected, `${label}: Supabase`);
  assert.equal(mockResolveActiveWheelId(NOW), expected, `${label}: mock`); passed += 2;
}
async function main() {
  fixtures([old("flagged", { is_active: true }), old("new-blank", { created_at: "2026-10-01T00:00:00Z" })]);
  await same("unscheduled new wheel cannot preempt explicit active", "flagged");
  fixtures([old("oldest"), old("new-blank", { created_at: "2026-10-01T00:00:00Z" })]);
  await same("without schedule or flag oldest is fallback", "oldest");
  fixtures([old("flagged", { is_active: true }), old("start-only", { active_from: "2026-10-01T00:00:00Z" })]);
  await same("open-ended started schedule wins", "start-only");
  fixtures([old("flagged", { is_active: true }), old("end-only", { active_until: "2026-11-01T00:00:00Z" })]);
  await same("open-start unexpired schedule wins", "end-only");
  fixtures([old("flagged", { is_active: true }), old("future", { active_from: "2026-11-01T00:00:00Z" }), old("expired", { active_until: "2026-10-01T00:00:00Z" })]);
  await same("future and expired schedules do not preempt active", "flagged");
  fixtures([old("earlier", { active_from: "2026-10-01T00:00:00Z" }), old("b", { active_from: "2026-10-02T00:00:00Z" }), old("a", { active_from: "2026-10-02T00:00:00Z" })]);
  await same("latest start then deterministic identity tie", "a");
  fixtures([old("b", { is_active: true }), old("a", { is_active: true })]);
  await same("multiple legacy flags resolve deterministically", "a");
  const pass = { creator_id: OWNER, campaign_id: "campaign", wheel_id: "stored" };
  fixtures([old("flagged", { is_active: true }), old("pinned")], { id: "campaign", creator_id: OWNER, pinned_wheel_id: "pinned" });
  assert.equal(await resolveWheelId(client, pass, NOW), "pinned"); assert.equal(mockResolvedSpinWheelId({ campaignId: "campaign", wheelId: "stored" }, NOW), "pinned"); passed += 2;
  fixtures([old("flagged", { is_active: true }), old("pinned", { archived_at: "2026-10-01T00:00:00Z" })], { id: "campaign", creator_id: OWNER, pinned_wheel_id: "pinned" });
  assert.equal(await resolveWheelId(client, pass, NOW), "flagged"); assert.equal(mockResolvedSpinWheelId({ campaignId: "campaign", wheelId: "stored" }, NOW), "flagged"); passed += 2;
  fixtures([old("flagged", { is_active: true }), old("foreign", { creator_id: OTHER })], { id: "campaign", creator_id: OWNER, pinned_wheel_id: "foreign" });
  assert.equal(await resolveWheelId(client, pass, NOW), "flagged", "foreign pinned wheel cannot cross tenant"); passed++;
  fixtures([old("flagged", { is_active: true }), old("foreign", { creator_id: OTHER })], { id: "campaign", creator_id: OTHER, pinned_wheel_id: "foreign" });
  assert.equal(await resolveWheelId(client, pass, NOW), "flagged", "foreign campaign cannot redirect pass"); passed++;
  fixtures([old("foreign", { creator_id: OTHER })]);
  assert.equal(await resolveWheelId(client, { ...pass, campaign_id: null, wheel_id: "foreign" }, NOW), null, "foreign stored fallback refused"); passed++;
  console.log(`focus wheel resolution: ${passed} checks passed`);
}
main().catch(error => { console.error(error); process.exit(1); });
