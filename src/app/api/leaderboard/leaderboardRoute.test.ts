import assert from "node:assert";
import { mockSetLeaderboardEnabled } from "@/lib/data/mock";
import { GET } from "./[creatorId]/route";

// Runs against the in-memory demo store (no Supabase env in unit tests).

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

const call = (ip: string) =>
  GET(new Request("http://localhost/api/leaderboard/demo", { headers: { "x-real-ip": ip } }), {
    params: Promise.resolve({ creatorId: "demo" }),
  });

async function main() {
  mockSetLeaderboardEnabled(true);

  const first = await call("198.51.100.1");
  check("200 OK", first.status === 200);

  let last: Response = first;
  for (let i = 1; i < 61 && last.status !== 429; i++) last = await call("198.51.100.1");
  check("the 61st request in a minute from one IP gets 429", last.status === 429);
  check("429 carries Retry-After", Number(last.headers.get("retry-after")) >= 1);
  check("another IP is unaffected", (await call("198.51.100.2")).status === 200);

  console.log(`leaderboard route: ${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
