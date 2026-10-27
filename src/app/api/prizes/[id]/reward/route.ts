import { NextResponse } from "next/server";
import { getPrizeDelivery, setPrizeDelivery } from "@/lib/data";
import { BAD_REQUEST, badRequest, errorResponse, parseJsonBody } from "@/lib/api/handler";
import { normalizeRewardLink, normalizeRewardText } from "@/lib/rewards/config";

// #26: a prize's instant delivery, for the creator's wheel editor.
// GET  -> { delivery } (codes are masked, never returned in full)
// PUT  { kind: "manual" } | { kind: "link", value: https URL } | { kind: "text", value }
// The data layer authorizes with can_act_for(creator, 'edit_wheel') on the
// caller's session, then writes through the server-only functions.

const noStore = { "Cache-Control": "no-store" };

function respond(result: Awaited<ReturnType<typeof getPrizeDelivery>>) {
  if ("error" in result) {
    if (result.error === "reward_key_missing") {
      return NextResponse.json({ error: "reward_key_missing" }, { status: 503, headers: noStore });
    }
    return errorResponse(result.error);
  }
  return NextResponse.json({ delivery: result }, { headers: noStore });
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return respond(await getPrizeDelivery(id));
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await parseJsonBody<{ kind?: unknown; value?: unknown }>(req);
  if (body === BAD_REQUEST || !body || typeof body !== "object") return badRequest();
  if (body.kind === "manual") return respond(await setPrizeDelivery(id, { kind: "manual" }));
  if (body.kind === "link") {
    const value = normalizeRewardLink(body.value);
    if (!value) return badRequest("invalid_link");
    return respond(await setPrizeDelivery(id, { kind: "link", value }));
  }
  if (body.kind === "text") {
    const value = normalizeRewardText(body.value);
    if (!value) return badRequest("invalid_text");
    return respond(await setPrizeDelivery(id, { kind: "text", value }));
  }
  return badRequest();
}
