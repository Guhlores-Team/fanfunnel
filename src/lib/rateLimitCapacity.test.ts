import assert from "node:assert/strict";
import { RATE_LIMIT_EVICT_BATCH, RATE_LIMIT_MAX_WINDOWS, hasSharedRateLimitStore, rateLimit, sharedRateLimitStoreMissing } from "./rateLimit";

// A22 follow-up: the in-memory limiter is bounded, but a full table must not
// turn into a 429 for every new client until a window expires (about 150 route
// scopes x client IPs can fill it with legitimate traffic). At capacity it
// fails open on capacity and never on the count: it evicts windows still under
// their limit first, then the soonest to reset, so a blocked caller stays
// blocked and a flood of fresh keys cannot reset it.

const store = (globalThis as unknown as { __ffRateLimit: Map<string, unknown> }).__ffRateLimit;
let checks = 0;
const check = (cond: unknown, label: string) => { assert.ok(cond, label); checks++; };

let now = 5_000_000;
const clock = () => now;
store.clear();

// A blocked attacker key, then a table full of ordinary (under-limit) callers.
check(rateLimit("attacker", 1, 60_000, clock).ok, "the attacker's first call passes");
check(!rateLimit("attacker", 1, 60_000, clock).ok, "…the second is blocked");
for (let i = 1; store.size < RATE_LIMIT_MAX_WINDOWS; i++) rateLimit(`visitor:${i}`, 100, 60_000, clock);
check(store.size === RATE_LIMIT_MAX_WINDOWS, "the table is full");

let refused = 0;
for (let i = 0; i < 3 * RATE_LIMIT_EVICT_BATCH; i++) if (!rateLimit(`fresh:${i}`, 100, 60_000, clock).ok) refused++;
check(refused === 0, "a full table never refuses a new client's first request");
check(store.size <= RATE_LIMIT_MAX_WINDOWS, "memory stays bounded while new keys keep arriving");
check(!rateLimit("attacker", 1, 60_000, clock).ok, "a flood of fresh keys does not evict a blocked caller's window");
check(!rateLimit("attacker", 1, 60_000, clock).ok, "…on any later call within the window");

// Every window blocked: the soonest to reset goes first, later ones stay.
store.clear();
for (let i = 0; i < RATE_LIMIT_MAX_WINDOWS; i++) {
  rateLimit(`blocked:${i}`, 1, 60_000 + i, clock);
  rateLimit(`blocked:${i}`, 1, 60_000 + i, clock);
}
check(rateLimit("newcomer", 1, 60_000, clock).ok, "even an all-blocked table admits a new client");
check(store.size <= RATE_LIMIT_MAX_WINDOWS, "…within the bound");
check(rateLimit("blocked:0", 1, 60_000, clock).ok, "the window closest to reset was the one evicted");
check(!rateLimit(`blocked:${RATE_LIMIT_MAX_WINDOWS - 1}`, 1, 60_000 + RATE_LIMIT_MAX_WINDOWS - 1, clock).ok, "the latest-resetting blocked window is kept");

// Expired windows are swept before any live one is evicted.
store.clear();
for (let i = 0; i < RATE_LIMIT_MAX_WINDOWS - 1; i++) rateLimit(`old:${i}`, 1, 1_000, clock);
rateLimit("keeper", 1, 600_000, clock);
check(!rateLimit("keeper", 1, 600_000, clock).ok, "keeper is blocked");
now += 2_000;
check(rateLimit("after-expiry", 1, 60_000, clock).ok, "a new client passes once old windows expired");
check(store.size === 2, "the expired windows were swept, not live ones");
check(!rateLimit("keeper", 1, 600_000, clock).ok, "the live blocked window survived the sweep");
store.clear();

// A missing shared store is visible in production only.
check(hasSharedRateLimitStore({ UPSTASH_REDIS_REST_URL: "u", UPSTASH_REDIS_REST_TOKEN: "t" }), "Upstash pair counts as shared");
check(hasSharedRateLimitStore({ KV_REST_API_URL: "u", KV_REST_API_TOKEN: "t" }), "Vercel KV pair counts as shared");
check(!hasSharedRateLimitStore({ KV_REST_API_URL: "u", UPSTASH_REDIS_REST_TOKEN: "t" }), "a URL from one store with the other's token does not");
check(sharedRateLimitStoreMissing({ VERCEL_ENV: "production" }), "production without a store is reported");
check(!sharedRateLimitStoreMissing({ VERCEL_ENV: "production", KV_REST_API_URL: "u", KV_REST_API_TOKEN: "t" }), "production with a store is fine");
check(!sharedRateLimitStoreMissing({ VERCEL_ENV: "preview" }) && !sharedRateLimitStoreMissing({}), "preview and local runs are not reported");

console.log(`rateLimitCapacity: ${checks} checks passed`);
