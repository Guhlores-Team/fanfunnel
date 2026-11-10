import assert from "node:assert/strict";
import { mock } from "node:test";
import { APP_BASE, BRAND_DARK_HINT, brandColorContrastOk, brandText, brandUi, brandVars, contrastRatio, parseHex } from "./theme";

// PA-01: a brand color under 3:1 against the dark page would make the fan
// page's main button and every focus ring vanish. Decision (batch 7): no
// color is refused for darkness. Any valid hex saves, and the fan page paints
// --brand-ui (the color lifted to 3:1) with a readable ink on it; the editor
// and Settings only show a hint. brandColorContrastOk is the hint's test.

let passed = 0;
const check = (label: string, cond: unknown) => { assert.ok(cond, label); passed++; };

for (const dark of ["#000000", "#0c0a0e", "#111111", "#000", "#1a1a2e"]) check(`${dark} gets the hint`, !brandColorContrastOk(dark));
for (const ok of ["#ec4899", "#808080", "#ffffff", "#fff", "#7c3aed", "#22c55e"]) check(`${ok} needs no hint`, brandColorContrastOk(ok));
for (const junk of ["", "pink", "#12", null, undefined]) check(`${String(junk)} is not a color`, !brandColorContrastOk(junk));

// Whatever is saved, what the fan page paints can be seen and read.
const base = parseHex(APP_BASE)!;
for (const color of ["#000000", "#050505", "#0c0a0e", "#111111", "#1a1a2e", "#fefefe", "#ffffff", "#ec4899"]) {
  const vars = brandVars(color) as Record<string, string>;
  const ui = parseHex(vars["--brand-ui"])!;
  check(`${color}: --brand-ui reaches 3:1 on the page`, vars["--brand-ui"] === brandUi(color) && contrastRatio(ui, base) >= 3);
  check(`${color}: --brand-ink reads on that fill (4.5:1)`, contrastRatio(parseHex(vars["--brand-ink"])!, ui) >= 4.5);
  check(`${color}: --brand-text reads on the page (4.5:1)`, vars["--brand-text"] === brandText(color) && contrastRatio(parseHex(vars["--brand-text"])!, base) >= 4.5);
  check(`${color}: the stored color is kept as chosen`, vars["--brand"] === color);
}
check("the hint says the color still works and what fans will see", /very dark/.test(BRAND_DARK_HINT) && /lighter shade/.test(BRAND_DARK_HINT) && !/pick|can't|cannot|refus/i.test(BRAND_DARK_HINT));

mock.module("@/lib/supabase/server", {
  namedExports: {
    isSupabaseConfigured: () => false,
    createClient: async () => { throw new Error("demo"); },
    createServiceClient: () => { throw new Error("demo"); },
  },
});
mock.module("next/cache", { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } });

async function main() {
  const brand = await import("@/app/api/account/brand-color/route");
  const wheelRoute = await import("@/app/api/wheel/route");
  const m = await import("./data/mock");
  const putBrand = (color: unknown) => brand.PUT(new Request("http://localhost/api/account/brand-color", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ color }) }));
  const before = m.mockGetWheel().brandColor;
  let res = await putBrand("#0c0a0e");
  check("a near-black color saves", res.status === 200 && m.mockGetWheel().brandColor === "#0c0a0e");
  res = await putBrand("#fefefe");
  check("a near-white color saves", res.status === 200 && m.mockGetWheel().brandColor === "#fefefe");
  res = await putBrand("#7c3aed");
  check("an everyday color saves", res.status === 200 && m.mockGetWheel().brandColor === "#7c3aed");
  res = await putBrand("not-a-color");
  check("only a value that is not a hex color is refused", res.status === 400 && ((await res.json()) as { error: string }).error === "bad_color" && m.mockGetWheel().brandColor === "#7c3aed");

  const wheel = m.mockGetWheel();
  const prizes = [{ id: "a", label: "One", rarity: "common" as const, weight: 3, stock: null }, { id: "b", label: "Two", rarity: "rare" as const, weight: 1, stock: null }];
  const put = (body: unknown) => wheelRoute.PUT(new Request("http://localhost/api/wheel", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
  res = await put({ wheel: { ...wheel, prizes, brandColor: "#000000" }, expectedStock: {} });
  check("a game save can set the brand to black", res.status === 200 && m.mockGetWheel().brandColor === "#000000");
  res = await put({ wheel: { ...m.mockGetWheel(), prizes, title: "Still editable" }, expectedStock: {} });
  check("and a dark color never blocks other edits", res.status === 200 && m.mockGetWheel().title === "Still editable");
  m.mockSetActiveWheelBrandColor(before ?? "#ec4899");
  console.log(`brandContrast.test: ${passed} checks passed`);
}
main().catch((error) => { console.error(error); process.exit(1); });
