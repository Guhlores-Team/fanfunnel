import assert from "node:assert";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { useNow, quantizeNow, msUntilNextTick } from "./useNow";
import { timeAgo } from "../format";

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

// --- server render: the hydration contract ---------------------------------
// React hydrates with the SERVER snapshot, so anything derived from "now" must
// render identically on the server and on the client's first (hydration)
// render. useNow() returning null on the server is what guarantees that.
{
  let seen: number | null | undefined;
  function Probe() {
    const now = useNow(1000);
    seen = now;
    return createElement("span", null, now === null ? "pending" : "live");
  }
  const html = renderToString(createElement(Probe));
  check("useNow is null during a server render", seen === null);
  check("server HTML carries the stable placeholder", html.includes("pending"));
}

// --- quantizeNow -------------------------------------------------------------
{
  check("quantizeNow floors to the resolution", quantizeNow(12_345, 1000) === 12_000);
  check("quantizeNow is stable within a window", quantizeNow(15_001, 15_000) === quantizeNow(29_999, 15_000));
  check("quantizeNow advances across a window", quantizeNow(30_000, 15_000) === 30_000);
  check("quantizeNow clamps a non-positive resolution to 1ms", quantizeNow(12_345, 0) === 12_345);
}

// --- msUntilNextTick ---------------------------------------------------------
{
  check("msUntilNextTick waits to the next boundary", msUntilNextTick(12_250, 1000) === 750);
  check("msUntilNextTick on a boundary waits a full window", msUntilNextTick(12_000, 1000) === 1000);
  check("msUntilNextTick is never zero", msUntilNextTick(0, 1) >= 1);
}

// --- timeAgo with an explicit now ----------------------------------------------
// The gallery passes the hook's `now` so the label is a pure function of
// (timestamp, now) instead of reading the clock during render.
{
  const at = "2026-01-01T00:00:00.000Z";
  const t0 = Date.parse(at);
  check("timeAgo(now) 44s → just now", timeAgo(at, { now: t0 + 44_000 }) === "just now");
  check("timeAgo(now) 46s → 1m ago", timeAgo(at, { now: t0 + 46_000 }) === "1m ago");
  check("timeAgo(now) 3h → 3h ago", timeAgo(at, { now: t0 + 3 * 3600_000 }) === "3h ago");
  check(
    "timeAgo(now) is deterministic for the same inputs",
    timeAgo(at, { now: t0 + 90_000 }) === timeAgo(at, { now: t0 + 90_000 })
  );
}

console.log(`useNow.test: ${passed} checks passed`);
