import { NextResponse } from "next/server";
import { duplicateWheel } from "@/lib/data";

// Deep-copy a wheel + its prizes into a new inactive, unscheduled wheel.
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const result = await duplicateWheel(id);
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "db_error";
    const status =
      message === "unauthorized" ? 401 : message === "not_found" ? 404 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
