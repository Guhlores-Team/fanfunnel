import assert from "node:assert";
import { mockSetLeaderboardEnabled } from "@/lib/data/mock";
import { GET } from "./[creatorId]/route";

// Runs against the in-memory demo store (no Supabase env in unit tests).

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

const call = (creatorId: string, headers: Record<string, string> = {}) =>
  GET(new Request(`http://localhost/api/recent-wins/${creatorId}?k=0`, { headers }), {
    params: Promise.resolve({ creatorId }),
  });

function parseCacheControl(v: string | null): Map<string, string> {
  const m = new Map<string, string>();
  for (const part of (v ?? "").split(",")) {
    const [k, val = ""] = part.trim().toLowerCase().split("=");
    if (k) m.set(k, val);
  }
  return m;
}

async function main() {
  mockSetLeaderboardEnabled(true);

  const anon = await call("demo");
  const anonBody = await anon.text();

  // --- response shape is unchanged: { wins: RecentWin[] } -------------------
  {
    const json = JSON.parse(anonBody) as { wins?: unknown };
    check("200 OK", anon.status === 200);
    check("body is { wins: [...] }", Array.isArray(json.wins));
    check("no extra top-level keys", Object.keys(json).join(",") === "wins");
  }

  // --- shared-cacheable: short CDN TTL + SWR, never per-browser long-lived --
  {
    const cc = parseCacheControl(anon.headers.get("cache-control"));
    check("Cache-Control is public", cc.has("public"));
    const sMax = Number(cc.get("s-maxage"));
    check("s-maxage set and short (1..60s)", sMax >= 1 && sMax <= 60);
    const swr = Number(cc.get("stale-while-revalidate"));
    check("stale-while-revalidate set", swr >= 1);
    // Bounds how long an opted-out fan can linger in other fans' tickers.
    check("total CDN staleness (s-maxage + SWR) <= 20s", sMax + swr <= 20);
    check("no private/no-store", !cc.has("private") && !cc.has("no-store"));
    check("no Set-Cookie on a shared-cached response", anon.headers.get("set-cookie") === null);
  }

  // --- nothing per-viewer: a signed-in-looking request gets identical bytes --
  {
    const authed = await call("demo", {
      cookie: "sb-access-token=abc; ff_fan=xyz",
      authorization: "Bearer someone",
    });
    check("same body regardless of viewer cookies/auth", (await authed.text()) === anonBody);
    const withToken = await call("demo", { "x-fan-token": "c".repeat(32) });
    check("same body and Cache-Control with the fan token header (it only keys the limiter)", (await withToken.text()) === anonBody && withToken.headers.get("cache-control") === anon.headers.get("cache-control"));
    check(
      "same Cache-Control regardless of viewer",
      authed.headers.get("cache-control") === anon.headers.get("cache-control")
    );
  }

  // --- per-IP cap at the origin; a 429 is never shared-cached ---------------
  {
    const ip = { "x-real-ip": "203.0.113.7" };
    let last: Response | null = null;
    for (let i = 0; i < 121 && (!last || last.status !== 429); i++) last = await call("demo", ip);
    check("the 121st request in a minute from one IP gets 429", last?.status === 429);
    check("429 carries Retry-After", Number(last?.headers.get("retry-after")) >= 1);
    check("429 is no-store, so the CDN can't serve it to other fans", last?.headers.get("cache-control") === "no-store");
    const other = await call("demo", { "x-real-ip": "203.0.113.8" });
    check("another IP is unaffected", other.status === 200);
  }

  // --- A22 carrier NAT: fans behind one address are keyed by their own token --
  {
    const fan = (i: number) => ({ "x-real-ip": "203.0.113.9", "x-fan-token": `${i.toString(16).padStart(8, "0")}${"d".repeat(24)}` });
    const polls: number[] = [];
    // 100 fans, three polls each (one minute on the page): 300 > the old 120/min per address.
    for (let round = 0; round < 3; round++) for (let i = 0; i < 100; i++) polls.push((await call("demo", fan(i))).status);
    check("100 fans polling 3x/min behind one address are never refused", polls.every((s) => s === 200));
    let looping: Response | null = null;
    for (let i = 0; i < 121 && (!looping || looping.status !== 429); i++) looping = await call("demo", fan(500));
    check("one fan token looping behind the shared address is capped at 120/min", looping?.status === 429 && looping.headers.get("cache-control") === "no-store");
  }

  console.log(`recent-wins route: ${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
