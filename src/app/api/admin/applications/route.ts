import { NextResponse } from "next/server";
import { listCreatorApplications, decideCreatorApplication } from "@/lib/data";

// Admin: list creator applications.
export async function GET() {
  const applications = await listCreatorApplications();
  return NextResponse.json({ applications });
}

// Admin: approve/reject one application by profileId.
export async function POST(req: Request) {
  let body: { profileId?: string; decision?: "approved" | "rejected" };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!body.profileId || (body.decision !== "approved" && body.decision !== "rejected")) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const result = await decideCreatorApplication(body.profileId, body.decision);
  if ("error" in result) {
    const status = result.error === "unauthorized" ? 403 : 400;
    return NextResponse.json({ error: result.error }, { status });
  }
  return NextResponse.json(result);
}
