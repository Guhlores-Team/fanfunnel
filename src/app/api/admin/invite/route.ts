import { NextResponse } from "next/server";
import { createCreatorAccount } from "@/lib/data";
import { isAcceptablePassword } from "@/lib/api/password";

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
  if (!email || !isAcceptablePassword(password)) {
    return NextResponse.json(
      { error: "Email and an 8+ char password containing a letter and a number are required." },
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
