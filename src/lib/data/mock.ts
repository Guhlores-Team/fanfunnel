import { pickPrize } from "@/lib/games/wheel/engine";
import { SAMPLE_WHEEL } from "@/lib/games/wheel/sample";
import { RARITY_COLORS, type WheelConfig } from "@/lib/games/wheel/types";
import type { FanPassView, WonPrize } from "./types";

// In-memory demo store. Used automatically when Supabase env vars are absent,
// so `npm run dev` gives a fully working wheel with zero setup. State resets
// when the dev server restarts.
//
// IMPORTANT: balance + win history live on the FAN (not the link), mirroring
// production. Many tokens can point at one fan; they all share its account.

interface MockFan {
  id: string;
  name: string;
  creatorTitle: string;
  wheel: WheelConfig;
  spinsRemaining: number;
  wins: WonPrize[];
}

interface Store {
  fans: Map<string, MockFan>; // fanId -> fan
  tokens: Map<string, string>; // token -> fanId
}

// Pin to globalThis so the store is shared across every Next.js entry point
// (pages and route handlers are bundled separately).
const g = globalThis as unknown as { __ffStore?: Store };
const store: Store =
  g.__ffStore ??
  (g.__ffStore = { fans: new Map(), tokens: new Map() });

if (!store.fans.has("demo-fan")) {
  store.fans.set("demo-fan", {
    id: "demo-fan",
    name: "Demo Fan",
    creatorTitle: "Demo Creator",
    wheel: structuredClone(SAMPLE_WHEEL),
    spinsRemaining: 5,
    wins: [],
  });
  store.tokens.set("demo", "demo-fan");
}

function fanForToken(token: string): MockFan | null {
  const fanId = store.tokens.get(token);
  return fanId ? store.fans.get(fanId) ?? null : null;
}

function viewOf(token: string, fan: MockFan): FanPassView {
  return {
    token,
    fanName: fan.name,
    creatorTitle: fan.creatorTitle,
    wheel: fan.wheel,
    spinsRemaining: fan.spinsRemaining,
    recentWins: fan.wins,
  };
}

export function mockGetFanPass(token: string): FanPassView | null {
  const fan = fanForToken(token);
  return fan ? structuredClone(viewOf(token, fan)) : null;
}

export function mockSpin(token: string) {
  const fan = fanForToken(token);
  if (!fan) return { error: "not_found" as const };
  if (fan.spinsRemaining <= 0) return { error: "no_spins" as const };

  const { prize, index } = pickPrize(fan.wheel);
  fan.spinsRemaining -= 1;

  // Decrement limited stock so rare prizes can sell out.
  const live = fan.wheel.prizes[index];
  if (typeof live.stock === "number") live.stock -= 1;

  // Record the win on the fan account (persists across all their links).
  fan.wins = [
    {
      label: prize.label,
      rarity: prize.rarity,
      emoji: prize.emoji,
      color: prize.color ?? RARITY_COLORS[prize.rarity],
      at: new Date().toISOString(),
    },
    ...fan.wins,
  ].slice(0, 50);

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
    fan = {
      id,
      name: name.trim() || "Fan",
      creatorTitle: "Demo Creator",
      wheel: structuredClone(SAMPLE_WHEEL),
      spinsRemaining: add,
      wins: [],
    };
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
