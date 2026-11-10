// Browser-safe: no imports. Installed once by src/instrumentation-client.ts.
//
// RS-04 made every /api answer `private, no-store`. A no-store response whose
// body the page never reads does not finish loading in Chromium: the request
// stays pending, and a browser test (or DevTools) that asks for that body
// waits for ever. Dozens of call sites only look at `res.ok` after a write.
// Rather than police each of them, the page's one `fetch` is wrapped here: for
// a same-origin /api JSON answer marked no-store, a CLONE is read to the end
// in the background. The caller gets the very same promise and Response, still
// unread and readable; nothing else about the request changes.

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type FetchHost = { fetch?: FetchLike; location?: { origin?: string } };
const MARK = "__ffApiDrain";

/** Whether this answer is one the page must read to the end (see above). */
export function shouldDrainApiResponse(res: Pick<Response, "url" | "status" | "headers" | "body" | "bodyUsed">, origin: string): boolean {
  try {
    if (!res.body || res.bodyUsed || res.status === 204 || res.status === 304) return false;
    const url = new URL(res.url);
    if (url.origin !== origin || !url.pathname.startsWith("/api/")) return false;
    // Downloads and streams are the caller's to read; only small JSON answers are drained.
    if (res.headers.get("content-disposition")) return false;
    if (!/\bjson\b/i.test(res.headers.get("content-type") ?? "")) return false;
    return /\bno-store\b/i.test(res.headers.get("cache-control") ?? "");
  } catch {
    return false;
  }
}

/** Read a clone to the end; never throws, never touches the caller's body. */
export function drainApiResponse(res: Response, origin: string): boolean {
  try {
    if (!shouldDrainApiResponse(res, origin)) return false;
    void res.clone().text().catch(() => undefined);
    return true;
  } catch {
    // Already being read by the caller: then it will finish on its own.
    return false;
  }
}

/** Wrap `host.fetch` once (idempotent). The returned promise is the original one. */
export function installApiResponseDrain(host: FetchHost = globalThis as FetchHost): boolean {
  const original = host.fetch;
  const origin = host.location?.origin;
  if (typeof original !== "function" || !origin || (original as unknown as Record<string, unknown>)[MARK]) return false;
  const wrapped: FetchLike = function (this: unknown, input, init) {
    const pending = original.call(host, input, init);
    // Registered before the caller's own continuation, so the clone is taken
    // while the body is still untouched. A rejected fetch is the caller's.
    pending.then((res) => { drainApiResponse(res, origin); }, () => undefined);
    return pending;
  };
  Object.defineProperty(wrapped, MARK, { value: true });
  host.fetch = wrapped;
  return true;
}
