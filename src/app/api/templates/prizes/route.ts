import { NextResponse } from "next/server";
import { listPrizeTemplates, createPrizeTemplate } from "@/lib/data";
import { RARITY_ORDER, type Rarity } from "@/lib/games/wheel/types";
import { BAD_REQUEST, badRequest, errorResponse, parseJsonBody } from "@/lib/api/handler";

// The creator's saved prize presets.
export async function GET() {
  const templates = await listPrizeTemplates();
  return NextResponse.json({ templates });
}

// Save a prize preset.
export async function POST(req: Request) {
  const body = await parseJsonBody<{
    label?: string;
    description?: string;
    rarity?: Rarity;
    weight?: number;
    color?: string;
    emoji?: string;
  }>(req);
  if (body === BAD_REQUEST) return badRequest();

  const label = String(body.label ?? "").trim();
  if (!label || !body.rarity || body.weight == null) {
    return badRequest();
  }
  if (!RARITY_ORDER.includes(body.rarity)) {
    return badRequest("bad_rarity");
  }
  const weight = Number(body.weight);
  if (!Number.isFinite(weight) || weight < 0 || weight > 1e6) {
    return badRequest("bad_weight");
  }

  try {
    const template = await createPrizeTemplate({
      label,
      description: body.description,
      rarity: body.rarity,
      weight,
      color: body.color,
      emoji: body.emoji,
    });
    return NextResponse.json({ template });
  } catch (err) {
    // Only surface controlled error codes (lowercase_snake). Never reflect an
    // unexpected error's raw message — it can leak internals to the client.
    const raw = err instanceof Error ? err.message : "";
    return errorResponse(/^[a-z][a-z0-9_]*$/.test(raw) ? raw : "db_error");
  }
}
