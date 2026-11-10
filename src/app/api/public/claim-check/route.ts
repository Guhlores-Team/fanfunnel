import { NextResponse } from "next/server";
import { limitRoute } from "@/lib/api/limit";
import { BAD_REQUEST, badRequest, parseJsonBody } from "@/lib/api/handler";
import { claimCodeFor, verifyClaimCode } from "@/lib/rewards/claimCode";
import type { ClaimCheckState } from "@/lib/fan/claimCheck";

// WF-17: the creator's claim-code check, by POST, so the code never lands in
// a URL that gets copied into a DM (it used to be /verify/<id>?code=…). JSON
// from the verify page's script; a plain form post (no JS) is answered with a
// redirect back to the page carrying only the verdict, never the code.
// Per-address at the `costly` tier (batch 6 C4), as the page check was.

const SHARE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export async function POST(req: Request) {
  const limited = await limitRoute(req, "public/claim-check:POST", "costly");
  const form = (req.headers.get("content-type") ?? "").includes("application/x-www-form-urlencoded");
  let shareId: unknown, code: unknown;
  if (form) {
    const data = await req.formData().catch(() => null);
    if (!data) return badRequest();
    shareId = data.get("shareId");
    code = data.get("code");
  } else {
    const body = await parseJsonBody<{ shareId?: unknown; code?: unknown }>(req);
    if (body === BAD_REQUEST) return badRequest();
    ({ shareId, code } = body);
  }
  if (typeof shareId !== "string" || !SHARE_ID.test(shareId)) return badRequest();

  let state: ClaimCheckState;
  if (limited) state = "limited";
  else if (typeof code !== "string" || !code.trim()) state = "none";
  else if (!claimCodeFor(shareId)) state = "unavailable";
  else state = verifyClaimCode(shareId, code.slice(0, 12)) ? "match" : "mismatch";

  if (form) {
    // 303: the browser GETs the page; the typed code is not in the location.
    const to = new URL(`/verify/${encodeURIComponent(shareId)}`, req.url);
    to.searchParams.set("claimed", state);
    return NextResponse.redirect(to, { status: 303, headers: { "Cache-Control": "no-store" } });
  }
  if (limited) return limited;
  return NextResponse.json({ state }, { headers: { "Cache-Control": "no-store" } });
}

