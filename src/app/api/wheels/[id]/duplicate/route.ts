import { NextResponse } from "next/server";
import { duplicateWheel } from "@/lib/data";
import { errorResponse } from "@/lib/api/handler";
import { limitRoute } from "@/lib/api/limit";

// Deep-copy a wheel + its prizes into a new inactive, unscheduled wheel.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const rateLimited = await limitRoute(req, "wheels/[id]/duplicate:POST", "costly");
  if (rateLimited) return rateLimited;
  const { id } = await params;
  try {
    const result = await duplicateWheel(id);
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "db_error";
    return errorResponse(message);
  }
}
