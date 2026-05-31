import { NextResponse } from "next/server";
import { listPrizeTemplates, createPrizeTemplate } from "@/lib/data";
import type { Rarity } from "@/lib/games/wheel/types";

// The creator's saved prize presets.
export async function GET() {
  const templates = await listPrizeTemplates();
  return NextResponse.json({ templates });
}

// Save a prize preset.
export async function POST(req: Request) {
  let body: {
    label?: string;
    description?: string;
    rarity?: Rarity;
    weight?: number;
    color?: string;
    emoji?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const label = String(body.label ?? "").trim();
  if (!label || !body.rarity || body.weight == null) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  try {
    const template = await createPrizeTemplate({
      label,
      description: body.description,
      rarity: body.rarity,
      weight: Number(body.weight),
      color: body.color,
      emoji: body.emoji,
    });
    return NextResponse.json({ template });
  } catch (err) {
    const message = err instanceof Error ? err.message : "db_error";
    const status = message === "unauthorized" ? 401 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
