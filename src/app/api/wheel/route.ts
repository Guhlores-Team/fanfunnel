import { NextResponse } from "next/server";
import { getWheel, saveWheel } from "@/lib/data";
import type { WheelConfig } from "@/lib/games/wheel/types";
import { RARITY_ORDER, MAX_WHEEL_PRIZES } from "@/lib/games/wheel/types";
import { badRequest, errorResponse, BAD_REQUEST, parseJsonBody, isJsonObject } from "@/lib/api/handler";
import type { ExpectedStock } from "@/lib/data/wheels";
import { normalizeWheelPayload } from "@/lib/games/wheel/validate";
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
      p.label.length <= 120 &&
      RARITY_ORDER.includes(p.rarity) &&
      Number.isFinite(p.weight) &&
      p.weight >= 0 &&
      p.weight <= 1e6 &&
      (p.imageUrl == null ||
        (typeof p.imageUrl === "string" && isValidHttpUrl(p.imageUrl))),
  );
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
  const body = await parseJsonBody<{ wheel?: unknown; expectedStock?: unknown }>(req);
  if (body === BAD_REQUEST) return badRequest();
  try {
    config = (isJsonObject(body.wheel) ? body.wheel : body) as unknown as WheelConfig;
    expectedStock = readExpectedStock(body.expectedStock);
  } catch {
    return badRequest();
  }
  if (!expectedStock) return badRequest();
  if (!config || !Array.isArray(config.prizes) || !prizesValid(config.prizes)) {
    return badRequest();
  }
  const checked = normalizeWheelPayload(config);
  if ("error" in checked) return badRequest(checked.error);

  const result = await saveWheel(checked.config, { expectedStock });
  if ("error" in result) return errorResponse(result.error);
  await revalidateMyPublicPage();
  return NextResponse.json(result);
}
