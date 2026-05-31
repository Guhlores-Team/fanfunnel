import { pickPrize, pickPrizeWithPity } from "@/lib/games/wheel/engine";
import { SAMPLE_WHEEL } from "@/lib/games/wheel/sample";
import { RARITY_COLORS, type Prize, type Rarity, type WheelConfig } from "@/lib/games/wheel/types";
import { defaultFeatures } from "@/lib/features";
import type {
  AdminAccount,
  AdminOverview,
  Campaign,
  CampaignPack,
  CampaignStats,
  CreatorMetricsExtra,
  CreatorOverview,
  FanAccountSummary,
  FanCampaignBreakdown,
  FanDetail,
  DmTemplate,
  FanPassView,
  Grant,
  PrizeTemplate,
  RedemptionItem,
  RedemptionStatus,
  WheelSummary,
  WheelTemplate,
  WonPrize,
} from "./types";
import { bucketByDay, bucketCentsByDay, clampDays } from "./metrics";

// In-memory demo store. Used automatically when Supabase env vars are absent,
// so `npm run dev` gives a fully working app with zero setup. State resets when
// the dev server restarts.
//
// Mirrors production semantics:
//  * ONE editable creator wheel (the editor saves here; fans read from it;
//    limited stock is shared across all fans, like a real prizes table).
//  * balance + win history live on the FAN account, not the link, so many
//    tokens can point at one fan and share everything.

const CREATOR_TITLE = "Demo Creator";

// A win record carries the FIFO-attributed campaign for the spin that won it.
interface MockWin extends WonPrize {
  campaignId: string | null;
}

interface MockFan {
  id: string;
  name: string;
  spinsRemaining: number;
  spinsGrantedTotal: number; // tracked independently of remaining
  primaryToken: string;
  wins: MockWin[];
  notes: string | null; // free-form creator notes
  tags: string[]; // creator-applied labels
  pityCounter: number; // spins-without-a-rare, drives the pity guarantee
}

// A single grant (new fan creation OR a top-up), tagged to a campaign.
interface MockGrant {
  id: string;
  fanId: string;
  campaignId: string | null;
  spins: number;
  amountCents: number;
  bonusSpins: number;
  at: string;
}

// Redemptions in the mock carry the fan + FIFO campaign so stats can be exact.
interface MockRedemption extends RedemptionItem {
  fanId: string;
  campaignId: string | null;
}

interface Store {
  wheels: Map<string, WheelConfig>; // wheelId -> wheel config (multiple wheels)
  fans: Map<string, MockFan>; // fanId -> fan
  tokens: Map<string, string>; // token -> fanId
  redemptions: MockRedemption[]; // creator-wide fulfilment queue (newest first)
  accounts: AdminAccount[]; // demo creator/admin accounts for the admin panel
  campaigns: Campaign[]; // creator's campaigns (newest first)
  tokenCampaign: Map<string, string>; // token -> campaignId
  grants: MockGrant[]; // every grant ever made (oldest first per fan via push order)
  dmTemplates: DmTemplate[]; // creator's saved DM templates (newest first)
  campaignPacks: CampaignPack[]; // purchasable spin packs (global or per-campaign)
  prizeTemplates: PrizeTemplate[]; // reusable prizes
  wheelTemplates: WheelTemplate[]; // reusable wheel presets
}

/** Short, unique id with a stable prefix (mirrors the file's existing style). */
function genId(prefix: string): string {
  return prefix + "-" + Math.random().toString(36).slice(2, 10);
}

// Track creation order for wheels (the Map preserves insertion order, but an
// explicit field keeps "newest"/"oldest" resolution robust across saves).
interface WheelMeta {
  createdAt: string;
  updatedAt: string;
}
const g2 = globalThis as unknown as { __ffWheelMeta?: Map<string, WheelMeta> };
const wheelMeta: Map<string, WheelMeta> =
  g2.__ffWheelMeta ?? (g2.__ffWheelMeta = new Map());

// A few seeded accounts so the admin panel is explorable in demo mode.
function seedAccounts(): AdminAccount[] {
  return [
    {
      id: "acc-you",
      email: "you@fanfunnel.app",
      displayName: "You (Agency)",
      role: "admin",
      isActive: true,
      features: { ...defaultFeatures(), scratch: true, bingo: true },
      wheels: 1,
      fans: 0,
      spins: 0,
      pending: 0,
    },
    {
      id: "acc-bella",
      email: "bella@example.com",
      displayName: "Bella",
      role: "creator",
      isActive: true,
      features: { ...defaultFeatures(), scratch: true },
      wheels: 2,
      fans: 48,
      spins: 312,
      pending: 7,
    },
    {
      id: "acc-mia",
      email: "mia@example.com",
      displayName: "Mia Rose",
      role: "creator",
      isActive: true,
      features: defaultFeatures(),
      wheels: 1,
      fans: 23,
      spins: 96,
      pending: 2,
    },
    {
      id: "acc-jade",
      email: "jade@example.com",
      displayName: "Jade",
      role: "creator",
      isActive: false,
      features: defaultFeatures(),
      wheels: 1,
      fans: 5,
      spins: 11,
      pending: 0,
    },
  ];
}

// Two default DM templates so the "Copy DM" picker is useful out of the box.
// `{link}` is replaced with the fan's full spin URL when a template is used.
function seedDmTemplates(): DmTemplate[] {
  return [
    {
      id: "dm-spin-invite",
      title: "Spin invite",
      body: "Hey! 🎡 Here's your spin link: {link}",
      createdAt: new Date().toISOString(),
    },
    {
      id: "dm-topup-nudge",
      title: "Top-up nudge",
      body: "You're out of spins — top up and let's go again: {link}",
      createdAt: new Date().toISOString(),
    },
  ];
}

