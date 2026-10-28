import { NextResponse } from "next/server";
import { addPrizeCodes } from "@/lib/data";
import { BAD_REQUEST, badRequest, errorResponse, parseJsonBody } from "@/lib/api/handler";
import { MAX_CODES_PER_PASTE, parseCodeList } from "@/lib/rewards/config";

// #26: paste unlock codes onto a prize, one per line. Body: { codes: string }.
// The prize becomes a code list whose stock is its unused codes; each code is
// encrypted on the server and handed to exactly one winner. The response never
// echoes a code (only counts and masked hints).
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await parseJsonBody<{ codes?: unknown }>(req);
  if (body === BAD_REQUEST || !body || typeof body !== "object") return badRequest();
  const parsed = parseCodeList(body.codes);
  if (parsed.tooLong > 0) return badRequest("code_too_long");
  if (parsed.codes.length === 0) return badRequest("no_codes");
  if (parsed.codes.length > MAX_CODES_PER_PASTE) return badRequest("too_many_codes");
  const result = await addPrizeCodes(id, parsed.codes);
  if ("error" in result) {
    if (result.error === "reward_key_missing") {
      return NextResponse.json({ error: "reward_key_missing" }, { status: 503 });
    }
    return errorResponse(result.error);
  }
  return NextResponse.json(
    { delivery: result, added: result.added, duplicates: parsed.duplicates + result.duplicates },
    { headers: { "Cache-Control": "no-store" } },
  );
}
