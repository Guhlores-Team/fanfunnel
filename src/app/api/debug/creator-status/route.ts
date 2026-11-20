import { NextResponse } from "next/server";
import { isSupabaseConfigured } from "@/lib/supabase/server";
import { requireAdminRoute } from "@/lib/auth/admin";
import { BAD_REQUEST, parseJsonBody } from "@/lib/api/handler";
import { mockSetDemoCreatorActive } from "@/lib/data/mock";

const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

/**
 * Demo/e2e only (FD-3): suspend or restore the in-memory demo creator, so the
 * fan page's "link not active" state can be exercised. A plain 404 wherever
 * real data exists (Supabase configured) and in every non-debug build.
 */
export async function POST(req: Request) {
  if (isSupabaseConfigured() || process.env.NEXT_PUBLIC_ENABLE_DEBUG !== "1") return json({ error: "not_found" }, 404);
  const admin = await requireAdminRoute();
  if (!admin.ok) { admin.response.headers.set("Cache-Control", "no-store"); return admin.response; }
  const body = await parseJsonBody<Record<string, unknown>>(req);
  if (body === BAD_REQUEST || !body || typeof body !== "object" || Array.isArray(body)
    || Object.keys(body).length !== 1 || typeof body.active !== "boolean") return json({ error: "bad_request" }, 400);
  return json(mockSetDemoCreatorActive(body.active));
}