// Two demo spin packs (global — attached to no campaign) so the presets UI
// shows something out of the box.
function seedCampaignPacks(): CampaignPack[] {
  const now = new Date().toISOString();
  return [
    {
      id: "pack-starter",
      campaignId: null,
      label: "Starter — 5 spins",
      spins: 5,
      amountCents: 1000,
      bonusSpins: 0,
      sortOrder: 0,
      createdAt: now,
    },
    {
      id: "pack-value",
      campaignId: null,
      label: "Value — 12 spins (+2 bonus)",
      spins: 12,
      amountCents: 2000,
      bonusSpins: 2,
      sortOrder: 1,
      createdAt: now,
    },
  ];
}

// A couple of reusable prizes so the prize library isn't empty in demo mode.
function seedPrizeTemplates(): PrizeTemplate[] {
  const now = new Date().toISOString();
  return [
    {
      id: "ptpl-selfie",
      label: "Exclusive Selfie",
      rarity: "common",
      weight: 40,
      emoji: "🤳",
      color: RARITY_COLORS.common,
      createdAt: now,
    },
    {
      id: "ptpl-call",
      label: "10-min Video Call",
      rarity: "rare",
      weight: 6,
      emoji: "📞",
      color: RARITY_COLORS.rare,
      createdAt: now,
    },
  ];
}

// One reusable wheel preset (derived from the sample wheel, ids stripped).
function seedWheelTemplates(): WheelTemplate[] {
  return [
    {
      id: "wtpl-starter",
      name: "Starter Wheel",
      title: SAMPLE_WHEEL.title,
      subtitle: SAMPLE_WHEEL.subtitle,
      brandColor: SAMPLE_WHEEL.brandColor ?? "#ec4899",
      prizes: SAMPLE_WHEEL.prizes.map(({ id: _id, ...rest }) => rest),
      createdAt: new Date().toISOString(),
    },
  ];
}

// Build the initial single active wheel seeded from SAMPLE_WHEEL.
function seedWheels(): Map<string, WheelConfig> {
  const wheel: WheelConfig = {
    ...structuredClone(SAMPLE_WHEEL),
    isActive: true,
    activeFrom: null,
    activeUntil: null,
    archivedAt: null,
  };
  const m = new Map<string, WheelConfig>();
  m.set(wheel.id, wheel);
  return m;
}

// Pin to globalThis so the store is shared across every Next.js entry point
// (pages and route handlers are bundled separately).
const g = globalThis as unknown as { __ffStore?: Store };
const store: Store =
  g.__ffStore ??
  (g.__ffStore = {
    wheels: seedWheels(),
    fans: new Map(),
    tokens: new Map(),
    redemptions: [],
    accounts: seedAccounts(),
    campaigns: [],
    tokenCampaign: new Map(),
    grants: [],
    dmTemplates: seedDmTemplates(),
    campaignPacks: seedCampaignPacks(),
    prizeTemplates: seedPrizeTemplates(),
    wheelTemplates: seedWheelTemplates(),
  });

// A store pinned by an older dev-server build may predate these fields, so
// backfill them defensively rather than crashing on the new code paths.
store.campaigns ??= [];
store.tokenCampaign ??= new Map();
store.grants ??= [];
store.dmTemplates ??= seedDmTemplates();
store.wheels ??= seedWheels();
store.campaignPacks ??= seedCampaignPacks();
store.prizeTemplates ??= seedPrizeTemplates();
store.wheelTemplates ??= seedWheelTemplates();

// Migrate a store pinned before the multi-wheel refactor: a `wheel` single
// field may exist on the old shape. Fold it into the wheels map as active.
{
  const legacy = (store as unknown as { wheel?: WheelConfig }).wheel;
  if (legacy && store.wheels.size === 0) {
    legacy.isActive ??= true;
    legacy.activeFrom ??= null;
    legacy.activeUntil ??= null;
    legacy.archivedAt ??= null;
    store.wheels.set(legacy.id, legacy);
  }
}

// Backfill wheel meta + lifecycle fields for every wheel.
for (const w of store.wheels.values()) {
  w.activeFrom ??= null;
  w.activeUntil ??= null;
  w.archivedAt ??= null;
  if (!wheelMeta.has(w.id)) {
    const now = new Date().toISOString();
    wheelMeta.set(w.id, { createdAt: now, updatedAt: now });
  }
}

// Backfill notes/tags/pity on any fan pinned before these fields existed.
for (const fan of store.fans.values()) {
  fan.notes ??= null;
  fan.tags ??= [];
  fan.pityCounter ??= 0;
}
// Backfill bonusSpins on any grant pinned before that field existed.
for (const grant of store.grants) {
  grant.bonusSpins ??= 0;
}
// Backfill pinnedWheelId on any campaign pinned before that field existed.
for (const campaign of store.campaigns) {
  campaign.pinnedWheelId ??= null;
}

if (!store.fans.has("demo-fan")) {
  const demoSpins = 5;
  store.fans.set("demo-fan", {
    id: "demo-fan",
    name: "Demo Fan",
    spinsRemaining: demoSpins,
    spinsGrantedTotal: demoSpins,
    primaryToken: "demo",
    wins: [],
    notes: null,
    tags: ["new"],
    pityCounter: 0,
  });
  store.tokens.set("demo", "demo-fan");
  // Seed a grant so revenue/per-campaign data is coherent in demo mode.
  store.grants.push({
    id: "g-demo",
    fanId: "demo-fan",
    campaignId: null,
    spins: demoSpins,
    amountCents: 0,
    bonusSpins: 0,
    at: new Date().toISOString(),
  });
}

function fanForToken(token: string): MockFan | null {
  const fanId = store.tokens.get(token);
  return fanId ? store.fans.get(fanId) ?? null : null;
}

// --- Wheel resolution -------------------------------------------------------

function wheelCreatedAt(id: string): string {
  return wheelMeta.get(id)?.createdAt ?? new Date(0).toISOString();
}

