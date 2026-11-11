import assert from "node:assert";
import { mockSetLeaderboardEnabled } from "@/lib/data/mock";
import { GET } from "./[creatorId]/route";

// Runs against the in-memory demo store (no Supabase env in unit tests).

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

const call = (ip: string, fanToken?: string) =>
  GET(new Request("http://localhost/api/leaderboard/demo", { headers: { "x-real-ip": ip, ...(fanToken ? { "x-fan-token": fanToken } : {}) } }), {
    params: Promise.resolve({ creatorId: "demo" }),
  });
const fan = (i: number) => `${i.toString(16).padStart(8, "0")}${"b".repeat(24)}`;

async function main() {
  mockSetLeaderboardEnabled(true);

  const first = await call("198.51.100.1");
  check("200 OK", first.status === 200);

  let last: Response = first;
  for (let i = 1; i < 61 && last.status !== 429; i++) last = await call("198.51.100.1");
  check("the 61st request in a minute from one IP gets 429", last.status === 429);
  check("429 carries Retry-After", Number(last.headers.get("retry-after")) >= 1);
  check("another IP is unaffected", (await call("198.51.100.2")).status === 200);

  // A22 carrier NAT: 120 fans behind one address, each sending its link token, are all served.
  const shared: number[] = [];
  for (let i = 0; i < 120; i++) shared.push((await call("198.51.100.3", fan(i))).status);
  check("120 fans behind one shared address all get 200", shared.every((s) => s === 200));
  check("the token header does not change the board", JSON.stringify(await (await call("198.51.100.4", fan(1))).json()) === JSON.stringify(await (await call("198.51.100.5")).json()));
  // ...while one of them looping is still capped at 60/min, and the others keep reading.
  let looping: Response = await call("198.51.100.3", fan(0));
  for (let i = 0; i < 61 && looping.status !== 429; i++) looping = await call("198.51.100.3", fan(0));
  check("one fan token looping behind the shared address is capped at 60/min", looping.status === 429);
  check("the other fans on that address are still served", (await call("198.51.100.3", fan(5))).status === 200);

  console.log(`leaderboard route: ${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
