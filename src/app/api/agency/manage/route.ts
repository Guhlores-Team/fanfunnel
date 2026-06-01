import { NextResponse } from "next/server";
import {
  createOrg,
  addOrgCreator,
  removeOrgCreator,
  addOrgMember,
  removeOrgMember,
  scopeOrgCreator,
  type OrgRole,
} from "@/lib/data";

// Owner-guarded agency mutations. Each RPC re-checks ownership server-side, so
// this route only dispatches. Body: { action, ...args }.
export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const action = body.action as string;
  const s = (k: string) => String(body[k] ?? "");

  let result: { ok: true } | { error: string };
  switch (action) {
    case "create_org":
      result = await createOrg(s("name"));
      break;
    case "add_creator":
      result = await addOrgCreator(s("orgId"), s("email"));
      break;
    case "remove_creator":
      result = await removeOrgCreator(s("orgId"), s("creatorId"));
      break;
    case "add_member":
      result = await addOrgMember(s("orgId"), s("email"), s("role") as OrgRole);
      break;
    case "remove_member":
      result = await removeOrgMember(s("memberId"));
      break;
    case "scope_creator":
      result = await scopeOrgCreator(s("memberId"), s("creatorId"), Boolean(body.on));
      break;
    default:
      return NextResponse.json({ error: "unknown_action" }, { status: 400 });
  }

  if ("error" in result) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  return NextResponse.json(result);
}