/** Wheels in creation order (oldest → newest). */
function wheelsByAge(): WheelConfig[] {
  return Array.from(store.wheels.values()).sort((a, b) =>
    wheelCreatedAt(a.id).localeCompare(wheelCreatedAt(b.id))
  );
}

/**
 * Resolve the wheel id that's "active right now" among non-archived wheels:
 *  1. window match (activeFrom <= now AND (activeUntil null OR > now)) — prefer
 *     the latest activeFrom, then the newest wheel;
 *  2. else the flagged isActive wheel;
 *  3. else the oldest wheel (always returns something if any wheel exists).
 */
export function mockResolveActiveWheelId(now: Date = new Date()): string {
  const live = wheelsByAge().filter((w) => !w.archivedAt);
  if (live.length === 0) {
    // Should never happen in demo mode, but stay defensive.
    return store.wheels.keys().next().value ?? SAMPLE_WHEEL.id;
  }

  const nowIso = now.toISOString();
  const windowed = live.filter(
    (w) =>
      w.activeFrom != null &&
      w.activeFrom <= nowIso &&
      (w.activeUntil == null || w.activeUntil > nowIso)
  );
  if (windowed.length > 0) {
    windowed.sort((a, b) => {
      const af = (a.activeFrom ?? "").localeCompare(b.activeFrom ?? "");
      if (af !== 0) return af; // later activeFrom last
      return wheelCreatedAt(a.id).localeCompare(wheelCreatedAt(b.id)); // newer last
    });
    return windowed[windowed.length - 1].id;
  }

  const flagged = live.find((w) => w.isActive);
  if (flagged) return flagged.id;

  return live[0].id; // oldest
}

/** The currently-active wheel config (always defined in demo mode). */
function activeWheel(): WheelConfig {
  const id = mockResolveActiveWheelId();
  return store.wheels.get(id) ?? wheelsByAge()[0];
}

/**
 * Resolve which wheel a fan's pass should use: a campaign pin (if the campaign
 * exists, has pinnedWheelId, and that wheel is non-archived) wins; otherwise
 * fall back to the active wheel.
 */
export function mockResolveWheelId(
  pass: { campaignId: string | null; wheelId?: string },
  now: Date = new Date()
): string {
  if (pass.campaignId) {
    const campaign = store.campaigns.find((c) => c.id === pass.campaignId);
    const pinned = campaign?.pinnedWheelId ?? null;
    if (pinned) {
      const w = store.wheels.get(pinned);
      if (w && !w.archivedAt) return pinned;
    }
  }
  return mockResolveActiveWheelId(now);
}

/** The campaign attached to a fan's primary token, if any. */
function campaignForFan(fan: MockFan): string | null {
  return store.tokenCampaign.get(fan.primaryToken) ?? null;
}

/** Lifecycle fields a WheelSummary needs, normalized. */
function toWheelSummary(w: WheelConfig): WheelSummary {
  const meta = wheelMeta.get(w.id);
  return {
    id: w.id,
    title: w.title,
    subtitle: w.subtitle ?? null,
    brandColor: w.brandColor ?? "#ec4899",
    isActive: w.id === mockResolveActiveWheelId(),
    archivedAt: w.archivedAt ?? null,
    activeFrom: w.activeFrom ?? null,
    activeUntil: w.activeUntil ?? null,
    prizeCount: w.prizes.length,
    updatedAt: meta?.updatedAt ?? new Date().toISOString(),
  };
}

// A fan's grants, oldest→newest (push order is creation order in the mock).
function fanGrants(fanId: string): MockGrant[] {
  return store.grants.filter((g) => g.fanId === fanId);
}

/**
 * FIFO-attribute the spin at 0-based index `playedBefore` to a campaign. Walk
 * the fan's grants oldest→newest, accumulating spins; the grant whose
 * cumulative range covers the index owns the spin. Returns null if the index
 * lies beyond every grant (i.e. an unfunded spin).
 */
function fifoCampaignForSpin(fanId: string, playedBefore: number): string | null {
  let cumulative = 0;
  for (const g of fanGrants(fanId)) {
    cumulative += g.spins;
    if (playedBefore < cumulative) return g.campaignId;
  }
  return null;
}

export function mockGetWheel(): WheelConfig {
  return structuredClone(activeWheel());
}

export function mockSaveWheel(config: WheelConfig): WheelConfig {
  // Save by id into the wheels map. If the id matches no existing wheel, treat
  // the save as targeting the active wheel (preserving its stable id).
  const targetId = store.wheels.has(config.id) ? config.id : activeWheel().id;
  const existing = store.wheels.get(targetId);
  const saved: WheelConfig = {
    ...structuredClone(config),
    id: targetId,
    // Preserve lifecycle/schedule fields unless the incoming config sets them.
    isActive: config.isActive ?? existing?.isActive,
    activeFrom: config.activeFrom ?? existing?.activeFrom ?? null,
    activeUntil: config.activeUntil ?? existing?.activeUntil ?? null,
    archivedAt: config.archivedAt ?? existing?.archivedAt ?? null,
  };
  store.wheels.set(targetId, saved);
  const meta = wheelMeta.get(targetId);
  const now = new Date().toISOString();
  if (meta) meta.updatedAt = now;
  else wheelMeta.set(targetId, { createdAt: now, updatedAt: now });
  return structuredClone(saved);
}

// --- Wheel management (multi-wheel) ----------------------------------------

/** Every wheel as a compact summary, newest first. */
export function mockListWheels(includeArchived = false): WheelSummary[] {
  const wheels = wheelsByAge()
    .slice()
    .reverse() // newest first
    .filter((w) => includeArchived || !w.archivedAt);
  return wheels.map((w) => structuredClone(toWheelSummary(w)));
}

