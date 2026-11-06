// The wire format of POST /api/errors and its strict validator. Pure: no I/O,
// so the route and the tests share one definition.
import { ERROR_REPORT_MAX_BYTES } from "./config";

export const REPORT_KINDS = ["error", "unhandledrejection", "react"] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

/** What a browser may send. Every other key is rejected. */
export interface ClientReport {
  message: string;
  kind: ReportKind;
  stack?: string;
  route?: string;
  digest?: string;
}

const ALLOWED_KEYS = new Set(["message", "kind", "stack", "route", "digest"]);
// Input caps (generous; stored values are truncated further after redaction).
const IN_MESSAGE = 4000;
const IN_STACK = 12000;
const IN_ROUTE = 2048;

/** Validate a parsed JSON body. Returns the report, or null for anything off-schema. */
export function parseClientReport(raw: unknown): ClientReport | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!ALLOWED_KEYS.has(k)) return null;

  const { message, kind = "error", stack, route, digest } = o;
  if (typeof message !== "string") return null;
  const msg = message.trim();
  if (!msg || msg.length > IN_MESSAGE) return null;
  if (typeof kind !== "string" || !(REPORT_KINDS as readonly string[]).includes(kind)) return null;
  if (stack !== undefined && (typeof stack !== "string" || stack.length > IN_STACK)) return null;
  if (route !== undefined && (typeof route !== "string" || route.length > IN_ROUTE)) return null;
  if (digest !== undefined && (typeof digest !== "string" || !/^[\w-]{1,64}$/.test(digest))) return null;

  return {
    message: msg,
    kind: kind as ReportKind,
    ...(stack ? { stack } : {}),
    ...(route ? { route } : {}),
    ...(digest ? { digest } : {}),
  };
}

/**
 * Browser noise that carries no actionable information: cross-origin
 * "Script error.", ResizeObserver loop warnings, and errors thrown inside
 * browser extensions.
 */
export function isNoise(message: string, stack?: string | null): boolean {
  if (/^(uncaught\s+)?script error\.?$/i.test(message.trim())) return true;
  if (/ResizeObserver loop/i.test(message)) return true;
  const where = `${message}\n${stack ?? ""}`;
  return /\b(?:chrome|moz|safari(?:-web)?)-extension:\/\//i.test(where);
}

/**
 * Read a request body as text, refusing more than `max` bytes WITHOUT
 * buffering the excess: a declared Content-Length over the cap is refused up
 * front, and a streamed body is cut off as soon as it crosses the cap.
 */
export async function readCappedText(
  req: Request,
  max: number = ERROR_REPORT_MAX_BYTES,
): Promise<string | "too_large"> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > max) return "too_large";
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return "too_large";
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}
