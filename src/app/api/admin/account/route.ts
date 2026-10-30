import { NextResponse } from "next/server";
import { recordAudit, updateAccount } from "@/lib/data";
import { requireAdminRoute } from "@/lib/auth/admin";
import type { AppRole } from "@/lib/data/types";
import { BAD_REQUEST, badRequest, errorResponse, parseJsonBody } from "@/lib/api/handler";

// Update a creator account: role, active status, or feature flags.
export async function POST(req: Request) {
  const admin = await requireAdminRoute();
  if (!admin.ok) return admin.response;
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

  // One activity entry per kind of change (ids and flags only, no PII).
  const target = { actorId: admin.userId, targetType: "profile" as const, targetId: body.id };
  if (body.role) {
    await recordAudit({ ...target, action: "account.role_change", details: { role: body.role } });
  }
  if (typeof body.isActive === "boolean") {
    await recordAudit({ ...target, action: body.isActive ? "account.reactivate" : "account.suspend" });
  }
  if (body.features && typeof body.features === "object") {
    const flags: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(body.features)) if (typeof v === "boolean") flags[k] = v;
    await recordAudit({ ...target, action: "account.features_change", details: { features: flags } });
  }
  return NextResponse.json(result);
}
