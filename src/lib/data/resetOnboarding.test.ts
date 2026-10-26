import assert from "node:assert";
import { mockClearMyData, mockGetOverview, mockGetWheel, mockSaveWheel } from "./mock";

// "Clear all data" must put the account back into first-run: the Supabase path
// recreates the starter wheel (updated_at = created_at), so `wheelBuilt` is
// false afterwards. The mock keeps per-wheel timestamps in a side map, and a
// reset re-seeds the SAME wheel id — so a stale "updated" stamp from before the
// reset must not keep ticking the "Build your first wheel" step.

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

async function main() {
  check("fresh store: wheel not built yet", mockGetOverview().metrics.wheelBuilt === false);

  // An edit saved > 1.5s after creation counts as "built" (mirrors getOverview).
  await new Promise((r) => setTimeout(r, 1600));
  const w = mockGetWheel();
  mockSaveWheel({ ...w, title: "Edited " + Date.now() });
  check("after a saved edit the wheel counts as built", mockGetOverview().metrics.wheelBuilt === true);

  mockClearMyData();
  const m = mockGetOverview().metrics;
  check("reset: no fans", m.fans === 0);
  check("reset: no spins", m.spinsPlayed === 0);
  check("reset: nothing fulfilled", m.fulfilled === 0);
  check("reset: the re-seeded starter wheel is NOT 'built'", m.wheelBuilt === false);

  console.log(`resetOnboarding: ${passed} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
