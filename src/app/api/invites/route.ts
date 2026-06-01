import { NextResponse } from "next/server";
import { getMyInvites, respondToOrgInvite } from "@/lib/data";

// Pending agency invites for the signed-in creator.
export async function GET() {
  const invites = await getMyInvites();
  return NextResponse.json({ invites });
}

// Accept or decline an invite. Body: { inviteId, accept }.
export async function POST(req: Request) {
  let body: { inviteId?: string; accept?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!body.inviteId) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const result = await respondToOrgInvite(body.inviteId, Boolean(body.accept));
  if ("error" in result) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  return NextResponse.json(result);
}
