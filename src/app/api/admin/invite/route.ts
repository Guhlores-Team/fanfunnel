import { NextResponse } from "next/server";
import { createCreatorAccount } from "@/lib/data";
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
  if ("error" in result) return errorResponse(result.error);
  return NextResponse.json(result);
}
