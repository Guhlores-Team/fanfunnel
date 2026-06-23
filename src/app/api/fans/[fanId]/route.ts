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

  const patch: { notes?: string | null; tags?: string[] } = {};
  if ("notes" in body) {
    patch.notes = body.notes == null ? null : String(body.notes);
  }
  if (Array.isArray(body.tags)) {
    patch.tags = body.tags.map((t) => String(t)).filter(Boolean);
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
