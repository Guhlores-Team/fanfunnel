import { NextResponse } from "next/server";
import { listWheels, createWheel } from "@/lib/data";
import { errorResponse, BAD_REQUEST, badRequest, parseJsonBody } from "@/lib/api/handler";
import { limitRoute } from "@/lib/api/limit";

// The creator's wheels. `?archived=1` includes archived wheels.
export async function GET(req: Request) {
  const rateLimited = await limitRoute(req, "wheels:GET");
  if (rateLimited) return rateLimited;
  const { searchParams } = new URL(req.url);
  const includeArchived = searchParams.get("archived") === "1";
  const wheels = await listWheels(includeArchived);
  return NextResponse.json({ wheels });
}

// Create a new wheel, optionally seeded from a template and/or named.
export async function POST(req: Request) {
  const rateLimited = await limitRoute(req, "wheels:POST");
  if (rateLimited) return rateLimited;
  // Every field is optional, so an empty body creates a blank wheel; a body
  // that is not a JSON object is a 400 (L4).
  const body = await parseJsonBody<{ fromTemplateId?: string; name?: string; gameKind?: unknown; gameConfig?: unknown }>(req, { allowEmpty: true });
  if (body === BAD_REQUEST) return badRequest();

  try {
    const result = await createWheel({
      fromTemplateId: body.fromTemplateId,
      name: body.name,
      gameKind: body.gameKind,
      gameConfig: body.gameConfig,
    });
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "db_error";
    return errorResponse(message);
  }
}
