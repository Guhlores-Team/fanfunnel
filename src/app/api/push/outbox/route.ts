import { NextResponse } from "next/server";
import { isSupabaseConfigured } from "@/lib/supabase/server";
import { mockPushOutbox } from "@/lib/data/mockPush";

// DEMO ONLY: what the simulated push service received (the demo never sends a
// real push). Lets e2e check that a push says exactly what the bell says (F8).
// With Supabase configured this route does not exist: 404, nothing read.
export async function GET() {
  if (isSupabaseConfigured()) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ deliveries: mockPushOutbox() }, { headers: { "Cache-Control": "no-store" } });
}
