import { NextResponse } from "next/server";
import { listWheels, createWheel } from "@/lib/data";

// The creator's wheels. `?archived=1` includes archived wheels.
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const includeArchived = searchParams.get("archived") === "1";
  const wheels = await listWheels(includeArchived);
  return NextResponse.json({ wheels });
}

// Create a new wheel, optionally seeded from a template and/or named.
export async function POST(req: Request) {
  let body: { fromTemplateId?: string; name?: string };
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  try {
    const result = await createWheel({
      fromTemplateId: body.fromTemplateId,
      name: body.name,
    });
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "db_error";
    const status = message === "unauthorized" ? 401 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
