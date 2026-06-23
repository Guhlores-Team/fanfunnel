import { NextResponse } from "next/server";
import { getMyPublicProfile, setMyPublicProfile } from "@/lib/data";
import { BAD_REQUEST, badRequest, errorResponse, parseJsonBody } from "@/lib/api/handler";

// The signed-in creator's link-in-bio settings.
export async function GET() {
  const profile = await getMyPublicProfile();
  return NextResponse.json(profile);
}

export async function PUT(req: Request) {
  const body = await parseJsonBody<{
    slug?: string;
    tipUrl?: string;
    tagline?: string;
    note?: string;
    avatarUrl?: string;
  }>(req);
  if (body === BAD_REQUEST) return badRequest();
  const result = await setMyPublicProfile({
    slug: body.slug ?? "",
    tipUrl: body.tipUrl ?? "",
    tagline: body.tagline ?? "",
    note: body.note,
    avatarUrl: body.avatarUrl,
  });
  if ("error" in result) return errorResponse(result.error);
  return NextResponse.json(result);
}
