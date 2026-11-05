import assert from "node:assert/strict";
import { mock } from "node:test";

// The demo store's wheel save applies the editor's stock as save_wheel_prizes
// does (schema.sql): a compare-and-set against the stock the editor loaded
// (`expectedStock`). A stale editor, or a save that races a win, applies only
// the creator's delta, so won units are never put back
// (DEMO_SAVE_IGNORES_EXPECTED_STOCK, stress H11).

delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
// The route marks /c/<slug> stale after a save; outside Next there is no cache.
mock.module("next/cache", { namedExports: { revalidatePath: () => {} } });

let passed = 0;
const check = (label: string, value: unknown) => { assert.ok(value, label); passed++; };

async function main() {
  const { mockAckFan, mockClearMyData, mockCreatePass, mockGetWheel, mockSaveWheel, mockSpin } = await import("./mock");
  const { saveWheel } = await import("./wheels");
  const { PUT } = await import("@/app/api/wheel/route");
  mockClearMyData();
  const LIMITED = "stock-limited", OTHER = "stock-other";
  const base = mockGetWheel();
  mockSaveWheel({ ...base, prizes: [
    { id: LIMITED, label: "Signed print", rarity: "rare", weight: 1, stock: 5 },
    { id: OTHER, label: "Shout-out", rarity: "common", weight: 0, stock: null },
  ] });
  const stockOf = (id: string) => mockGetWheel().prizes.find((p) => p.id === id)?.stock;
  const editor = () => structuredClone(mockGetWheel());
  const withStock = (wheel: ReturnType<typeof mockGetWheel>, id: string, stock: number | null) =>
    ({ ...wheel, prizes: wheel.prizes.map((p) => (p.id === id ? { ...p, stock } : p)) });
  const win = async () => {
    const fan = mockCreatePass(`Stock fan ${passed}`, 1);
    mockAckFan(fan.token);
    const spin = await mockSpin(fan.token);
    assert.ok(!("error" in spin) && spin.prize.id === LIMITED, "the limited prize wins");
  };

  // A stale editor: loaded 5, two wins land, the creator saves unchanged.
  let loaded = editor();
  await win(); await win();
  check("two wins took the stock to 3", stockOf(LIMITED) === 3);
  let saved = await saveWheel(loaded, { expectedStock: { [LIMITED]: 5, [OTHER]: null } });
  check("a stale unchanged save keeps the won units out (3, not 5)", "wheel" in saved && stockOf(LIMITED) === 3);

  // A save racing a win: loaded 3, creator adds 4 (7), one win lands first.
  loaded = editor();
  await win();
  saved = await saveWheel(withStock(loaded, LIMITED, 7), { expectedStock: { [LIMITED]: 3 } });
  check("the creator's +4 is applied over the live 2 (6, not 7)", "wheel" in saved && stockOf(LIMITED) === 6);

  // A cut below what was won meanwhile floors at 0.
  loaded = editor();
  await win(); await win();
  saved = await saveWheel(withStock(loaded, LIMITED, 1), { expectedStock: { [LIMITED]: 6 } });
  check("a -5 over the live 4 floors at 0", "wheel" in saved && stockOf(LIMITED) === 0);

  // Matching stock: the edited value is stored as is.
  saved = await saveWheel(withStock(editor(), LIMITED, 9), { expectedStock: { [LIMITED]: 0 } });
  check("an up-to-date editor sets the value it shows", "wheel" in saved && stockOf(LIMITED) === 9);

  // Limited/unlimited switches the creator did not see are refused.
  loaded = editor();
  mockSaveWheel(withStock(editor(), LIMITED, null));
  saved = await saveWheel(withStock(loaded, LIMITED, 4), { expectedStock: { [LIMITED]: 9 } });
  check("finite edit over a prize made unlimited meanwhile: stock_changed", "error" in saved && saved.error === "stock_changed" && stockOf(LIMITED) === null);
  saved = await saveWheel(withStock(editor(), OTHER, 2), { expectedStock: { [OTHER]: 3 } });
  check("finite edit over a prize that was unlimited when the editor thought 3: stock_changed", "error" in saved && saved.error === "stock_changed" && stockOf(OTHER) === null);
  check("a refused save changes nothing else either", mockGetWheel().prizes.length === 2 && stockOf(LIMITED) === null);
  mockSaveWheel(withStock(editor(), LIMITED, 5));
  loaded = editor();
  await win();
  saved = await saveWheel(withStock(loaded, LIMITED, null), { expectedStock: { [LIMITED]: 5 } });
  check("making a prize unlimited is applied even over a moved stock (as SQL)", "wheel" in saved && stockOf(LIMITED) === null);

  // Without an expected value (a new prize, or no expectedStock sent) the
  // edited stock is stored, as before.
  mockSaveWheel(withStock(editor(), LIMITED, 5));
  await win();
  saved = await saveWheel(withStock(editor(), LIMITED, 8));
  check("no expectedStock: the edited value is stored", "wheel" in saved && stockOf(LIMITED) === 8);
  saved = await saveWheel({ ...editor(), prizes: [...editor().prizes, { id: "stock-new", label: "New", rarity: "common", weight: 0, stock: 2 }] }, { expectedStock: { [LIMITED]: 8, "stock-new": 99 } });
  check("a prize the store does not have yet takes its edited stock", "wheel" in saved && stockOf("stock-new") === 2);

  // Through PUT /api/wheel, the editor's route.
  loaded = editor();
  await win();
  const res = await PUT(new Request("http://localhost/api/wheel", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ wheel: loaded, expectedStock: { [LIMITED]: 8 } }) }));
  check("PUT /api/wheel with a stale editor answers 200 and keeps the win (7)", res.status === 200 && stockOf(LIMITED) === 7);
  mockSaveWheel(withStock(editor(), LIMITED, null));
  const conflict = await PUT(new Request("http://localhost/api/wheel", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ wheel: withStock(loaded, LIMITED, 3), expectedStock: { [LIMITED]: 8 } }) }));
  check("PUT /api/wheel over an unseen unlimited switch is 409 stock_changed", conflict.status === 409 && ((await conflict.json()) as { error?: string }).error === "stock_changed");

  console.log(`mockSaveStock.test: ${passed} checks passed`);
}

main().catch((err) => { console.error(err); process.exit(1); });
