import { completeReadResponse } from "@/lib/api/completeRead";
import { NextResponse } from "next/server";
import { getAutopilot, dismissAutopilotCard } from "@/lib/data";
import { BAD_REQUEST, badRequest, errorResponse, parseJsonBody } from "@/lib/api/handler";
import { ValidationError, str } from "@/lib/api/validate";
import { limitRoute } from "@/lib/api/limit";
import { isSupabaseConfigured } from "@/lib/supabase/server";

// The creator's ranked action feed.
export async function GET(req: Request) {
  const rateLimited = await limitRoute(req, "autopilot:GET");
  if (rateLimited) return rateLimited;
  return completeReadResponse(async () => {
    const cards = await getAutopilot();
    // A36: Autopilot ranks cards from the connected database only; the demo
    // says so instead of looking like "all caught up".
    return NextResponse.json({ cards, ...(isSupabaseConfigured() ? {} : { demo: true }) });
  });
}

// Dismiss or snooze a card. Body: { key, snoozeUntil? }.
export async function POST(req: Request) {
  const rateLimited = await limitRoute(req, "autopilot:POST");
  if (rateLimited) return rateLimited;
  const body = await parseJsonBody<{ key?: string; snoozeUntil?: string }>(req);
  if (body === BAD_REQUEST) return badRequest();

  let key: string;
  let snoozeUntil: string | undefined;
  try {
    key = str(body.key, { max: 200, required: true })!;
    snoozeUntil = str(body.snoozeUntil, { max: 40 });
    if (snoozeUntil !== undefined && Number.isNaN(new Date(snoozeUntil).getTime())) {
      throw new ValidationError();
    }
  } catch (e) {
    if (e instanceof ValidationError) return badRequest(e.code);
    throw e;
  }

  const result = await dismissAutopilotCard(key, snoozeUntil);
  if ("error" in result) return errorResponse(result.error);
  return NextResponse.json(result);
}
