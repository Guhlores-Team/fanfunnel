import assert from "node:assert/strict";
import { mock } from "node:test";

// WC-13: a live link whose creator is suspended / deactivated / unapproved is
// reported as "creator_paused" (the fan page's "this link is closed" state),
// never a bare 404; a tombstone still wins. OPS3-02: the fan reads are bounded.
let passed = 0;
const check = (label: string, ok: unknown) => { assert.ok(ok, label); passed++; };

let tomb: string | null = null;
let creator: Record<string, unknown> | null = { is_active: true, approval_status: "approved", role: "creator" };
let passExists = true;
let expiresAt: string | null = null;
const timeouts: (number | undefined)[] = [];
function fakeClient(opts?: { timeoutMs?: number }) {
  timeouts.push(opts?.timeoutMs);
  const from = (table: string) => {
    const proxy: unknown = new Proxy({}, {
      get(_t, prop) {
        if (prop === "then") return (res: (v: unknown) => unknown) => {
          if (table === "link_tombstones") return Promise.resolve({ data: tomb ? { reason: tomb } : null, error: null }).then(res);
          if (table === "fan_passes") return Promise.resolve({ data: passExists ? { creator, expires_at: expiresAt } : null, error: null }).then(res);
          throw new Error(`unexpected read of ${table}`);
        };
        return () => proxy;
      },
    });
    return proxy;
  };
  return { from };
}
mock.module("@/lib/supabase/server", { namedExports: { isSupabaseConfigured: () => true, createClient: async () => fakeClient(), createServiceClient: (o?: { timeoutMs?: number }) => fakeClient(o) } });

async function main() {
  const { getFanLinkStatus } = await import("./privacy");
  const { FAN_READ_TIMEOUT_MS, FAN_PAGE_DEADLINE_MS, SPIN_RPC_TIMEOUT_MS, withFanDeadline, FanPassUnavailableError, isMissingColumnError } = await import("./unavailable");
  const token = "fan-token-closed-0001";
  check("an active approved creator's live link has no closure status", (await getFanLinkStatus(token)) === null);
  check("the privacy read is bounded by FAN_READ_TIMEOUT_MS", timeouts.every((t) => t === FAN_READ_TIMEOUT_MS));
  for (const [label, row] of [
    ["suspended", { is_active: false, approval_status: "approved", role: "creator" }],
    ["unapproved", { is_active: true, approval_status: "pending", role: "creator" }],
    ["rejected", { is_active: true, approval_status: "rejected", role: "creator" }],
    ["missing profile", null],
  ] as const) {
    creator = row;
    check(`WC-13: ${label} creator → creator_paused`, (await getFanLinkStatus(token)) === "creator_paused");
  }
  // PR-13 (0073): an expired link is over for good, never "closed right now".
  expiresAt = new Date(Date.now() - 1000).toISOString();
  check("PR-13: an expired link of a suspended creator is not creator_paused (it is the 404 with data controls)", (await getFanLinkStatus(token)) === null);
  expiresAt = new Date(Date.now() + 60_000).toISOString();
  check("PR-13: a link that expires later still reports creator_paused", (await getFanLinkStatus(token)) === "creator_paused");
  expiresAt = null;
  const { fanLinkExpired } = await import("./unavailable");
  const NOW = Date.parse("2026-11-10T00:00:00Z");
  check("fanLinkExpired mirrors the SQL (expires_at <= now), null never expires, an unreadable date fails closed",
    !fanLinkExpired(null, NOW) && !fanLinkExpired(undefined, NOW) && fanLinkExpired("2026-11-09T23:59:59Z", NOW) && fanLinkExpired("2026-11-10T00:00:00Z", NOW) && !fanLinkExpired("2026-11-10T00:00:01Z", NOW) && fanLinkExpired("garbage", NOW));
  tomb = "creator_closed";
  check("a tombstone still wins over the standing read", (await getFanLinkStatus(token)) === "creator_closed");
  tomb = "fan_deleted";
  check("…for a deleted fan too", (await getFanLinkStatus(token)) === "fan_deleted");
  tomb = null; passExists = false;
  check("an unknown token stays null (the 404)", (await getFanLinkStatus(token)) === null);
  check("an implausible token never reads", (await getFanLinkStatus("../x")) === null);

  // OPS3-02 constants and the deadline helper.
  check("fan read deadlines are a few seconds, under the page cap, under maxDuration", FAN_READ_TIMEOUT_MS === 4000 && FAN_PAGE_DEADLINE_MS === 10_000 && SPIN_RPC_TIMEOUT_MS === 8000);
  let thrown: unknown = null;
  const t = Date.now();
  // The deadline timer is unref'd (a serverless process must not be held by
  // it), so keep the event loop alive here or node exits silently before it fires.
  const keepAlive = setInterval(() => undefined, 10);
  try { await withFanDeadline(new Promise(() => undefined), 60, "x"); } catch (e) { thrown = e; } finally { clearInterval(keepAlive); }
  check("withFanDeadline throws FanPassUnavailableError once the deadline passes", thrown instanceof FanPassUnavailableError && Date.now() - t < 1000);
  check("…and passes a value through otherwise", (await withFanDeadline(Promise.resolve(7), 60, "x")) === 7);
  check("only a missing column is a fallback-worthy error", isMissingColumnError({ code: "42703" }) && isMissingColumnError({ message: "column spins.kind does not exist" }) && !isMissingColumnError({ code: "", message: "AbortError: This operation was aborted" }) && !isMissingColumnError(null));

  // Static: the fan routes carry maxDuration and the spin RPC client is timed.
  const { readFileSync } = await import("node:fs");
  const root = new URL("../../../", import.meta.url);
  for (const [f, secs] of [["src/app/spin/[token]/page.tsx", 15], ["src/app/verify/[shareId]/page.tsx", 15], ["src/app/leaderboard/[creatorId]/page.tsx", 15], ["src/app/api/spin/route.ts", 30], ["src/app/api/spin/status/route.ts", 30]] as const) {
    check(`${f} exports maxDuration = ${secs}`, new RegExp(`export const maxDuration = ${secs};`).test(readFileSync(new URL(f, root), "utf8")));
  }
  const spins = readFileSync(new URL("src/lib/data/spins.ts", root), "utf8");
  check("spin() uses a client bounded by SPIN_RPC_TIMEOUT_MS", /createServiceClient\(\{ timeoutMs: SPIN_RPC_TIMEOUT_MS \}\)/.test(spins.slice(spins.indexOf("export async function spin("))));
  const pwa = readFileSync(new URL("src/lib/data/pwa.ts", root), "utf8");
  check("the manifest/icon read shares the page's cached fan_passes read", /readFanPassRow\(token\)/.test(pwa) && !/\.from\("fan_passes"\)/.test(pwa));
  const boosts = readFileSync(new URL("src/lib/data/boosts.ts", root), "utf8");
  check("verify and leaderboard reads are bounded and throw on a fault", (boosts.match(/createServiceClient\(\{ timeoutMs: FAN_READ_TIMEOUT_MS \}\)/g) ?? []).length >= 2 && /if \(readFailed\(res\.error\)\) throw new FanPassUnavailableError/.test(boosts));
  console.log(`fan link closed / fan read deadlines: ${passed} checks passed`);
}
main().catch((e) => { console.error(e); process.exit(1); });
