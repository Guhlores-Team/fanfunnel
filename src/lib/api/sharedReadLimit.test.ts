import assert from "node:assert";
import { limitSharedRead, SHARED_READ_LIMITS } from "@/lib/api/limit";
import { FAN_CLIENT_HEADER } from "@/lib/api/fanClientHeader";

// A22 / stress H10: public reads many fans poll from behind one shared address
// key the window on address + fan token under a looser per-address ceiling.
// The negative half matters as much: one address + token, an address rotating
// forged tokens, and an address sending no token stay capped.

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

const token = (i: number) => `fan${String(i).padStart(4, "0")}${"a".repeat(28)}`;
const req = (ip: string, fan?: string) =>
  new Request("http://localhost/api/leaderboard/demo", { headers: { "x-real-ip": ip, ...(fan === undefined ? {} : { [FAN_CLIENT_HEADER]: fan }) } });
async function burst(n: number, make: (i: number) => Request, read: "leaderboard" | "recentWins" = "leaderboard") {
  let ok = 0, limited = 0, retryAfter = 0;
  for (let i = 0; i < n; i++) {
    const r = await limitSharedRead(make(i), read);
    if (!r) ok++;
    else { limited++; retryAfter = Number(r.headers.get("retry-after")); assert.equal(r.status, 429); }
  }
  return { ok, limited, retryAfter };
}

async function main() {
  const { leaderboard: lb, recentWins: rw } = SHARED_READ_LIMITS;
  check("the per-client window keeps the old per-address limits", lb.perClient === 60 && rw.perClient === 120);
  check("the per-address ceiling is looser but bounded", lb.perAddress > lb.perClient && lb.perAddress <= 10 * lb.perClient && rw.perAddress > rw.perClient && rw.perAddress <= 10 * rw.perClient);

  // Positive: 150 fans behind one address, two reads each (the load and a refetch), fill the ceiling exactly.
  const nat = await burst(2 * 150, (i) => req("198.51.100.10", token(i % 150)));
  check("150 fans behind one address reading twice are never refused (300 <= ceiling)", nat.ok === 300 && nat.limited === 0);
  const over = await burst(1, () => req("198.51.100.10", token(999)));
  check("the next read from that address is refused by the per-address ceiling", over.limited === 1 && over.retryAfter >= 1);
  check("another address is unaffected", (await burst(1, () => req("198.51.100.11", token(1)))).ok === 1);

  // Negative: one address + one token is capped exactly as the old per-address window was.
  const flood = await burst(100, () => req("198.51.100.20", token(7)));
  check("a flood from one address + token is capped at 60/min", flood.ok === 60 && flood.limited === 40 && flood.retryAfter >= 1 && flood.retryAfter <= 60);
  check("its neighbour's token on the same address is still served (refusals do not spend the ceiling)", (await burst(1, () => req("198.51.100.20", token(8)))).ok === 1);

  // Negative: rotating forged tokens from one address reaches the ceiling and no further.
  const rotating = await burst(400, (i) => req("198.51.100.30", token(1000 + i)));
  check("an address rotating forged tokens is capped at the per-address ceiling", rotating.ok === lb.perAddress && rotating.limited === 400 - lb.perAddress);

  // Negative: no token (or one that is not a link token's shape) shares one window per address.
  const anonymous = await burst(70, (i) => req("198.51.100.40", i % 2 ? undefined : i % 4 ? "short" : "x".repeat(300)));
  check("requests without a usable token share one 60/min window per address", anonymous.ok === 60 && anonymous.limited === 10);
  const junk = await burst(70, (i) => req("198.51.100.41", `<script>${i}</script>`.padEnd(20, "!")));
  check("a malformed token header cannot mint a window per request", junk.ok === 60 && junk.limited === 10);

  // The two reads are separate scopes with their own numbers.
  const wins = await burst(130, () => req("198.51.100.20", token(7)), "recentWins");
  check("recent wins: its own scope, 120/min per address + token", wins.ok === 120 && wins.limited === 10);
  const winsRotating = await burst(700, (i) => req("198.51.100.50", token(5000 + i)), "recentWins");
  check("recent wins: rotating tokens stop at its 600/min ceiling", winsRotating.ok === rw.perAddress && winsRotating.limited === 700 - rw.perAddress);

  console.log(`shared read limit: ${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