/** A single wheel's full config by id, or null. */
export function mockGetWheelById(id: string): WheelConfig | null {
  const w = store.wheels.get(id);
  return w ? structuredClone(w) : null;
}

/**
 * Create a new wheel, seeded from a wheel template (if given) or SAMPLE_WHEEL.
 * Only the very first wheel in the store is created active.
 */
export function mockCreateWheel(opts?: {
  fromTemplateId?: string;
  name?: string;
}): { wheel: WheelConfig } {
  const isFirst = store.wheels.size === 0;
  const id = genId("wheel");
  const now = new Date().toISOString();

  let title: string;
  let subtitle: string | undefined;
  let brandColor: string;
  let prizes: Prize[];

  const tpl = opts?.fromTemplateId
    ? store.wheelTemplates.find((t) => t.id === opts.fromTemplateId)
    : undefined;
  if (tpl) {
    title = tpl.title;
    subtitle = tpl.subtitle;
    brandColor = tpl.brandColor;
    prizes = tpl.prizes.map((p) => ({ ...structuredClone(p), id: genId("prize") }));
  } else {
    const base = structuredClone(SAMPLE_WHEEL);
    title = base.title;
    subtitle = base.subtitle;
    brandColor = base.brandColor ?? "#ec4899";
    prizes = base.prizes.map((p) => ({ ...p, id: genId("prize") }));
  }

  const wheel: WheelConfig = {
    id,
    title: opts?.name?.trim() || title,
    subtitle,
    brandColor,
    prizes,
    isActive: isFirst,
    activeFrom: null,
    activeUntil: null,
    archivedAt: null,
  };
  store.wheels.set(id, wheel);
  wheelMeta.set(id, { createdAt: now, updatedAt: now });
  return { wheel: structuredClone(wheel) };
}

/** Duplicate an existing wheel (deep copy, " copy" suffix, inactive). */
export function mockDuplicateWheel(id: string): { wheel: WheelConfig } {
  const src = store.wheels.get(id) ?? activeWheel();
  const newId = genId("wheel");
  const now = new Date().toISOString();
  const wheel: WheelConfig = {
    ...structuredClone(src),
    id: newId,
    title: `${src.title} copy`,
    prizes: src.prizes.map((p) => ({ ...structuredClone(p), id: genId("prize") })),
    isActive: false,
    activeFrom: null,
    activeUntil: null,
    archivedAt: null,
  };
  store.wheels.set(newId, wheel);
  wheelMeta.set(newId, { createdAt: now, updatedAt: now });
  return { wheel: structuredClone(wheel) };
}

/**
 * Archive a wheel. If it was the active one, promote the oldest remaining
 * non-archived wheel to active so the creator always has a live wheel.
 */
export function mockArchiveWheel(id: string): { ok: true } | { error: string } {
  const wheel = store.wheels.get(id);
  if (!wheel) return { error: "not_found" };
  if (wheel.archivedAt) return { ok: true };

  const wasActive = wheel.isActive;
  wheel.archivedAt = new Date().toISOString();
  wheel.isActive = false;

  if (wasActive) {
    const remaining = wheelsByAge().filter((w) => !w.archivedAt);
    if (remaining.length > 0) remaining[0].isActive = true; // oldest remaining
  }
  return { ok: true };
}

/** Make a wheel the active one (clears the flag on all others). */
export function mockSetActiveWheel(id: string): { ok: true } | { error: string } {
  const wheel = store.wheels.get(id);
  if (!wheel) return { error: "not_found" };
  if (wheel.archivedAt) return { error: "archived" };
  for (const w of store.wheels.values()) w.isActive = false;
  wheel.isActive = true;
  return { ok: true };
}

/** Set (or clear) a wheel's scheduled active window. */
export function mockSetWheelSchedule(
  id: string,
  schedule: { activeFrom: string | null; activeUntil: string | null }
): { ok: true } | { error: string } {
  const wheel = store.wheels.get(id);
  if (!wheel) return { error: "not_found" };
  const { activeFrom, activeUntil } = schedule;
  if (activeFrom != null && activeUntil != null && activeUntil <= activeFrom) {
    return { error: "invalid_window" };
  }
  wheel.activeFrom = activeFrom;
  wheel.activeUntil = activeUntil;
  const meta = wheelMeta.get(id);
  if (meta) meta.updatedAt = new Date().toISOString();
  return { ok: true };
}

export function mockGetFanPass(token: string): FanPassView | null {
  const fan = fanForToken(token);
  if (!fan) return null;
  const wheelId = mockResolveWheelId({ campaignId: campaignForFan(fan) });
  const wheel = store.wheels.get(wheelId) ?? activeWheel();
  return structuredClone({
    token,
    fanName: fan.name,
    creatorTitle: CREATOR_TITLE,
    wheel,
    spinsRemaining: fan.spinsRemaining,
    recentWins: fan.wins,
  });
}

