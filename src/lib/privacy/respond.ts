import { NextResponse } from "next/server";
import { sha256Hex } from "@/lib/games/wheel/fairness";

/** Headers for every response that carries personal data or a data action. */
export const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
  Pragma: "no-cache",
} as const;

/** `{ error }` with no-store (privacy routes never let a cache keep anything). */
export function privateError(error: string, status: number, extra?: Record<string, unknown>): NextResponse {
  return NextResponse.json({ error, ...extra }, { status, headers: NO_STORE_HEADERS });
}

/** `{ ok… }` with no-store. */
export function privateJson(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE_HEADERS });
}

/** A JSON file download, never cached, never sniffed. */
export function jsonDownload(data: unknown, fileName: string): NextResponse {
  return new NextResponse(JSON.stringify(data, null, 2), {
    status: 200,
    headers: {
      ...NO_STORE_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${fileName.replace(/[^\w.-]/g, "_")}"`,
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/** A rate-limit key for a fan token that doesn't put the token itself in the
 *  limiter store (it may be a shared Upstash instance). */
export async function tokenKey(prefix: string, token: string): Promise<string> {
  return `${prefix}:${(await sha256Hex(token)).slice(0, 32)}`;
}
