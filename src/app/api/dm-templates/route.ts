import { NextResponse } from "next/server";
import { listDmTemplates, createDmTemplate } from "@/lib/data";

// A creator's saved DM templates ({link} is a placeholder for a fan spin URL).
// Creator-scoped; newest first.
export async function GET() {
  const templates = await listDmTemplates();
  return NextResponse.json({ templates });
}

export async function POST(req: Request) {
  let body: { title?: string; body?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const title = String(body.title ?? "").trim();
  const text = String(body.body ?? "");
  if (!title || !text.trim() || title.length > 120 || text.length > 2000) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const result = await createDmTemplate(title, text);
  if ("error" in result) {
    const status = result.error === "unauthorized" ? 401 : 400;
    return NextResponse.json(result, { status });
  }
  return NextResponse.json(result);
}
