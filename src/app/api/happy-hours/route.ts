import { NextResponse } from "next/server";
import { listHappyHours, createHappyHour } from "@/lib/data";

// Happy-hour windows for the creator. `?wheelId=` filters to one wheel.
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const wheelId = searchParams.get("wheelId") ?? undefined;
  const happyHours = await listHappyHours(wheelId);
  return NextResponse.json({ happyHours });
}

// Schedule a rare-boost window.
export async function POST(req: Request) {
  let body: { wheelId?: string; multiplier?: number; startsAt?: string; endsAt?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!body.wheelId || !body.startsAt || !body.endsAt) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const multiplier = Number(body.multiplier ?? 2);
  if (!Number.isFinite(multiplier) || multiplier < 1 || multiplier > 10) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const startsAt = new Date(body.startsAt);
  const endsAt = new Date(body.endsAt);
  if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime()) || endsAt.getTime() <= startsAt.getTime()) {
    return NextResponse.json({ error: "invalid_window" }, { status: 400 });
  }

  const result = await createHappyHour({
    wheelId: body.wheelId,
    multiplier,
    startsAt: body.startsAt,
    endsAt: body.endsAt,
  });
  if ("error" in result) {
    const status = result.error === "unauthorized" ? 401 : result.error === "not_found" ? 404 : 400;
    return NextResponse.json({ error: result.error }, { status });
  }
  return NextResponse.json(result);
}
