import assert from "node:assert";
import type { Prize, WheelConfig } from "./types";
import {
  MIN_WHEEL_PRIZES,
  normalizeHex,
  colorError,
  weightError,
  stockError,
  labelError,
  validateWheelDraft,
  normalizeWheelPayload,
  colorFromInput,
} from "./validate";

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

function prize(over: Partial<Prize> = {}): Prize {
  return { id: over.id ?? "p" + Math.random(), label: "Prize", rarity: "common", weight: 10, ...over };
}
function wheel(over: Partial<WheelConfig> = {}): WheelConfig {
  return {
    id: "w1",
    title: "Wheel",
    brandColor: "#ec4899",
    prizes: [prize({ id: "a" }), prize({ id: "b" })],
    ...over,
  };
}

// --- normalizeHex ----------------------------------------------------------
{
  check("#rrggbb lowercased", normalizeHex("#EC4899") === "#ec4899");
  check("#rgb expanded", normalizeHex("#AbC") === "#aabbcc");
  check("surrounding whitespace trimmed", normalizeHex("  #fff ") === "#ffffff");
  check("missing # rejected", normalizeHex("ec4899") === null);
  check("garbage rejected", normalizeHex("garbage") === null);
  check("4-digit rejected", normalizeHex("#abcd") === null);
  check("8-digit (alpha) rejected", normalizeHex("#ec489980") === null);
  check("non-hex digit rejected", normalizeHex("#ggg") === null);
  check("css injection rejected", normalizeHex("#fff;background:url(x)") === null);
  check("empty rejected", normalizeHex("") === null);
  check("non-string rejected", normalizeHex(123) === null && normalizeHex(null) === null);
}

// --- field validators ------------------------------------------------------
{
  check("valid color has no error", colorError("#fff") === null);
  check("invalid color has an error", typeof colorError("red") === "string");
  check("empty required color errors", typeof colorError("") === "string");
  check("unset optional color is fine", colorError(undefined, { optional: true }) === null);
  check("empty optional color is fine", colorError("", { optional: true }) === null);
  check("bad optional color still errors", typeof colorError("#12", { optional: true }) === "string");

  check("weight 10 ok", weightError(10) === null);
  check("fractional weight ok", weightError(0.5) === null);
  check("weight 0 errors", typeof weightError(0) === "string");
  check("negative weight errors", typeof weightError(-1) === "string");
  check("NaN weight errors", typeof weightError(NaN) === "string");
  check("Infinity weight errors", typeof weightError(Infinity) === "string");
  check("huge weight errors", typeof weightError(1e7) === "string");

  check("unset stock ok", stockError(null) === null && stockError(undefined) === null);
  check("stock 0 ok", stockError(0) === null);
  check("stock 5 ok", stockError(5) === null);
  check("fractional stock errors", typeof stockError(1.5) === "string");
  check("negative stock errors", typeof stockError(-1) === "string");
  check("NaN stock errors", typeof stockError(NaN) === "string");

  check("label ok", labelError("Selfie") === null);
  check("empty label errors", typeof labelError("") === "string");
  check("blank label errors", typeof labelError("   ") === "string");
  check("overlong label errors", typeof labelError("x".repeat(81)) === "string");
}

// --- validateWheelDraft ----------------------------------------------------
{
  const ok = validateWheelDraft(wheel());
  check("valid wheel has no issues", ok.issues.length === 0);

  const bad = validateWheelDraft(
    wheel({
      brandColor: "nope",
      labelColor: "#12",
      prizes: [prize({ id: "a", label: "", weight: 0, stock: 1.5, color: "blue" }), prize({ id: "b" })],
    }),
  );
  check("brand color error reported", typeof bad.brandColor === "string");
  check("label color error reported", typeof bad.labelColor === "string");
  check("prize label error", typeof bad.prizes.a?.label === "string");
  check("prize weight error", typeof bad.prizes.a?.weight === "string");
  check("prize stock error", typeof bad.prizes.a?.stock === "string");
  check("prize color error", typeof bad.prizes.a?.color === "string");
  check("valid prize has no entry", bad.prizes.b === undefined);
  check(
    "issues in field order (brand, label color, then prize fields)",
    bad.issues.map((i) => i.key).join(",") ===
      "brandColor,labelColor,prize:a:label,prize:a:weight,prize:a:stock,prize:a:color",
  );

  const one = validateWheelDraft(wheel({ prizes: [prize({ id: "a" })] }));
  check("MIN_WHEEL_PRIZES is 2", MIN_WHEEL_PRIZES === 2);
  check("one prize reports prizeCount", typeof one.prizeCount === "string");
  check("prizeCount is the last issue", one.issues[one.issues.length - 1]?.key === "prizeCount");
  check("zero prizes reports prizeCount", typeof validateWheelDraft(wheel({ prizes: [] })).prizeCount === "string");

  check("unset label color is fine", validateWheelDraft(wheel({ labelColor: undefined })).issues.length === 0);
}

