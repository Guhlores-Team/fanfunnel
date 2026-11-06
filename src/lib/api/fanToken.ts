import type { NextResponse } from "next/server";
import { clientIp } from "@/lib/api/clientIp";
import { rateLimitOr429 } from "@/lib/api/limit";
import { BAD_REQUEST, badRequest, parseJsonBody } from "@/lib/api/handler";

/** Longest link token a fan route accepts (minted tokens are far shorter). */
export const FAN_TOKEN_MAX = 256;

/**
 * Shared foundation F5: the front half of every fan endpoint that is
 * authenticated only by the link token (fans have no Supabase session).
 *
 *   1. parse the JSON body (400 on a bad body or a missing / oversized token);
 *   2. rate-limit per scope, client IP and token (429);
 *   3. hand the token and body to `fn`.
 *
 * `fn` calls a data-layer function that resolves the fan behind the token on
 * the service client, server-side only, and refuses an unknown, inactive,
 * paused or blocked link in one place (not_found / blocked). The token is the
 * only key: nothing in the body can name another fan.
 */
export async function withFanToken<B extends { token?: unknown }>(
  req: Request,
  opts: { scope: string; limit: number; windowMs: number },
  fn: (token: string, body: B) => Promise<NextResponse>,
): Promise<NextResponse> {
  const body = await parseJsonBody<B>(req);
  if (body === BAD_REQUEST || !body || typeof body !== "object") return badRequest();
  const token = body.token;
  if (typeof token !== "string" || !token || token.length > FAN_TOKEN_MAX) return badRequest();
  const limited = await rateLimitOr429(`${opts.scope}:${clientIp(req)}:${token}`, opts.limit, opts.windowMs);
  if (limited) return limited;
  return fn(token, body);
}
