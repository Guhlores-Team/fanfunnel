import { NextResponse } from "next/server";
import { createCreatorAccount } from "@/lib/data";
import { isAcceptablePassword } from "@/lib/api/password";
import { BAD_REQUEST, badRequest, errorResponse, parseJsonBody } from "@/lib/api/handler";

// Admin creates a creator account directly (no public sign-up needed).
export async function POST(req: Request) {
  const body = await parseJsonBody<{
    email?: string;
    password?: string;
    displayName?: string;
  }>(req);
  if (body === BAD_REQUEST) return badRequest();
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
  if ("error" in result) return errorResponse(result.error);
  return NextResponse.json(result);
}
