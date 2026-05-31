import { pickPrize } from "@/lib/games/wheel/engine";
import { SAMPLE_WHEEL } from "@/lib/games/wheel/sample";
import { RARITY_COLORS, type WheelConfig } from "@/lib/games/wheel/types";
import type {
  CreatorOverview,
  FanPassView,
  RedemptionItem,
  RedemptionStatus,
  WonPrize,
} from "./types";

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

export function mockSetRedemptionStatus(id: string, status: RedemptionStatus) {
  const r = store.redemptions.find((x) => x.id === id);
  if (!r) return null;
  r.status = status;
  return r;
}
