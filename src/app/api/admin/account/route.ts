import { NextResponse } from "next/server";
import { updateAccount } from "@/lib/data";
import type { AppRole } from "@/lib/data/types";

// Update a creator account: role, active status, or feature flags.
export async function POST(req: Request) {
  let body: {
    id?: string;
    role?: AppRole;
    isActive?: boolean;
    features?: Record<string, boolean>;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!body.id) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (body.role && body.role !== "admin" && body.role !== "creator") {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const result = await updateAccount(body.id, {
    role: body.role,
    isActive: body.isActive,
    features: body.features,
  });
  if ("error" in result) {
    const status = result.error === "unauthorized" ? 403 : 400;
    return NextResponse.json(result, { status });
  }
  return NextResponse.json(result);
}
