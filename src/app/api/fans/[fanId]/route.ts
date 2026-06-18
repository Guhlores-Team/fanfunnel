import { NextResponse } from "next/server";
import { getFanDetail, deleteFan, updateFanMeta } from "@/lib/data";

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

  let body: { notes?: string | null; tags?: string[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const MAX_NOTES_LEN = 2000;
  const MAX_TAGS = 50;
  const MAX_TAG_LEN = 64;

  const patch: { notes?: string | null; tags?: string[] } = {};
  if ("notes" in body) {
    if (body.notes == null) {
      patch.notes = null;
    } else {
      const notes = String(body.notes);
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
    const tags = body.tags
      .map((t) => String(t).trim())
      .filter(Boolean);
    if (tags.some((t) => t.length > MAX_TAG_LEN)) {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    patch.tags = tags;
  }

  const result = await updateFanMeta(fanId, patch);
  if ("error" in result) {
    const status = result.error === "unauthorized" ? 401 : 400;
    return NextResponse.json(result, { status });
  }
  return NextResponse.json({ ok: true });
}

// Permanently delete a fan account (cascades its links, grants; anonymizes spins).
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ fanId: string }> }
) {
  const { fanId } = await params;
  const result = await deleteFan(fanId);
  if ("error" in result) {
    const status = result.error === "unauthorized" ? 401 : 400;
    return NextResponse.json({ error: result.error }, { status });
  }
  return NextResponse.json({ ok: true });
}
