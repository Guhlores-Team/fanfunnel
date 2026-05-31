import { pickPrize } from "@/lib/games/wheel/engine";
import { SAMPLE_WHEEL } from "@/lib/games/wheel/sample";
import { RARITY_COLORS, type Rarity, type WheelConfig } from "@/lib/games/wheel/types";
import { defaultFeatures } from "@/lib/features";
import type {
  AdminAccount,
  AdminOverview,
  CreatorMetricsExtra,
  CreatorOverview,
  FanAccountSummary,
  FanDetail,
  FanPassView,
  RedemptionItem,
  RedemptionStatus,
  WonPrize,
} from "./types";
import { bucketByDay, clampDays } from "./metrics";

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

interface MockFan {
  id: string;
  name: string;
  spinsRemaining: number;
  wins: WonPrize[];
}

interface Store {
  wheel: WheelConfig; // the creator's editable wheel
  fans: Map<string, MockFan>; // fanId -> fan
  tokens: Map<string, string>; // token -> fanId
  redemptions: RedemptionItem[]; // creator-wide fulfilment queue (newest first)
  accounts: AdminAccount[]; // demo creator/admin accounts for the admin panel
}

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

// Pin to globalThis so the store is shared across every Next.js entry point
// (pages and route handlers are bundled separately).
const g = globalThis as unknown as { __ffStore?: Store };
const store: Store =
  g.__ffStore ??
  (g.__ffStore = {
    wheel: structuredClone(SAMPLE_WHEEL),
    fans: new Map(),
    tokens: new Map(),
    redemptions: [],
    accounts: seedAccounts(),
  });

if (!store.fans.has("demo-fan")) {
  store.fans.set("demo-fan", {
    id: "demo-fan",
    name: "Demo Fan",
    spinsRemaining: 5,
    wins: [],
  });
  store.tokens.set("demo", "demo-fan");
}

function fanForToken(token: string): MockFan | null {
  const fanId = store.tokens.get(token);
  return fanId ? store.fans.get(fanId) ?? null : null;
}

export function mockGetWheel(): WheelConfig {
  return structuredClone(store.wheel);
}

export function mockSaveWheel(config: WheelConfig): WheelConfig {
  // Preserve the stable wheel id; everything else is editable.
  store.wheel = { ...structuredClone(config), id: store.wheel.id };
  return structuredClone(store.wheel);
}

export function mockGetFanPass(token: string): FanPassView | null {
  const fan = fanForToken(token);
  if (!fan) return null;
  return structuredClone({
    token,
    fanName: fan.name,
    creatorTitle: CREATOR_TITLE,
    wheel: store.wheel,
    spinsRemaining: fan.spinsRemaining,
    recentWins: fan.wins,
  });
}

export function mockSpin(token: string) {
  const fan = fanForToken(token);
  if (!fan) return { error: "not_found" as const };
  if (fan.spinsRemaining <= 0) return { error: "no_spins" as const };

  const { prize, index } = pickPrize(store.wheel);
  fan.spinsRemaining -= 1;

  // Decrement limited stock on the shared wheel so rare prizes can sell out.
  const live = store.wheel.prizes[index];
  if (typeof live.stock === "number") live.stock -= 1;

  // Record the win on the fan account (persists across all their links).
  const at = new Date().toISOString();
  fan.wins = [
    {
      label: prize.label,
      rarity: prize.rarity,
      emoji: prize.emoji,
      color: prize.color ?? RARITY_COLORS[prize.rarity],
      at,
    },
    ...fan.wins,
  ].slice(0, 50);

  // Add it to the creator's fulfilment queue.
  store.redemptions.unshift({
    id: "r-" + Math.random().toString(36).slice(2, 10),
    fanName: fan.name,
    prizeLabel: prize.label,
    rarity: prize.rarity,
    emoji: prize.emoji,
    status: "pending",
    at,
  });

  return {
    prize: structuredClone(prize),
    prizeIndex: index,
    spinsRemaining: fan.spinsRemaining,
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
  fanId?: string
): { token: string; fanId: string } {
  const add = Math.max(0, spins);
  let fan = fanId ? store.fans.get(fanId) : undefined;

  if (!fan) {
    const id = "fan-" + Math.random().toString(36).slice(2, 9);
    fan = { id, name: name.trim() || "Fan", spinsRemaining: add, wins: [] };
    store.fans.set(id, fan);
  } else {
    fan.spinsRemaining += add;
  }

  const token =
    (fan.name.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "fan") +
    "-" +
    Math.random().toString(36).slice(2, 8);
  store.tokens.set(token, fan.id);
  return { token, fanId: fan.id };
}

/** Top up spins on the fan account behind a token. */
export function mockGrantSpins(token: string, n: number) {
  const fan = fanForToken(token);
  if (!fan) return null;
  fan.spinsRemaining += Math.max(0, n);
  return fan.spinsRemaining;
}

export function mockListFans(): FanAccountSummary[] {
  const tokensByFan = new Map<string, string[]>();
  for (const [token, fanId] of store.tokens) {
    (tokensByFan.get(fanId) ?? tokensByFan.set(fanId, []).get(fanId)!).push(token);
  }
  return Array.from(store.fans.values()).map((f) => ({
    fanId: f.id,
    name: f.name,
    spinsRemaining: f.spinsRemaining,
    grantedTotal: f.spinsRemaining,
    links: (tokensByFan.get(f.id) ?? []).map((token) => ({ token })),
    lastWin: f.wins[0]
      ? { label: f.wins[0].label, rarity: f.wins[0].rarity, at: f.wins[0].at }
      : null,
  }));
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

  // The mock has no separate granted total — reuse the remaining balance.
  const grantedTotal = fan.spinsRemaining;

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

  return {
    fanId: fan.id,
    name: fan.name,
    spinsRemaining: fan.spinsRemaining,
    grantedTotal,
    totalSpins: fan.wins.length,
    lastActive: fan.wins[0]?.at ?? null,
    winsByRarity,
    pendingPrizes,
    links,
  };
}

export function mockGetOverview(): CreatorOverview {
  const redemptions = store.redemptions;
  return {
    metrics: {
      fans: store.fans.size,
      spinsPlayed: redemptions.length,
      pending: redemptions.filter((r) => r.status === "pending").length,
      fulfilled: redemptions.filter((r) => r.status === "fulfilled").length,
    },
    redemptions: structuredClone(redemptions).slice(0, 200),
  };
}

export function mockGetMetricsExtra(days: number): CreatorMetricsExtra {
  const n = clampDays(days);
  const trend = bucketByDay(
    store.redemptions.map((r) => r.at),
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
  };
}

export function mockSetRedemptionStatus(id: string, status: RedemptionStatus) {
  const r = store.redemptions.find((x) => x.id === id);
  if (!r) return null;
  r.status = status;
  return r;
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
