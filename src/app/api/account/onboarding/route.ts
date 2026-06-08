import { NextResponse } from "next/server";
import { setOnboardingDismissed } from "@/lib/data";

// Persist the creator's Get-started checklist dismissal to their account, so it
// follows them across devices instead of living in one browser's localStorage.
export async function POST(req: Request) {
  let body: { dismissed?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  if (typeof body.dismissed !== "boolean") {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const result = await setOnboardingDismissed(body.dismissed);
  if ("error" in result) {
    const status = result.error === "unauthorized" ? 401 : 400;
    return NextResponse.json({ error: result.error }, { status });
  }
  return NextResponse.json(result);
}
