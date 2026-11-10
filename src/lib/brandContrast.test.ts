import assert from "node:assert/strict";
import { mock } from "node:test";
import { brandColorContrastOk } from "./theme";

// PA-01: a brand color under 3:1 against the dark page makes the fan page's
// main button and every focus ring vanish, so the API refuses to set one.

let passed = 0;
const check = (label: string, cond: unknown) => { assert.ok(cond, label); passed++; };

for (const dark of ["#000000", "#0c0a0e", "#111111", "#000", "#1a1a2e"]) check(`${dark} is refused`, !brandColorContrastOk(dark));
for (const ok of ["#ec4899", "#808080", "#ffffff", "#fff", "#7c3aed", "#22c55e"]) check(`${ok} is fine`, brandColorContrastOk(ok));
for (const junk of ["", "pink", "#12", null, undefined]) check(`${String(junk)} is not a color`, !brandColorContrastOk(junk));

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
  check("the brand-color route answers 400 brand_too_dark", res.status === 400 && ((await res.json()) as { error: string }).error === "brand_too_dark" && m.mockGetWheel().brandColor === before);
  res = await putBrand("#7c3aed");
  check("a visible color saves", res.status === 200 && m.mockGetWheel().brandColor === "#7c3aed");

  const wheel = m.mockGetWheel();
  const prizes = [{ id: "a", label: "One", rarity: "common" as const, weight: 3, stock: null }, { id: "b", label: "Two", rarity: "rare" as const, weight: 1, stock: null }];
  const put = (body: unknown) => wheelRoute.PUT(new Request("http://localhost/api/wheel", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
  res = await put({ wheel: { ...wheel, prizes, brandColor: "#000000" }, expectedStock: {} });
  check("a game save cannot change the brand to black", res.status === 400 && ((await res.json()) as { error: string }).error === "brand_too_dark" && m.mockGetWheel().brandColor === "#7c3aed");
  // A color stored before the rule existed never blocks other edits.
  m.mockSetActiveWheelBrandColor("#111111");
  res = await put({ wheel: { ...m.mockGetWheel(), prizes, title: "Still editable" }, expectedStock: {} });
  check("a stored dark color does not block other edits", res.status === 200 && m.mockGetWheel().title === "Still editable");
  m.mockSetActiveWheelBrandColor(before ?? "#ec4899");
  console.log(`brandContrast.test: ${passed} checks passed`);
}
main().catch((error) => { console.error(error); process.exit(1); });
