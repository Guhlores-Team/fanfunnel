import { NextResponse } from "next/server";
import { isSupabaseConfigured } from "@/lib/supabase/server";
import { requireAdminRoute } from "@/lib/auth/admin";
import { BAD_REQUEST, parseJsonBody } from "@/lib/api/handler";
import { mockGameFixture } from "@/lib/data/mock";
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
/** Seed search for local browser fixtures. Never available on a configured backend. */
export async function POST(req: Request) {
  if (isSupabaseConfigured() || process.env.NEXT_PUBLIC_ENABLE_DEBUG !== "1") return json({ error: "not_found" }, 404);
  const admin = await requireAdminRoute();
  if (!admin.ok) { admin.response.headers.set("Cache-Control", "no-store"); return admin.response; }
  const body = await parseJsonBody<Record<string, unknown>>(req);
  if (body === BAD_REQUEST || !body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 3 ||
      typeof body.token !== "string" || !/^[A-Za-z0-9_-]{4,128}$/.test(body.token) ||
      typeof body.clientSeed !== "string" || body.clientSeed.length > 256 ||
      typeof body.targetPrizeId !== "string" || !body.targetPrizeId || body.targetPrizeId.length > 256 ||
      Object.keys(body).some(key => !["token", "clientSeed", "targetPrizeId"].includes(key))) return json({ error: "bad_request" }, 400);
  const result = await mockGameFixture(body.token, body.clientSeed, body.targetPrizeId);
  return json(result, "error" in result ? result.error === "not_found" ? 404 : 409 : 200);
}
