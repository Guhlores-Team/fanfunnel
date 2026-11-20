import { safeNext } from "./safeNext";
/** Fixed return destinations prevent credentials, arbitrary query data and
 * /mfa itself from becoming a recovery URL. Never store/retry form contents. */
export function creatorMfaRecoveryHref(destination: unknown): string {
  const next = destination === "admin" ? "/admin"
    : destination === "reset" ? "/dashboard?section=settings"
    : "/dashboard?section=settings";
  return "/mfa?next=" + encodeURIComponent(safeNext(next));
}
