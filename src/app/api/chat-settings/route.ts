import { NextResponse } from "next/server";
import { getChatSettings, setChatSettings } from "@/lib/data";

// The creator's editable auto greeting + out-of-spins messages (RLS-scoped).
export async function GET() {
  const settings = await getChatSettings();
  return NextResponse.json({ settings });
}

export async function PUT(req: Request) {
  let body: { intro?: string | null; outro?: string | null };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const result = await setChatSettings({ intro: body.intro, outro: body.outro });
  if ("error" in result) {
    const status = result.error === "unauthorized" ? 401 : 400;
    return NextResponse.json({ error: result.error }, { status });
  }
  return NextResponse.json(result);
}
