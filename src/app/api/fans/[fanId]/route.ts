import { NextResponse } from "next/server";
import { getFanDetail, deleteFan, updateFanMeta } from "@/lib/data";
import { BAD_REQUEST, badRequest, errorResponse, parseJsonBody } from "@/lib/api/handler";

// A single fan account's full detail, for the creator's fan drill-in.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ fanId: string }> }
) {
  const { fanId } = await params;
  const detail = await getFanDetail(fanId);
  if (!detail) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json(detail);
}

// Patch creator-applied metadata (notes and/or tags) on a fan account.
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ fanId: string }> }
) {
  const { fanId } = await params;

  const body = await parseJsonBody<{ notes?: string | null; tags?: string[] }>(req);
  if (body === BAD_REQUEST) return badRequest();

  const MAX_NOTES_LEN = 2000;
  const MAX_TAGS = 50;
  const MAX_TAG_LEN = 64;

  const patch: { notes?: string | null; tags?: string[] } = {};
  if ("notes" in body) {
    if (body.notes == null) {
      patch.notes = null;
    } else {
      if (typeof body.notes !== "string") {
        return NextResponse.json({ error: "bad_request" }, { status: 400 });
      }
      const notes = body.notes;
      if (notes.length > MAX_NOTES_LEN) {
        return NextResponse.json({ error: "bad_request" }, { status: 400 });
      }
      patch.notes = notes;
    }
  }
  if (Array.isArray(body.tags)) {
    if (body.tags.length > MAX_TAGS) {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    if (body.tags.some((t) => typeof t !== "string")) {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    const tags = body.tags
      .map((t) => String(t).trim())
      .filter(Boolean);
    if (tags.some((t) => t.length > MAX_TAG_LEN)) {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    patch.tags = tags;
  }

  const result = await updateFanMeta(fanId, patch);
  if ("error" in result) return errorResponse(result.error);
  return NextResponse.json({ ok: true });
}

// Permanently delete a fan account (cascades its links, grants; anonymizes spins).
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ fanId: string }> }
) {
  const { fanId } = await params;
  const result = await deleteFan(fanId);
  if ("error" in result) return errorResponse(result.error);
  return NextResponse.json({ ok: true });
}
