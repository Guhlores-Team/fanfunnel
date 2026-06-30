import { NextResponse } from "next/server";
import { updateAccount } from "@/lib/data";
import type { AppRole } from "@/lib/data/types";
import { BAD_REQUEST, badRequest, errorResponse, parseJsonBody } from "@/lib/api/handler";

// Update a creator account: role, active status, or feature flags.
export async function POST(req: Request) {
  const body = await parseJsonBody<{
    id?: string;
    role?: AppRole;
    isActive?: boolean;
    features?: Record<string, boolean>;
  }>(req);
  if (body === BAD_REQUEST) return badRequest();
  if (!body.id) {
    return badRequest();
  }
  if (body.role && body.role !== "admin" && body.role !== "creator") {
    return badRequest();
  }

  const result = await updateAccount(body.id, {
    role: body.role,
    isActive: body.isActive,
    features: body.features,
  });
  if ("error" in result) return errorResponse(result.error);
  return NextResponse.json(result);
}
