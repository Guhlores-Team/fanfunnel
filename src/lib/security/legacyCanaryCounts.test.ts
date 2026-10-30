import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { isLegacyCanaryTestProject, readLegacyCanaryCounts, LEGACY_CANARY_COUNT_TIMEOUT_MS } from "../../../scripts/security/legacy-canary-counts.mjs";

const TEST_URL = "https://snmcrmhgevfqggxdiomu.supabase.co";
type Call = { method: string; url: URL; prefer: string | null; signal: AbortSignal | null };
type Behavior = { counts?: [number | null, number | null, number | null]; missingAnchor?: boolean; fail?: boolean; reject?: boolean; stall?: boolean };
let checks = 0;
const check = (label: string, condition: unknown) => { assert.ok(condition, label); checks++; };
function fixture(behavior: Behavior = {}) {
  const calls: Call[] = [];
  let factories = 0;
  const factory = () => {
    factories++;
    return createClient(TEST_URL, "disposable-count-test-key", {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
      global: { fetch: async (input, init) => {
        const request = input instanceof Request ? input : null;
        const url = new URL(request ? request.url : String(input));
        const method = init?.method ?? request?.method ?? "GET";
        const headers = new Headers(init?.headers ?? request?.headers);
        calls.push({ method, url, prefer: headers.get("prefer"), signal: init?.signal ?? request?.signal ?? null });
        assert.equal(method, "HEAD", "no read may turn into a mutation or row-body request");
        assert.equal(url.hostname, "snmcrmhgevfqggxdiomu.supabase.co");
        if (behavior.stall) return new Promise<Response>(() => {}); // Deliberately ignores abort: outer deadline must still bound it.
        if (behavior.reject) throw new Error("private-marker ciphertext token key must never appear in output");
        const anchor = url.pathname.endsWith("/reward_crypto_canary");
        if ((anchor && behavior.missingAnchor) || behavior.fail) return new Response(JSON.stringify({ code: behavior.missingAnchor ? "PGRST205" : "XX000", message: "private-marker must never appear in output" }), { status: 500, headers: { "content-type": "application/json" } });
        const index = anchor ? 2 : url.searchParams.get("erased_at") === "is.null" ? 0 : 1;
        const count = (behavior.counts ?? [1200, 7, 1])[index];
        return new Response(null, { status: 200, headers: count === null ? {} : { "content-range": count === 0 ? "*/0" : `0-0/${count}` } });
      } },
    });
  };
  return { calls, factory, factories: () => factories };
}

