import assert from "node:assert/strict";

async function main() {
  const { acknowledgeFixtureFan, BASE } = await import("../../../e2e/harness.mjs");
  type Reply = { status: () => number; headers: () => Record<string, unknown> };
  const reply = (status: number, header?: unknown): Reply => ({ status: () => status, headers: () => header === undefined ? {} : { "retry-after": header } });
  let cases = 0;
  async function invoke(responses: (Reply | Error)[], failWait = false) {
    cases++;
    const waits: number[] = [];
    let calls = 0;
    const request = { post: async (url: string, options: unknown) => {
      assert.equal(url, BASE + "/api/fans/ack");
      assert.deepEqual(options, { data: { token: "fixture-only-token" } }, "every retry preserves the same token and real request identity; no IP/header spoofing");
      const response = responses[calls++];
      assert.ok(response, "the helper must stay within its allowed number of requests");
      if (response instanceof Error) throw response;
      return response;
    } };
    const promise = acknowledgeFixtureFan(request, "fixture-only-token", { wait: async (ms: number) => {
      assert.ok(Number.isInteger(ms) && ms >= 1000 && ms <= 60_000, "each wait is bounded to at most60seconds");
      waits.push(ms);
      if (failWait) throw new Error("wait unavailable");
    } });
    return { promise, waits, calls: () => calls };
  }
  for (const status of [200, 204, 400, 401, 403, 404, 409, 500, 503]) {
    const original = reply(status, "1");
    const attempt = await invoke([original]);
    assert.equal(await attempt.promise, original, `${status} returns the original response to existing assertions`);
    assert.equal(attempt.calls(), 1);
    assert.deepEqual(attempt.waits, [], "Retry-After cannot cause retries for a status other than429");
  }
  for (const header of [undefined, null, 1, "", " ", "0", "-1", "+1", "1.5", "1e1", "NaN", "Infinity", "sixty", "61", "60000", "999999999999999999999"]) {
    const original = reply(429, header);
    const attempt = await invoke([original]);
    assert.equal(await attempt.promise, original, "a missing, unsupported or out-of-bounds delay does not hide429");
    assert.equal(attempt.calls(), 1);
    assert.deepEqual(attempt.waits, []);
  }
  for (const [header, delay] of [["2", 2000], [" 03 ", 3000], ["60", 60_000]] as const) {
    const success = reply(200);
    const attempt = await invoke([reply(429, header), success]);
    assert.equal(await attempt.promise, success);
    assert.equal(attempt.calls(), 2);
    assert.deepEqual(attempt.waits, [delay], "a valid server delay is honored without an extra unbounded margin");
  }
  {
    const success = reply(200);
    const attempt = await invoke([reply(429, "60"), reply(429, "1"), success]);
    assert.equal(await attempt.promise, success);
    assert.equal(attempt.calls(), 3);
    assert.deepEqual(attempt.waits, [60_000, 1000]);
  }
  {
    const exhausted = reply(429, "3");
    const attempt = await invoke([reply(429, "1"), reply(429, "2"), exhausted]);
    assert.equal(await attempt.promise, exhausted, "two retries exhausted still returns429 and lets the caller fail");
    assert.equal(attempt.calls(), 3);
    assert.deepEqual(attempt.waits, [1000, 2000]);
  }
  for (const final of [reply(400, "1"), reply(500, "1"), reply(429, ""), reply(429, "61")]) {
    const attempt = await invoke([reply(429, "1"), final]);
    assert.equal(await attempt.promise, final, "a later refusal is not converted into setup success");
    assert.equal(attempt.calls(), 2);
    assert.deepEqual(attempt.waits, [1000]);
  }
  for (const responses of [[new Error("transport failed")], [reply(429, "1"), new Error("transport failed")]]) {
    const attempt = await invoke(responses);
    await assert.rejects(attempt.promise, /transport failed/, "network errors remain test failures");
    assert.equal(attempt.calls(), responses.length);
  }
  {
    const attempt = await invoke([reply(429, "1")], true);
    await assert.rejects(attempt.promise, /wait unavailable/);
    assert.equal(attempt.calls(), 1, "a failed wait cannot send an immediate replacement request");
  }
  console.log(`e2eFixtureAck.test: ${cases} cases passed;429only, exact bounded Retry-After, at most2retries, original failures and unchanged identity`);
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
