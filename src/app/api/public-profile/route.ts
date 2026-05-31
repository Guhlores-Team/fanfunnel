import { NextResponse } from "next/server";
import { getMyPublicProfile, setMyPublicProfile } from "@/lib/data";

// The signed-in creator's link-in-bio settings.
export async function GET() {
  const profile = await getMyPublicProfile();
  return NextResponse.json(profile);
}

export async function PUT(req: Request) {
  let body: { slug?: string; tipUrl?: string; tagline?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const result = await setMyPublicProfile({
    slug: body.slug ?? "",
    tipUrl: body.tipUrl ?? "",
    tagline: body.tagline ?? "",
  });
  if ("error" in result) {
    const status = result.error === "unauthorized" ? 401 : 400;
    return NextResponse.json({ error: result.error }, { status });
  }
  return NextResponse.json(result);
}