export function mockSpin(token: string) {
  const fan = fanForToken(token);
  if (!fan) return { error: "not_found" as const };
  if (fan.spinsRemaining <= 0) return { error: "no_spins" as const };

  // Resolve the wheel this fan's pass plays (campaign pin → active → fallback).
  const wheelId = mockResolveWheelId({ campaignId: campaignForFan(fan) });
  const wheel = store.wheels.get(wheelId) ?? activeWheel();

  const { prize, index, pityAwarded, nextPityCounter } = pickPrizeWithPity(wheel, {
    pityCounter: fan.pityCounter,
  });

  // FIFO-attribute THIS spin to a campaign: the 0-based index of this spin
  // among all the fan has played is the count played before it. Walk the fan's
  // grants oldest→newest, building cumulative spin ranges, and find the grant
  // whose range covers that index (null if beyond every grant).
  const playedBefore = fan.wins.length;
  const campaignId = fifoCampaignForSpin(fan.id, playedBefore);

  fan.spinsRemaining -= 1;
  fan.pityCounter = nextPityCounter;

  // Decrement limited stock on the RESOLVED wheel so rare prizes can sell out.
  const live = wheel.prizes[index];
  if (live && typeof live.stock === "number") live.stock -= 1;

  // Record the win on the fan account (persists across all their links).
  const at = new Date().toISOString();
  fan.wins = [
    {
      label: prize.label,
      rarity: prize.rarity,
      emoji: prize.emoji,
      color: prize.color ?? RARITY_COLORS[prize.rarity],
      at,
      campaignId,
    },
    ...fan.wins,
  ].slice(0, 50);

  // Add it to the creator's fulfilment queue (with fan + campaign attribution).
  store.redemptions.unshift({
    id: "r-" + Math.random().toString(36).slice(2, 10),
    fanName: fan.name,
    prizeLabel: prize.label,
    rarity: prize.rarity,
    emoji: prize.emoji,
    status: "pending",
    at,
    fanId: fan.id,
    campaignId,
  });

  return {
    prize: structuredClone(prize),
    prizeIndex: index,
    spinsRemaining: fan.spinsRemaining,
    pityAwarded,
  };
}

/**
 * Create a link. With no fanId, creates a NEW fan account. With an existing
 * fanId, mints a fresh link for that SAME account (history + balance kept) and
 * adds the granted spins on top.
 */
export function mockCreatePass(
  name: string,
  spins: number,
  fanId?: string,
  campaignId?: string,
  amountCents?: number,
  bonusSpins?: number,
  packId?: string
): { token: string; fanId: string } {
  // If a pack is supplied, its spins/amount/bonus are authoritative.
  let baseSpins = spins;
  let money = Math.max(0, Math.floor(amountCents ?? 0) || 0);
  let bonus = Math.max(0, Math.floor(bonusSpins ?? 0) || 0);
  if (packId) {
    const pack = store.campaignPacks.find((p) => p.id === packId);
    if (pack) {
      baseSpins = pack.spins;
      money = pack.amountCents;
      bonus = pack.bonusSpins;
    }
  }

  // Effective spins added = paid spins + bonus spins.
  const paid = Math.max(0, Math.floor(baseSpins) || 0);
  const add = paid + bonus;
  const fan = fanId ? store.fans.get(fanId) : undefined;

  const pushGrant = (id: string) => {
    store.grants.push({
      id: genId("g"),
      fanId: id,
      campaignId: campaignId ?? null,
      spins: add,
      amountCents: money,
      bonusSpins: bonus,
      at: new Date().toISOString(),
    });
  };

  if (!fan) {
    // New fan: create with a single minted token as the permanent link.
    const id = "fan-" + Math.random().toString(36).slice(2, 9);
    const token =
      ((name.trim() || "fan").toLowerCase().replace(/[^a-z0-9]+/g, "-") || "fan") +
      "-" +
      Math.random().toString(36).slice(2, 8);
    store.fans.set(id, {
      id,
      name: name.trim() || "Fan",
      spinsRemaining: add,
      spinsGrantedTotal: add,
      primaryToken: token,
      wins: [],
      notes: null,
      tags: [],
      pityCounter: 0,
    });
    store.tokens.set(token, id);
    if (campaignId) store.tokenCampaign.set(token, campaignId);
    pushGrant(id);
    return { token, fanId: id };
  }

  // Existing fan (top-up): add to balances, DON'T mint a new token, just grant.
  fan.spinsRemaining += add;
  fan.spinsGrantedTotal += add;
  pushGrant(fan.id);
  if (campaignId) store.tokenCampaign.set(fan.primaryToken, campaignId);
  return { token: fan.primaryToken, fanId: fan.id };
}

/** Top up spins on the fan account behind a token. */
export function mockGrantSpins(token: string, n: number) {
  const fan = fanForToken(token);
  if (!fan) return null;
  fan.spinsRemaining += Math.max(0, n);
  return fan.spinsRemaining;
}

/**
 * Permanently delete a fan account and everything linked to it: every token
 * pointing at the fan (and its campaign tag), the fan's grants, and the fan's
 * redemptions. Returns false if the fan doesn't exist.
 */
export function mockDeleteFan(fanId: string): boolean {
  if (!store.fans.has(fanId)) return false;
  store.fans.delete(fanId);
  for (const [token, id] of store.tokens) {
    if (id === fanId) {
      store.tokens.delete(token);
      store.tokenCampaign.delete(token);
    }
  }
  store.grants = store.grants.filter((g) => g.fanId !== fanId);
  store.redemptions = store.redemptions.filter((r) => r.fanId !== fanId);
  return true;
}

export function mockListFans(): FanAccountSummary[] {
  const tokensByFan = new Map<string, string[]>();
  for (const [token, fanId] of store.tokens) {
    (tokensByFan.get(fanId) ?? tokensByFan.set(fanId, []).get(fanId)!).push(token);
  }
  const campaignName = new Map(store.campaigns.map((c) => [c.id, c.name]));

  return Array.from(store.fans.values()).map((f) => {
    const grants = fanGrants(f.id);
    const totalSpent = grants.reduce((s, g) => s + g.amountCents, 0);
    const campaignNames: string[] = [];
    const seen = new Set<string>();
    for (const g of grants) {
      if (g.campaignId === null) continue;
      const name = campaignName.get(g.campaignId);
      if (name && !seen.has(g.campaignId)) {
        seen.add(g.campaignId);
        campaignNames.push(name);
      }
    }
    return {
      fanId: f.id,
      name: f.name,
      spinsRemaining: f.spinsRemaining,
      grantedTotal: f.spinsGrantedTotal,
      primaryToken: f.primaryToken,
      totalSpent,
      campaignNames,
      tags: f.tags ?? [],
      links: (tokensByFan.get(f.id) ?? []).map((token) => ({ token })),
      lastWin: f.wins[0]
        ? { label: f.wins[0].label, rarity: f.wins[0].rarity, at: f.wins[0].at }
        : null,
    };
  });
}

