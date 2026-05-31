import { NextResponse } from "next/server";
import { createCreatorAccount } from "@/lib/data";

// Admin creates a creator account directly (no public sign-up needed).
export async function POST(req: Request) {
  let body: { email?: string; password?: string; displayName?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const email = (body.email ?? "").trim();
  const password = body.password ?? "";
  if (!email || password.length < 6) {
    return NextResponse.json(
      { error: "Email and a 6+ char password are required." },
      { status: 400 }
    );
  }

  const result = await createCreatorAccount(
    email,
    password,
    (body.displayName ?? "").trim()
  );
  if ("error" in result) {
    const status = result.error === "unauthorized" ? 403 : 400;
    return NextResponse.json(result, { status });
  }
  return NextResponse.json(result);
}
