import { NextResponse } from "next/server";
import { submitCreatorApplication } from "@/lib/data";

// A signed-in, pending user submits their creator details for vetting.
export async function POST(req: Request) {
  let body: {
    displayName?: string;
    socials?: string;
    audienceSize?: string;
    note?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const limits: Record<string, number> = {
    displayName: 80,
    socials: 500,
    audienceSize: 80,
    note: 2000,
  };
  for (const [field, max] of Object.entries(limits)) {
    const value = (body as Record<string, unknown>)[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string" || value.length > max) {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
  }
  const result = await submitCreatorApplication(body);
  if ("error" in result) {
    const status = result.error === "unauthorized" ? 401 : 400;
    return NextResponse.json({ error: result.error }, { status });
  }
  return NextResponse.json(result);
}
