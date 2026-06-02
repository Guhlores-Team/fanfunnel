import { NextResponse } from "next/server";
import { clearMyData } from "@/lib/data";

// Wipe ALL of the signed-in creator's data (wheels, fans, spins, campaigns…).
// Destructive — the client double-confirms before calling this.
export async function POST() {
  const result = await clearMyData();
  if ("error" in result) {
    const status = result.error === "unauthorized" ? 401 : 400;
    return NextResponse.json({ error: result.error }, { status });
  }
  return NextResponse.json(result);
}
