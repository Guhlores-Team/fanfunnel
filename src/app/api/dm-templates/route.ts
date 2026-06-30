import { NextResponse } from "next/server";
import { listDmTemplates, createDmTemplate } from "@/lib/data";
import { BAD_REQUEST, badRequest, errorResponse, parseJsonBody } from "@/lib/api/handler";

// A creator's saved DM templates ({link} is a placeholder for a fan spin URL).
// Creator-scoped; newest first.
export async function GET() {
  const templates = await listDmTemplates();
  return NextResponse.json({ templates });
}

export async function POST(req: Request) {
  const body = await parseJsonBody<{ title?: string; body?: string }>(req);
  if (body === BAD_REQUEST) return badRequest();

  const title = String(body.title ?? "").trim();
  const text = String(body.body ?? "");
  if (!title || !text.trim() || title.length > 120 || text.length > 2000) {
    return badRequest();
  }

  const result = await createDmTemplate(title, text);
  if ("error" in result) return errorResponse(result.error);
  return NextResponse.json(result);
}