export function mockGetFanDetail(fanId: string): FanDetail | null {
  const fan = store.fans.get(fanId);
  if (!fan) return null;

  const rarityCounts = new Map<Rarity, number>();
  for (const w of fan.wins) {
    rarityCounts.set(w.rarity, (rarityCounts.get(w.rarity) ?? 0) + 1);
  }
  const winsByRarity = [...rarityCounts.entries()].map(([rarity, count]) => ({
    rarity,
    count,
  }));

  const grantedTotal = fan.spinsGrantedTotal;

  // Pending prizes: the mock store has no spin/fan_id link on redemptions, so we
  // match by fan NAME. Two fans sharing a name would collide here.
  const pendingPrizes = store.redemptions
    .filter((r) => r.fanName === fan.name && r.status === "pending")
    .map((r) => ({
      label: r.prizeLabel,
      rarity: r.rarity,
      emoji: r.emoji,
      at: r.at,
    }));

  // Links: every token pointing at this fan. The mock doesn't record link
  // creation time, so createdAt is a stable epoch placeholder.
  const links = Array.from(store.tokens.entries())
    .filter(([, id]) => id === fanId)
    .map(([token]) => ({ token, createdAt: new Date(0).toISOString() }));

  const campaignName = new Map(store.campaigns.map((c) => [c.id, c.name]));
  const myGrants = fanGrants(fanId);
  const totalSpent = myGrants.reduce((s, g) => s + g.amountCents, 0);

  // Grants newest-first, with campaign name resolved.
  const grants: Grant[] = myGrants
    .slice()
    .reverse()
    .map((g) => ({
      id: g.id,
      spins: g.spins,
      amountCents: g.amountCents,
      campaignId: g.campaignId,
      campaignName: g.campaignId ? campaignName.get(g.campaignId) ?? null : null,
      at: g.at,
    }));

  // Per-campaign breakdown: grant rollups (spinsBought, spentCents) merged with
  // spins attributed to each campaign (spinsPlayed + prizes from win records).
  // The bucket key is the campaignId, or "" for null-campaign grants/spins.
  interface Bucket {
    campaignId: string;
    name: string;
    spinsBought: number;
    spinsPlayed: number;
    spentCents: number;
    prizeCounts: Map<string, { label: string; rarity: Rarity; count: number }>;
  }
  const buckets = new Map<string, Bucket>();
  const bucketFor = (campaignId: string | null): Bucket => {
    const key = campaignId ?? "";
    let b = buckets.get(key);
    if (!b) {
      b = {
        campaignId: key,
        name: campaignId ? campaignName.get(campaignId) ?? "Uncategorized" : "Uncategorized",
        spinsBought: 0,
        spinsPlayed: 0,
        spentCents: 0,
        prizeCounts: new Map(),
      };
      buckets.set(key, b);
    }
    return b;
  };

  for (const g of myGrants) {
    const b = bucketFor(g.campaignId);
    b.spinsBought += g.spins;
    b.spentCents += g.amountCents;
  }
  for (const w of fan.wins) {
    const b = bucketFor(w.campaignId);
    b.spinsPlayed += 1;
    const cur = b.prizeCounts.get(w.label);
    if (cur) cur.count += 1;
    else b.prizeCounts.set(w.label, { label: w.label, rarity: w.rarity, count: 1 });
  }

  const byCampaign: FanCampaignBreakdown[] = [...buckets.values()].map((b) => ({
    campaignId: b.campaignId,
    name: b.name,
    spinsBought: b.spinsBought,
    spinsPlayed: b.spinsPlayed,
    spentCents: b.spentCents,
    prizes: [...b.prizeCounts.values()],
  }));

  return {
    fanId: fan.id,
    name: fan.name,
    notes: fan.notes ?? null,
    tags: fan.tags ?? [],
    spinsRemaining: fan.spinsRemaining,
    grantedTotal,
    totalSpins: fan.wins.length,
    totalSpent,
    lastActive: fan.wins[0]?.at ?? null,
    winsByRarity,
    pendingPrizes,
    links,
    grants,
    byCampaign,
  };
}

/** Patch a fan's notes and/or tags in place. */
export function mockUpdateFanMeta(
  fanId: string,
  patch: { notes?: string | null; tags?: string[] }
): { ok: true } | { error: string } {
  const fan = store.fans.get(fanId);
  if (!fan) return { error: "not_found" };
  if ("notes" in patch) fan.notes = patch.notes ?? null;
  if (patch.tags) fan.tags = patch.tags;
  return { ok: true };
}

export function mockGetOverview(): CreatorOverview {
  const redemptions = store.redemptions;
  const revenue = store.grants.reduce((s, g) => s + g.amountCents, 0);
  // Map internal redemptions back to plain RedemptionItem (drop fanId/campaignId).
  const items: RedemptionItem[] = redemptions.slice(0, 200).map((r) => ({
    id: r.id,
    fanName: r.fanName,
    prizeLabel: r.prizeLabel,
    rarity: r.rarity,
    emoji: r.emoji,
    status: r.status,
    at: r.at,
  }));
  return {
    metrics: {
      fans: store.fans.size,
      spinsPlayed: redemptions.length,
      pending: redemptions.filter((r) => r.status === "pending").length,
      fulfilled: redemptions.filter((r) => r.status === "fulfilled").length,
      revenue,
    },
    redemptions: structuredClone(items),
  };
}

export function mockGetMetricsExtra(days: number): CreatorMetricsExtra {
  const n = clampDays(days);
  const trend = bucketByDay(
    store.redemptions.map((r) => r.at),
    n
  );
  const revenueTrend = bucketCentsByDay(
    store.grants.map((g) => ({ at: g.at, cents: g.amountCents })),
    n
  );
  return {
    trend,
    funnel: {
      // "Opened" isn't tracked — funnel runs links → spun → fulfilled.
      links: store.tokens.size,
      spun: store.redemptions.length,
      fulfilled: store.redemptions.filter((r) => r.status === "fulfilled").length,
    },
    revenueTrend,
  };
}

