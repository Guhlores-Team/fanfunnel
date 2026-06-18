import { NextResponse } from "next/server";
import { addWishlist, removeWishlist } from "@/lib/data";
import { rateLimitOr429 } from "@/lib/api/limit";

// A fan flags / un-flags a prize they're chasing. Token-gated (fans aren't authed).
export async function POST(req: Request) {
  return mutate(req, addWishlist);
}

export async function DELETE(req: Request) {
  return mutate(req, removeWishlist);
}

async function mutate(
  req: Request,
  fn: (token: string, prizeLabel: string) => Promise<{ ok: true } | { error: string }>
) {
  let body: { token?: string; prizeLabel?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!body.token || !body.prizeLabel) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const limited = rateLimitOr429("wishlist:" + body.token, 20, 60_000);
  if (limited) return limited;
  const result = await fn(body.token, body.prizeLabel);
  if ("error" in result) {
    const status = result.error === "not_found" ? 404 : 400;
    return NextResponse.json({ error: result.error }, { status });
  }
  return NextResponse.json(result);
}
