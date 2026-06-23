import { NextResponse } from "next/server";
import { listHappyHours, createHappyHour } from "@/lib/data";
import { BAD_REQUEST, badRequest, errorResponse, parseJsonBody } from "@/lib/api/handler";

// Happy-hour windows for the creator. `?wheelId=` filters to one wheel.
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const wheelId = searchParams.get("wheelId") ?? undefined;
  const happyHours = await listHappyHours(wheelId);
  return NextResponse.json({ happyHours });
}

// Schedule a rare-boost window.
export async function POST(req: Request) {
  const body = await parseJsonBody<{
    wheelId?: string;
    multiplier?: number;
    startsAt?: string;
    endsAt?: string;
  }>(req);
  if (body === BAD_REQUEST) return badRequest();
  if (!body.wheelId || !body.startsAt || !body.endsAt) {
    return badRequest();
  }

  const result = await createHappyHour({
    wheelId: body.wheelId,
    multiplier: Number(body.multiplier ?? 2),
    startsAt: body.startsAt,
    endsAt: body.endsAt,
  });
  if ("error" in result) return errorResponse(result.error);
  return NextResponse.json(result);
}
