/**
 * A transient database fault (or a read past its deadline) while serving a
 * fan-facing page: the page must show its "temporarily unavailable, nothing
 * was spent" boundary and offer a retry, never "link/page not found".
 */
export class FanPassUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FanPassUnavailableError";
  }
}

/**
 * PR-13 (0073): `fan_passes.expires_at` (null = never). Every spin RPC treats
 * `expires_at <= now()` as a link that is not live; the fan-page reads use
 * this so an expired link looks exactly like one that was switched off.
 */
export function fanLinkExpired(expiresAt: string | null | undefined, now: number = Date.now()): boolean {
  if (!expiresAt) return false;
  const at = Date.parse(expiresAt);
  // An unreadable date fails closed: the database would refuse the spin anyway.
  return !Number.isFinite(at) || at <= now;
}

/** OPS3-02: one database call on the fan read path may take this long. */
export const FAN_READ_TIMEOUT_MS = 4_000;
/** OPS3-02: a whole fan page read (several calls) may take this long. */
export const FAN_PAGE_DEADLINE_MS = 10_000;
/** OPS3-02: one spin RPC (prepare / commit / cancel) may take this long. */
export const SPIN_RPC_TIMEOUT_MS = 8_000;

/**
 * Resolve `work` or throw FanPassUnavailableError once `ms` have passed. The
 * underlying calls carry their own abort signals; this bounds a chain of them.
 */
export async function withFanDeadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new FanPassUnavailableError(`${what} timed out`)), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** A PostgREST/Postgres error that means a column this code reads does not exist. */
export function isMissingColumnError(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  return error.code === "42703" || error.code === "PGRST204" || /column .* does not exist/i.test(error.message ?? "");
}