export function mockSetRedemptionStatus(id: string, status: RedemptionStatus) {
  const r = store.redemptions.find((x) => x.id === id);
  if (!r) return null;
  r.status = status;
  return r;
}

// --- Campaigns --------------------------------------------------------------

export function mockCreateCampaign(
  name: string,
  pinnedWheelId?: string | null
): Campaign {
  const campaign: Campaign = {
    id: "camp-" + Math.random().toString(36).slice(2, 9),
    name: name.trim() || "Campaign",
    isActive: true,
    createdAt: new Date().toISOString(),
    pinnedWheelId: pinnedWheelId ?? null,
  };
  store.campaigns.unshift(campaign);
  return structuredClone(campaign);
}

/** Pin (or unpin) a campaign's default wheel. */
export function mockSetCampaignPinnedWheel(
  campaignId: string,
  wheelId: string | null
): { ok: true } | { error: string } {
  const campaign = store.campaigns.find((c) => c.id === campaignId);
  if (!campaign) return { error: "not_found" };
  if (wheelId !== null && !store.wheels.has(wheelId)) {
    return { error: "wheel_not_found" };
  }
  campaign.pinnedWheelId = wheelId;
  return { ok: true };
}

export function mockListCampaigns(): Campaign[] {
  // Already stored newest-first.
  return structuredClone(store.campaigns);
}

export function mockGetCampaignStats(): CampaignStats[] {
  // Pre-collect every win across all fans (each carries its FIFO campaignId).
  const allWins: MockWin[] = [];
  for (const f of store.fans.values()) allWins.push(...f.wins);

  return store.campaigns.map((campaign) => {
    const grants = store.grants.filter((g) => g.campaignId === campaign.id);
    const spinsBought = grants.reduce((s, g) => s + g.spins, 0);
    const revenue = grants.reduce((s, g) => s + g.amountCents, 0);
    const uniqueFans = new Set(grants.map((g) => g.fanId)).size;

    const campaignWins = allWins.filter((w) => w.campaignId === campaign.id);
    const spinsPlayed = campaignWins.length;

    const fulfilled = store.redemptions.filter(
      (r) => r.status === "fulfilled" && r.campaignId === campaign.id
    ).length;

    // Top prize: the mode of this campaign's attributed wins (carrying rarity).
    const counts = new Map<string, { label: string; rarity: Rarity; count: number }>();
    for (const w of campaignWins) {
      const cur = counts.get(w.label);
      if (cur) cur.count += 1;
      else counts.set(w.label, { label: w.label, rarity: w.rarity, count: 1 });
    }
    let topPrize: { label: string; rarity: Rarity; count: number } | null = null;
    for (const entry of counts.values()) {
      if (!topPrize || entry.count > topPrize.count) topPrize = entry;
    }

    const arpu = uniqueFans ? Math.round(revenue / uniqueFans) : 0;

    return {
      campaign: structuredClone(campaign),
      spinsBought,
      spinsPlayed,
      uniqueFans,
      fulfilled,
      revenue,
      arpu,
      topPrize,
    };
  });
}

// --- Campaign packs (purchasable spin presets) ------------------------------

/** Packs, optionally filtered to a campaign (or globals), ordered by sortOrder. */
export function mockListCampaignPacks(campaignId?: string): CampaignPack[] {
  const packs = store.campaignPacks
    .filter((p) =>
      campaignId === undefined ? true : p.campaignId === campaignId
    )
    .slice()
    .sort((a, b) => a.sortOrder - b.sortOrder);
  return structuredClone(packs);
}

export function mockCreateCampaignPack(input: {
  campaignId?: string | null;
  label: string;
  spins: number;
  amountCents: number;
  bonusSpins?: number;
  sortOrder?: number;
}): CampaignPack {
  const pack: CampaignPack = {
    id: genId("pack"),
    campaignId: input.campaignId ?? null,
    label: input.label.trim() || "Pack",
    spins: Math.max(0, Math.floor(input.spins) || 0),
    amountCents: Math.max(0, Math.floor(input.amountCents) || 0),
    bonusSpins: Math.max(0, Math.floor(input.bonusSpins ?? 0) || 0),
    sortOrder:
      input.sortOrder ??
      store.campaignPacks.reduce((max, p) => Math.max(max, p.sortOrder + 1), 0),
    createdAt: new Date().toISOString(),
  };
  store.campaignPacks.push(pack);
  return structuredClone(pack);
}

export function mockUpdateCampaignPack(
  id: string,
  patch: Partial<Pick<CampaignPack, "label" | "spins" | "amountCents" | "bonusSpins" | "sortOrder" | "campaignId">>
): { ok: true } | { error: string } {
  const pack = store.campaignPacks.find((p) => p.id === id);
  if (!pack) return { error: "not_found" };
  if (patch.label !== undefined) pack.label = patch.label.trim() || pack.label;
  if (patch.spins !== undefined) pack.spins = Math.max(0, Math.floor(patch.spins) || 0);
  if (patch.amountCents !== undefined)
    pack.amountCents = Math.max(0, Math.floor(patch.amountCents) || 0);
  if (patch.bonusSpins !== undefined)
    pack.bonusSpins = Math.max(0, Math.floor(patch.bonusSpins) || 0);
  if (patch.sortOrder !== undefined) pack.sortOrder = patch.sortOrder;
  if (patch.campaignId !== undefined) pack.campaignId = patch.campaignId;
  return { ok: true };
}

