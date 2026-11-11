// Grouping key for monitored errors: SHA-256 of the normalized message, the
// normalized top stack frame and the source (client/server). Normalizing drops
// what changes between occurrences of the SAME bug (numbers, ids, line/column,
// deploy-specific chunk hashes, origins) so repeats bump one row's count.
import type { ErrorSource } from "./config";

/** Message with volatile parts (numbers, ids, hex) replaced by placeholders. */
export function normalizeMessage(message: string): string {
  return message
    .replace(/^(uncaught\s+)+(\(in promise\)\s*)?/i, "")
    .replace(/\[(?:uuid|id|redacted|email|jwt|ip|token)\]/g, "<id>")
    .replace(/\b[0-9a-f]{8,}\b/gi, "<hex>")
    .replace(/\b\d+(?:\.\d+)?\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

const V8_FRAME = /^\s*at\s+/;
const GECKO_FRAME = /^[^\s@]*@\S+/;

/** One stack frame with its location made deploy-independent. */
export function normalizeFrame(frame: string): string {
  return frame
    .trim()
    .replace(/^at\s+/, "")
    .replace(/(?:https?|webpack-internal|file):\/{2,3}[^/\s)]*/g, "")
    .replace(/\?[^\s):]*/g, "")
    .replace(/:\d+(?::\d+)?(?=\)|$)/g, "")
    .replace(/[0-9a-f]{8,}/gi, "[hash]")
    .replace(/\s+/g, " ")
    .slice(0, 300);
}

/** The first real frame of a V8 ("at fn (file:1:2)") or Gecko/WebKit ("fn@file:1:2") stack. */
export function topFrame(stack: string | undefined | null): string {
  if (!stack) return "";
  for (const line of stack.split("\n")) {
    if (V8_FRAME.test(line) || GECKO_FRAME.test(line.trim())) return normalizeFrame(line);
  }
  return "";
}

async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** 64-hex grouping key for an error. Inputs must already be redacted. */
export async function fingerprint(input: {
  message: string;
  stack?: string | null;
  source: ErrorSource;
}): Promise<string> {
  return sha256Hex(`${input.source}\n${normalizeMessage(input.message)}\n${topFrame(input.stack)}`);
}
