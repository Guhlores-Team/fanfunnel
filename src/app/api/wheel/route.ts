import { NextResponse } from "next/server";
import { getWheel, saveWheel } from "@/lib/data";
import type { WheelConfig } from "@/lib/games/wheel/types";
import { RARITY_ORDER, MAX_WHEEL_PRIZES } from "@/lib/games/wheel/types";
import { badRequest, errorResponse, BAD_REQUEST, parseJsonBody, isJsonObject } from "@/lib/api/handler";
import type { ExpectedStock } from "@/lib/data/wheels";
import { MAX_PRIZE_DESCRIPTION, MAX_PRIZE_LABEL, normalizeWheelPayload } from "@/lib/games/wheel/validate";
import { publicTextCheck, type PublicTextCode } from "@/lib/publicText";
import { revalidateMyPublicPage } from "@/lib/api/publicPage";
import { limitRoute } from "@/lib/api/limit";

// Reject prize fields the data layer forwards without sanitizing. rarity drives
// the odds defaults, and imageUrl is rendered (and must not be a non-http(s)
// target). Colors and stock are checked (and colors normalized) by
// normalizeWheelPayload, the same helper the editor uses for inline errors.
function prizesValid(prizes: WheelConfig["prizes"]): boolean {
  if (prizes.length > MAX_WHEEL_PRIZES) return false;
  return prizes.every(
    (p) =>
      p != null &&
      typeof p.label === "string" &&
      p.label.length <= MAX_PRIZE_LABEL &&
      (p.description == null || (typeof p.description === "string" && p.description.length <= MAX_PRIZE_DESCRIPTION)) &&
      RARITY_ORDER.includes(p.rarity) &&
      Number.isFinite(p.weight) &&
      p.weight >= 0 &&
      p.weight <= 1e6 &&
      (p.imageUrl == null ||
        (typeof p.imageUrl === "string" && isValidHttpUrl(p.imageUrl))),
  );
}

// TS-04: prize names and descriptions are public text (spin page, /c, share
// and verify pages): no links, e-mail addresses, phone numbers, other-app
// handles or slurs. The editor shows the same refusal inline (labelError).
function prizeTextCode(prizes: WheelConfig["prizes"]): PublicTextCode | null {
  for (const p of prizes) {
    const label = publicTextCheck(p.label, { field: "prizeLabel" });
    if (!label.ok) return label.code;
    const description = publicTextCheck(p.description, { field: "prizeDescription" });
    if (!description.ok) return description.code;
  }
  return null;
}

// Validate that a string is a well-formed https URL. A weak regex can be
// bypassed or admit malformed URLs, so parse with the URL constructor and
// require an explicit https: protocol (the database guard, 0068, requires the
// same and caps the length at 2048; the fan page is https, so a plain-http
// image would be blocked as mixed content anyway).
function isValidHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && value.length <= 2048;
  } catch {
    return false;
  }
}

// Read the signed-in creator's wheel configuration.
export async function GET(req: Request) {
  const rateLimited = await limitRoute(req, "wheel:GET");
  if (rateLimited) return rateLimited;
  const wheel = await getWheel();
  if (!wheel) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json({ wheel });
}

// The editor's loaded stock per saved prize id (null = unlimited), so a stock
// edit is a compare-and-set in SQL and never overwrites concurrent spins.
function readExpectedStock(value: unknown): ExpectedStock | null {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out: ExpectedStock = {};
  for (const [id, stock] of Object.entries(value as Record<string, unknown>)) {
    if (typeof id !== "string" || id.length > 64) return null;
    if (stock !== null && !(typeof stock === "number" && Number.isInteger(stock) && stock >= 0)) return null;
    out[id] = stock as number | null;
  }
  return out;
}

// Save the creator's wheel (title, branding, prizes).
export async function PUT(req: Request) {
  const rateLimited = await limitRoute(req, "wheel:PUT");
  if (rateLimited) return rateLimited;
  let config: WheelConfig;
  let expectedStock: ExpectedStock | null;
  const body = await parseJsonBody<{ wheel?: unknown; expectedStock?: unknown; expectedUpdatedAt?: unknown; draft?: unknown }>(req);
  if (body === BAD_REQUEST) return badRequest();
  try {
    config = (isJsonObject(body.wheel) ? body.wheel : body) as unknown as WheelConfig;
    expectedStock = readExpectedStock(body.expectedStock);
  } catch {
    return badRequest();
  }
  if (!expectedStock) return badRequest();
  // 0073 (DB-11): the game version the editor loaded; a save over a newer one
  // answers 409 game_changed. Absent (older tabs) saves without the check.
  const expectedUpdatedAt = body.expectedUpdatedAt ?? null;
  if (expectedUpdatedAt !== null && (typeof expectedUpdatedAt !== "string" || expectedUpdatedAt.length > 40 || !Number.isFinite(Date.parse(expectedUpdatedAt)))) return badRequest();
  // WC-11: `draft: true` lets a never-published bingo game be stored unfinished.
  if (body.draft !== undefined && typeof body.draft !== "boolean") return badRequest();
  if (!config || !Array.isArray(config.prizes) || !prizesValid(config.prizes)) {
    return badRequest();
  }
  const textCode = prizeTextCode(config.prizes);
  if (textCode) return badRequest(textCode);
  // TS-04: the subtitle is public text too (spin page, /c).
  const subtitle = publicTextCheck((config as { subtitle?: unknown }).subtitle, { field: "pageText" });
  if (!subtitle.ok) return badRequest(subtitle.code);
  const checked = normalizeWheelPayload(config);
  if ("error" in checked) return badRequest(checked.error);

  const result = await saveWheel(checked.config, { expectedStock, expectedUpdatedAt, draft: body.draft === true });
  if ("error" in result) return errorResponse(result.error);
  await revalidateMyPublicPage();
  return NextResponse.json(result);
}
