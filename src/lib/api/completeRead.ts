import { NextResponse } from "next/server";
import { CompleteReadError } from "@/lib/data/readPages";

/** A report may never publish a partial amount as a complete financial total. */
export async function completeReadResponse(read: () => Promise<Response>): Promise<Response> {
  try { return await read(); }
  catch (error) {
    if (!(error instanceof CompleteReadError)) throw error;
    return NextResponse.json({ error: "data_unavailable", dataStatus: "unavailable" }, { status: 503, headers: { "Cache-Control": "no-store", "Retry-After": "30" } });
  }
}
