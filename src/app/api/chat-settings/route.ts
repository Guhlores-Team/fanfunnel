import { NextResponse } from "next/server";
import { getChatSettings, setChatSettings } from "@/lib/data";
import { BAD_REQUEST, badRequest, errorResponse, parseJsonBody } from "@/lib/api/handler";
import { limitRoute } from "@/lib/api/limit";

// The creator's editable auto greeting + out-of-spins messages (RLS-scoped).
export async function GET(req: Request) {
  const rateLimited = await limitRoute(req, "chat-settings:GET");
  if (rateLimited) return rateLimited;
  const settings = await getChatSettings();
  return NextResponse.json({ settings });
}

export async function PUT(req: Request) {
  const rateLimited = await limitRoute(req, "chat-settings:PUT");
  if (rateLimited) return rateLimited;
  const body = await parseJsonBody<{ intro?: string | null; outro?: string | null }>(req);
  if (body === BAD_REQUEST) return badRequest();
  const isValid = (v: unknown) =>
    v === null || v === undefined || (typeof v === "string" && v.length <= 2000);
  if (!isValid(body.intro) || !isValid(body.outro)) return badRequest();
  const result = await setChatSettings({ intro: body.intro, outro: body.outro });
  if ("error" in result) return errorResponse(result.error);
  return NextResponse.json(result);
}
