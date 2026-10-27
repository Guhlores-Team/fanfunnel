import { NextResponse } from "next/server";
import { requireAdminRoute } from "@/lib/auth/admin";
import { BAD_REQUEST, badRequest, errorResponse, parseJsonBody } from "@/lib/api/handler";
import { listAppErrors, resolveAppError, type ErrorStatusFilter } from "@/lib/data/appErrors";
import type { ErrorEnvironment } from "@/lib/monitoring/config";

const STATUSES: readonly ErrorStatusFilter[] = ["open", "resolved"];
const ENVIRONMENTS: readonly ErrorEnvironment[] = ["production", "preview", "development"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Admin › Errors. Both handlers check is_admin() (role AND is_active) first;
// the data layer then reads/updates with the caller's own client, so RLS on
// app_errors (admin-only) applies as a second gate.

// GET ?status=open|resolved&env=production|preview|development
export async function GET(req: Request) {
  const admin = await requireAdminRoute();
  if (!admin.ok) return admin.response;
  const url = new URL(req.url);
  const status = url.searchParams.get("status") ?? "open";
  const env = url.searchParams.get("env") || undefined;
  if (!STATUSES.includes(status as ErrorStatusFilter)) return badRequest();
  if (env !== undefined && !ENVIRONMENTS.includes(env as ErrorEnvironment)) return badRequest();
  const errors = await listAppErrors({
    status: status as ErrorStatusFilter,
    environment: env as ErrorEnvironment | undefined,
  });
  if (!Array.isArray(errors)) return NextResponse.json({ error: errors.error }, { status: 500 });
  return NextResponse.json({ errors });
}

// POST { id, resolved } — resolve (or reopen) one grouped error.
export async function POST(req: Request) {
  const admin = await requireAdminRoute();
  if (!admin.ok) return admin.response;
  const body = await parseJsonBody<{ id?: unknown; resolved?: unknown }>(req);
  if (body === BAD_REQUEST || !body || typeof body !== "object") return badRequest();
  const { id, resolved = true } = body;
  if (typeof id !== "string" || !UUID.test(id) || typeof resolved !== "boolean") return badRequest();
  const result = await resolveAppError(id, resolved);
  if ("error" in result) {
    return result.error === "not_found" ? errorResponse("not_found") : NextResponse.json({ error: result.error }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