export function mockDeleteCampaignPack(id: string): { ok: true } | { error: string } {
  const before = store.campaignPacks.length;
  store.campaignPacks = store.campaignPacks.filter((p) => p.id !== id);
  return store.campaignPacks.length < before ? { ok: true } : { error: "not_found" };
}

// --- Prize templates (reusable prizes) --------------------------------------

export function mockListPrizeTemplates(): PrizeTemplate[] {
  // Newest first.
  return structuredClone(
    store.prizeTemplates
      .slice()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  );
}

export function mockCreatePrizeTemplate(input: {
  label: string;
  rarity: Rarity;
  weight: number;
  description?: string;
  color?: string;
  emoji?: string;
}): PrizeTemplate {
  const tpl: PrizeTemplate = {
    id: genId("ptpl"),
    label: input.label.trim() || "Prize",
    rarity: input.rarity,
    weight: Math.max(0, Math.floor(input.weight) || 0),
    description: input.description,
    color: input.color ?? RARITY_COLORS[input.rarity],
    emoji: input.emoji,
    createdAt: new Date().toISOString(),
  };
  store.prizeTemplates.unshift(tpl);
  return structuredClone(tpl);
}

export function mockDeletePrizeTemplate(id: string): { ok: true } | { error: string } {
  const before = store.prizeTemplates.length;
  store.prizeTemplates = store.prizeTemplates.filter((t) => t.id !== id);
  return store.prizeTemplates.length < before ? { ok: true } : { error: "not_found" };
}

// --- Wheel templates (reusable wheel presets) -------------------------------

export function mockListWheelTemplates(): WheelTemplate[] {
  // Newest first.
  return structuredClone(
    store.wheelTemplates
      .slice()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  );
}

/**
 * Create a wheel template, either from an existing wheel (ids stripped) or from
 * an inline config. `fromWheelId` wins if both are supplied.
 */
export function mockCreateWheelTemplate(input: {
  name: string;
  fromWheelId?: string;
  config?: { title: string; subtitle?: string; brandColor?: string; prizes: Omit<Prize, "id">[] };
}): WheelTemplate {
  let title = "Wheel";
  let subtitle: string | undefined;
  let brandColor = "#ec4899";
  let prizes: Omit<Prize, "id">[] = [];

  const source = input.fromWheelId ? store.wheels.get(input.fromWheelId) : undefined;
  if (source) {
    title = source.title;
    subtitle = source.subtitle;
    brandColor = source.brandColor ?? "#ec4899";
    prizes = source.prizes.map(({ id: _id, ...rest }) => structuredClone(rest));
  } else if (input.config) {
    title = input.config.title;
    subtitle = input.config.subtitle;
    brandColor = input.config.brandColor ?? "#ec4899";
    prizes = input.config.prizes.map((p) => structuredClone(p));
  }

  const tpl: WheelTemplate = {
    id: genId("wtpl"),
    name: input.name.trim() || "Template",
    title,
    subtitle,
    brandColor,
    prizes,
    createdAt: new Date().toISOString(),
  };
  store.wheelTemplates.unshift(tpl);
  return structuredClone(tpl);
}

export function mockDeleteWheelTemplate(id: string): { ok: true } | { error: string } {
  const before = store.wheelTemplates.length;
  store.wheelTemplates = store.wheelTemplates.filter((t) => t.id !== id);
  return store.wheelTemplates.length < before ? { ok: true } : { error: "not_found" };
}

// --- Admin -----------------------------------------------------------------

export function mockGetAdminOverview(): AdminOverview {
  // Keep the "You" account's live numbers in sync with real demo activity.
  const you = store.accounts.find((a) => a.id === "acc-you");
  if (you) {
    you.fans = store.fans.size;
    you.spins = store.redemptions.length;
    you.pending = store.redemptions.filter((r) => r.status === "pending").length;
  }

  // Show ALL accounts — admins included (an account can be promoted to admin
  // and must still appear in the panel).
  const accounts = structuredClone(store.accounts);
  return {
    metrics: {
      creators: accounts.length,
      fans: accounts.reduce((s, a) => s + a.fans, 0),
      spins: accounts.reduce((s, a) => s + a.spins, 0),
      pending: accounts.reduce((s, a) => s + a.pending, 0),
    },
    accounts,
  };
}

export function mockUpdateAccount(
  id: string,
  patch: Partial<Pick<AdminAccount, "role" | "isActive" | "features">>
) {
  const acc = store.accounts.find((a) => a.id === id);
  if (!acc) return null;
  if (patch.role) acc.role = patch.role;
  if (typeof patch.isActive === "boolean") acc.isActive = patch.isActive;
  if (patch.features) acc.features = { ...acc.features, ...patch.features };
  return structuredClone(acc);
}

// --- DM templates -----------------------------------------------------------

export function mockListDmTemplates(): DmTemplate[] {
  // Already stored newest-first.
  return structuredClone(store.dmTemplates);
}

export function mockCreateDmTemplate(title: string, body: string): DmTemplate {
  const template: DmTemplate = {
    id: "dm-" + Math.random().toString(36).slice(2, 9),
    title: title.trim() || "Template",
    body,
    createdAt: new Date().toISOString(),
  };
  store.dmTemplates.unshift(template);
  return structuredClone(template);
}

export function mockDeleteDmTemplate(id: string): boolean {
  const before = store.dmTemplates.length;
  store.dmTemplates = store.dmTemplates.filter((t) => t.id !== id);
  return store.dmTemplates.length < before;
}

// --- Admin (account creation) -----------------------------------------------

export function mockCreateAccount(email: string, displayName: string) {
  const acc: AdminAccount = {
    id: "acc-" + Math.random().toString(36).slice(2, 9),
    email,
    displayName: displayName || email,
    role: "creator",
    isActive: true,
    features: defaultFeatures(),
    wheels: 0,
    fans: 0,
    spins: 0,
    pending: 0,
  };
  store.accounts.push(acc);
  return structuredClone(acc);
}
