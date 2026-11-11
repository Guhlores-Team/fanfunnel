import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";

/** Shortest CRON_SECRET the cron route accepts (shorter = route refuses all). */
export const MIN_CRON_SECRET_LENGTH = 16;

/**
 * Constant-time check of a request's Authorization header against
 * `Bearer $CRON_SECRET` (what Vercel Cron sends). No secret, a short secret or
 * no header → false.
 */
export function cronAuthorized(header: string | null, secret: string | undefined): boolean {
  if (!secret || secret.length < MIN_CRON_SECRET_LENGTH || !header) return false;
  const a = createHash("sha256").update(header).digest();
  const b = createHash("sha256").update(`Bearer ${secret}`).digest();
  return timingSafeEqual(a, b);
}
