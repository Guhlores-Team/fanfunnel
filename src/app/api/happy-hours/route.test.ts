import assert from "node:assert/strict";
import { mock } from "node:test";
let writes = 0, lastMultiplier = 0;
mock.module("@/lib/data", { namedExports: { listHappyHours: async () => [], createHappyHour: async (input: { multiplier: number }) => { writes++; lastMultiplier = input.multiplier; return { id: "window", ...input }; } } });
let passed = 0;
function check(label: string, value: unknown) { assert.ok(value, label); passed++; }
async function main() {
  const { POST } = await import("./route");
  const post = (body: unknown) => POST(new Request("http://localhost/api/happy-hours", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
  const base = { wheelId: "wheel", startsAt: "2026-10-28T12:00:00Z", endsAt: "2026-10-28T13:00:00Z" };
  check("null body is a controlled400 without mutation", (await post(null)).status === 400 && writes === 0);
  check("new multiplier above five is refused before mutation", (await post({ ...base, multiplier: 5.5 })).status === 400 && writes === 0);
  check("old ten setting cannot be newly scheduled", (await post({ ...base, multiplier: 10 })).status === 400 && writes === 0);
  check("lower boundary invalid refuses before mutation", (await post({ ...base, multiplier: 0.5 })).status === 400 && writes === 0);
  check("maximum five remains valid", (await post({ ...base, multiplier: 5 })).status === 200 && writes === 1 && lastMultiplier === 5);
  check("fractional boost remains exact", (await post({ ...base, multiplier: 1.5 })).status === 200 && writes === 2 && lastMultiplier === 1.5);
  console.log(`happy-hour new-setting boundary: ${passed} checks passed`);
}
main().catch(error => { console.error(error); process.exit(1); });