// --- normalizeWheelPayload (server) ---------------------------------------
{
  const r = normalizeWheelPayload(
    wheel({ brandColor: "#ABC", labelColor: "#FFFFFF", prizes: [prize({ id: "a", color: "#F00" }), prize({ id: "b" })] }),
  );
  check("valid payload accepted", "config" in r);
  if ("config" in r) {
    check("brand color normalized", r.config.brandColor === "#aabbcc");
    check("label color normalized", r.config.labelColor === "#ffffff");
    check("prize color normalized", r.config.prizes[0].color === "#ff0000");
    check("unset prize color kept unset", r.config.prizes[1].color === undefined);
  }

  check("unset brand color accepted (server defaults it)", "config" in normalizeWheelPayload(wheel({ brandColor: undefined })));
  const garbage = normalizeWheelPayload(wheel({ brandColor: "garbage" }));
  check("garbage brand color rejected as bad_color", "error" in garbage && garbage.error === "bad_color");
  const emptyBrand = normalizeWheelPayload(wheel({ brandColor: "" }));
  check(
    "empty brand color treated as unset (server defaults it)",
    "config" in emptyBrand && emptyBrand.config.brandColor === undefined,
  );
  const emptyLabel = normalizeWheelPayload(wheel({ labelColor: "" }));
  check("empty label color treated as unset", "config" in emptyLabel && emptyLabel.config.labelColor === undefined);
  const emptyPrize = normalizeWheelPayload(wheel({ prizes: [prize({ id: "a", color: "" }), prize()] }));
  check(
    "empty prize color treated as unset (not a 400)",
    "config" in emptyPrize && emptyPrize.config.prizes[0].color === undefined,
  );
  check("validateWheelDraft agrees: empty prize color is fine", !validateWheelDraft(wheel({ prizes: [prize({ color: "" }), prize()] })).issues.length);
  check("garbage label color rejected", "error" in normalizeWheelPayload(wheel({ labelColor: "white" })));
  check("null label color accepted", "config" in normalizeWheelPayload(wheel({ labelColor: null as unknown as undefined })));
  check(
    "garbage prize color rejected",
    "error" in normalizeWheelPayload(wheel({ prizes: [prize({ color: "url(x)" }), prize()] })),
  );
  const badStock = normalizeWheelPayload(wheel({ prizes: [prize({ stock: -2 }), prize()] }));
  check("negative stock rejected as bad_stock", "error" in badStock && badStock.error === "bad_stock");
  check(
    "fractional stock rejected",
    "error" in normalizeWheelPayload(wheel({ prizes: [prize({ stock: 2.5 }), prize()] })),
  );
  const input = wheel({ brandColor: "#ABC" });
  normalizeWheelPayload(input);
  check("input not mutated", input.brandColor === "#ABC");
}

// --- colorFromInput (editor onChange for optional color fields) -----------
{
  check("cleared field → unset", colorFromInput("") === undefined);
  check("whitespace-only → unset", colorFromInput("   ") === undefined);
  check("typed value kept as typed", colorFromInput("#AbC") === "#AbC");
  check("partial value kept (validated on blur/save)", colorFromInput("#a") === "#a");
}

console.log(`validate: ${passed} checks passed`);