async function main() {
  check("fixed TEST base accepted", isLegacyCanaryTestProject(TEST_URL));
  for (const projectUrl of ["https://ttlogfmogcccwiraaoae.supabase.co", "https://other.supabase.co", TEST_URL + ".evil.test", "http://snmcrmhgevfqggxdiomu.supabase.co", TEST_URL + "/rest/v1", TEST_URL + "?token=private-marker", "https://user:password@snmcrmhgevfqggxdiomu.supabase.co", "bad URL", undefined]) {
    const f = fixture();
    const result = await readLegacyCanaryCounts({ projectUrl, clientFactory: f.factory });
    check("wrong project/base refuses before factory or I/O", result.status === "unavailable" && result.reason === "wrong_project" && f.factories() === 0 && f.calls.length === 0);
    check("refusal never echoes supplied URL/credential", !JSON.stringify(result).includes("private-marker") && !JSON.stringify(result).includes("password"));
  }
  const f = fixture();
  const available = await readLegacyCanaryCounts({ projectUrl: TEST_URL, clientFactory: f.factory });
  assert.deepEqual(available, { status: "available", nonErasedCodeRows: 1200, erasedCodeRows: 7, rewardKeyAnchorRows: 1, keyValidation: "NOT_PERFORMED" }); checks++;
  check("one factory, exactly three HEAD calls", f.factories() === 1 && f.calls.length === 3 && f.calls.every(call => call.method === "HEAD"));
  check("HEAD exact count with bounded returned range", f.calls.every(call => call.prefer?.includes("count=exact") && call.url.searchParams.get("limit") === "1"));
  check("queries select no ID/cipher/fingerprint or row content", f.calls.every(call => ["erased_at", "singleton"].includes(call.url.searchParams.get("select") ?? "")));
  check("erased predicate matches ANY tombstone gate", f.calls[0].url.searchParams.get("erased_at") === "is.null" && f.calls[1].url.searchParams.get("erased_at") === "not.is.null");
  check("anchor evidence is singleton presence only", f.calls[2].url.searchParams.get("singleton") === "eq.true" && available.keyValidation === "NOT_PERFORMED");
  check("all count work abort signals released", f.calls.every(call => call.signal?.aborted));
  const empty = fixture({ counts: [0, 0, 0] });
  assert.deepEqual(await readLegacyCanaryCounts({ projectUrl: TEST_URL, clientFactory: empty.factory }), { status: "available", nonErasedCodeRows: 0, erasedCodeRows: 0, rewardKeyAnchorRows: 0, keyValidation: "NOT_PERFORMED" }); checks++;
  for (const behavior of [{ counts: [1, null, 0] }, { counts: [-1, 0, 0] }, { counts: [Number.MAX_SAFE_INTEGER + 1, 0, 0] }, { counts: [0, 0, 2] }] satisfies Behavior[]) {
    const invalid = fixture(behavior);
    const result = await readLegacyCanaryCounts({ projectUrl: TEST_URL, clientFactory: invalid.factory });
    check("missing/negative/unsafe/impossible count is unavailable, never zero", result.status === "unavailable" && result.reason === "invalid_count" && !("nonErasedCodeRows" in result));
  }
  const missing = fixture({ missingAnchor: true });
  const relationUnavailable = await readLegacyCanaryCounts({ projectUrl: TEST_URL, clientFactory: missing.factory });
  check("missing/stale/unexposed REST relation is unavailable, never an empty anchor or catalog fact", relationUnavailable.status === "unavailable" && relationUnavailable.reason === "relation_unavailable");
  for (const behavior of [{ fail: true }, { reject: true }]) {
    const failed = fixture(behavior);
    const result = await readLegacyCanaryCounts({ projectUrl: TEST_URL, clientFactory: failed.factory });
    check("query failure is explicit and redacted", result.status === "unavailable" && result.reason === "query_failed" && !JSON.stringify(result).includes("private-marker"));
  }
  let failedFactories = 0;
  const factoryFailure = await readLegacyCanaryCounts({ projectUrl: TEST_URL, clientFactory: () => {
    failedFactories++; throw new Error("private-marker factory configuration must not be logged");
  } });
  check("factory failures remain explicit and redacted", failedFactories === 1 && factoryFailure.status === "unavailable" && factoryFailure.reason === "query_failed" && !JSON.stringify(factoryFailure).includes("private-marker"));
  const leakedBody = { error: null, data: [{ cipher: "private-marker" }], count: 1 };
  const query = { select: () => query, is: () => query, not: () => query, eq: () => query, limit: () => query, retry: () => query, abortSignal: async () => leakedBody };
  const bodyFailure = await readLegacyCanaryCounts({ projectUrl: TEST_URL, clientFactory: () => ({ from: () => query }) as unknown as ReturnType<typeof createClient> });
  check("unexpected row bodies are refused without logging them", bodyFailure.status === "unavailable" && bodyFailure.reason === "unexpected_body" && !JSON.stringify(bodyFailure).includes("private-marker"));
  for (const timeoutMs of [0, -1, LEGACY_CANARY_COUNT_TIMEOUT_MS + 1, NaN, Infinity]) {
    const invalid = fixture();
    const result = await readLegacyCanaryCounts({ projectUrl: TEST_URL, clientFactory: invalid.factory, timeoutMs });
    check("deadline cannot be disabled or widened", result.status === "unavailable" && result.reason === "invalid_deadline" && invalid.factories() === 0);
  }
  const stalled = fixture({ stall: true }), start = Date.now();
  const timeout = await readLegacyCanaryCounts({ projectUrl: TEST_URL, clientFactory: stalled.factory, timeoutMs: 20 });
  check("noncooperative transport still bounded and aborted", timeout.status === "unavailable" && timeout.reason === "timeout" && Date.now() - start < 2000 && stalled.calls.length === 3 && stalled.calls.every(call => call.signal?.aborted));
  const runtime = readFileSync("scripts/security/rls-runtime-test.mjs", "utf8");
  check("runtime fixed guard precedes actual service client creation", runtime.indexOf("if (!isLegacyCanaryTestProject(URL_))") < runtime.indexOf("const admin = createClient(URL_, SERVICE"));
  check("snapshot is after original failure and cleanup fences", runtime.indexOf("const legacyCounts = await readLegacyCanaryCounts") > runtime.indexOf("if (cleanupFailed)") && runtime.indexOf("const legacyCounts = await readLegacyCanaryCounts") > runtime.indexOf("if (failures > 0)"));
  check("unavailable counts cannot print successful runtime completion", runtime.indexOf('if (legacyCounts.status !== "available")') < runtime.indexOf('console.log("\\n✓ RLS runtime test passed'));
  console.log(`legacy canary counts: ${checks} checks passed; actual SDK HEAD requests use fake fetch only, no hosted I/O or mutations`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
