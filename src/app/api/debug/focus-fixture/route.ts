import { NextResponse } from "next/server";
import { isSupabaseConfigured } from "@/lib/supabase/server";
import { requireAdminRoute } from "@/lib/auth/admin";
import { mockFocusState } from "@/lib/data/mockFocus";
import { BAD_REQUEST, parseJsonBody } from "@/lib/api/handler";
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
/** Local demo test fixture only. It can never toggle a real creator's rollout. */
export async function POST(req: Request) {
  if (process.env.NEXT_PUBLIC_ENABLE_DEBUG !== "1" || isSupabaseConfigured()) return json({ error: "not_found" }, 404);
  const admin = await requireAdminRoute();
  if (!admin.ok) { admin.response.headers.set("Cache-Control", "no-store"); return admin.response; }
  const body = await parseJsonBody<{ chaseEnabled?: unknown }>(req);
  if (body === BAD_REQUEST || !body || typeof body !== "object" || typeof body.chaseEnabled !== "boolean" || Object.keys(body).some(key => key !== "chaseEnabled")) return json({ error: "bad_request" }, 400);
  mockFocusState().chaseEnabled = body.chaseEnabled;
  return json({ chaseEnabled: mockFocusState().chaseEnabled });
}
