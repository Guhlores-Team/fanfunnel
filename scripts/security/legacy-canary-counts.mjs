// Count-only TEST rollout evidence. Never initializes an anchor or validates a key.
export const LEGACY_CANARY_TEST_REF = "snmcrmhgevfqggxdiomu";
export const LEGACY_CANARY_COUNT_TIMEOUT_MS = 5_000;

/** The fixed project guard must run before creating/accessing any client.
 * @param {unknown} projectUrl
 */
export function isLegacyCanaryTestProject(projectUrl) {
  if (typeof projectUrl !== "string") return false;
  try {
    const url = new URL(projectUrl);
    return url.protocol === "https:" && url.hostname === `${LEGACY_CANARY_TEST_REF}.supabase.co`
      && url.port === "" && url.pathname === "/" && !url.search && !url.hash
      && !url.username && !url.password;
  } catch { return false; }
}

/** @typedef {"wrong_project"|"invalid_deadline"|"relation_unavailable"|"query_failed"|"invalid_count"|"unexpected_body"|"timeout"} UnavailableReason */
/** @typedef {{status:"available",nonErasedCodeRows:number,erasedCodeRows:number,rewardKeyAnchorRows:number,keyValidation:"NOT_PERFORMED"}} AvailableCounts */
/** @typedef {{status:"unavailable",reason:UnavailableReason,keyValidation:"NOT_PERFORMED"}} UnavailableCounts */
/** @param {UnavailableReason} reason @returns {UnavailableCounts} */
const unavailable = reason => ({ status: "unavailable", reason, keyValidation: "NOT_PERFORMED" });
const INVALID_COUNT = Symbol("invalid_count"), UNEXPECTED_BODY = Symbol("unexpected_body");
const RELATION_UNAVAILABLE = Symbol("relation_unavailable"), QUERY_FAILED = Symbol("query_failed"), TIMEOUT = Symbol("timeout");

/**
 * Three HEAD/exact-count reads, with no row body. Non-erased includes assigned
 * and unassigned codes; it is NOT unused stock or a complete encrypted inventory
 * count. ANY erased_at IS NOT NULL row matches the0063 enrollment tombstone gate.
 * Anchor count0/1 proves presence only, never the deployed keys or original keys.
 * @param {{projectUrl:unknown,clientFactory:()=>import("@supabase/supabase-js").SupabaseClient,timeoutMs?:number}} options
 * @returns {Promise<AvailableCounts|UnavailableCounts>}
 */
export async function readLegacyCanaryCounts({ projectUrl, clientFactory, timeoutMs = LEGACY_CANARY_COUNT_TIMEOUT_MS }) {
  if (!isLegacyCanaryTestProject(projectUrl)) return unavailable("wrong_project");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > LEGACY_CANARY_COUNT_TIMEOUT_MS) return unavailable("invalid_deadline");
  const controller = new AbortController();
  /** @type {ReturnType<typeof setTimeout>|undefined} */
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(TIMEOUT); }, timeoutMs);
  });
  try {
    const client = clientFactory();
    const head = { head: true, count: /** @type {const} */ ("exact") };
    // A one-shot snapshot must not hide SDK retries inside its shared deadline.
    const pending = [
      client.from("prize_reward_codes").select("erased_at", head).is("erased_at", null).limit(1).retry(false).abortSignal(controller.signal),
      client.from("prize_reward_codes").select("erased_at", head).not("erased_at", "is", null).limit(1).retry(false).abortSignal(controller.signal),
      client.from("reward_crypto_canary").select("singleton", head).eq("singleton", true).limit(1).retry(false).abortSignal(controller.signal),
    ];
    const counts = await Promise.race([Promise.all(pending), deadline]);
    if (!Array.isArray(counts) || counts.length !== 3) throw QUERY_FAILED;
    for (const result of counts) {
      if (result.error) {
        // REST errors cannot distinguish missing schema from stale/unexposed cache.
        if (["42P01", "PGRST205"].includes(result.error.code)) throw RELATION_UNAVAILABLE;
        throw QUERY_FAILED;
      }
      if (result.data !== null) throw UNEXPECTED_BODY;
      if (!Number.isSafeInteger(result.count) || result.count < 0) throw INVALID_COUNT;
    }
    if (counts[2].count > 1) throw INVALID_COUNT;
    return { status: "available", nonErasedCodeRows: counts[0].count, erasedCodeRows: counts[1].count,
      rewardKeyAnchorRows: counts[2].count, keyValidation: "NOT_PERFORMED" };
  } catch (error) {
    return unavailable(error === TIMEOUT ? "timeout" : error === RELATION_UNAVAILABLE ? "relation_unavailable"
      : error === INVALID_COUNT ? "invalid_count" : error === UNEXPECTED_BODY ? "unexpected_body" : "query_failed");
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
