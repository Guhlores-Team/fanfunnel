// Pure tests for the stress harness plumbing: protocol framing of the
// dependency-free Postgres client, latency percentiles, and the pass/fail
// bookkeeping (hard checks, latency ceilings, documented known bugs, strict
// and soft modes). No database, no network, no server.
import assert from "node:assert/strict";
import { test } from "node:test";
import { PgSession, PgError } from "./pgwire.mjs";
import { parallel, percentile, Report, summarize, tally } from "./metrics.mjs";

const frame = (type, body) => { const len = Buffer.alloc(4); len.writeInt32BE(body.length + 4); return Buffer.concat([Buffer.from(type), len, body]); };
const rowDescription = names => { const n = Buffer.alloc(2); n.writeInt16BE(names.length); return frame("T", Buffer.concat([n, ...names.map(name => Buffer.concat([Buffer.from(name + "\0"), Buffer.alloc(18)]))])); };
const dataRow = cells => { const n = Buffer.alloc(2); n.writeInt16BE(cells.length); return frame("D", Buffer.concat([n, ...cells.map(c => { if (c === null) { const l = Buffer.alloc(4); l.writeInt32BE(-1); return l; } const b = Buffer.from(c, "utf8"), l = Buffer.alloc(4); l.writeInt32BE(b.length); return Buffer.concat([l, b]); })])); };
const ready = status => frame("Z", Buffer.from(status));
const errorResponse = fields => frame("E", Buffer.concat([...Object.entries(fields).map(([k, v]) => Buffer.from(k + v + "\0")), Buffer.from("\0")]));

/** A session whose socket is a recorder: query() resolves from the buffers fed to onData. */
function fakeSession() {
  const s = new PgSession("/nowhere", 1); const sent = [];
  s.sock = { write: b => { sent.push(Buffer.from(b)); return true; }, destroy() {} };
  return { s, sent };
}

test("pgwire: rows across several statements come back psql -qAt style, split across chunks", async () => {
  const { s, sent } = fakeSession();
  const p = s.query("select 1; select 'a', null, 'tab\there';");
  const bytes = Buffer.concat([frame("C", Buffer.from("BEGIN\0")), rowDescription(["x"]), dataRow(["1"]), frame("C", Buffer.from("SELECT 1\0")), rowDescription(["a", "b", "c"]), dataRow(["a", null, "tab\there"]), frame("C", Buffer.from("SELECT 1\0")), ready("I")]);
  for (let at = 0; at < bytes.length; at += 7) s.onData(bytes.subarray(at, at + 7));
  assert.equal(await p, "1\na\t\ttab\there");
  assert.equal(sent[0][0], "Q".charCodeAt(0));
  assert.equal(sent[0].subarray(5).toString(), "select 1; select 'a', null, 'tab\there';\0");
});

test("pgwire: an error rejects with code and detail, and a failed transaction is rolled back before reuse", async () => {
  const { s, sent } = fakeSession();
  const p = s.query("begin; select * from nope;");
  s.onData(Buffer.concat([frame("C", Buffer.from("BEGIN\0")), errorResponse({ S: "ERROR", C: "42P01", M: 'relation "nope" does not exist', D: "detail here" }), ready("E")]));
  await new Promise(r => setImmediate(r));
  assert.equal(sent.length, 2, "a rollback was sent because the session was left in a failed transaction");
  assert.equal(sent[1].subarray(5).toString(), "rollback\0");
  s.onData(ready("I"));
  await assert.rejects(p, e => e instanceof PgError && e.code === "42P01" && e.detail === "detail here" && /nope/.test(e.message));
  assert.equal(s.waiter, null, "the session is free again");
});

test("pgwire: a query while another is in flight is refused", async () => {
  const { s } = fakeSession();
  const p = s.query("select 1;");
  await assert.rejects(s.query("select 2;"), /busy/);
  s.onData(ready("I"));
  assert.equal(await p, "");
});

test("metrics: percentiles and summaries", () => {
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([5], 95), 5);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50), 5);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95), 10);
  assert.equal(percentile([10, 9, 8, 7, 6, 5, 4, 3, 2, 1], 90), 9);
  const s = summarize([1.26, 2, 3]);
  assert.deepEqual(s, { n: 3, p50: 2, p95: 3, max: 3, mean: 2.1 });
  assert.deepEqual(summarize([]), { n: 0, p50: null, p95: null, max: null, mean: null });
});

test("metrics: parallel keeps order, bounds concurrency and captures errors", async () => {
  let inflight = 0, peak = 0;
  const out = await parallel([1, 2, 3, 4, 5, 6], 2, async n => { inflight++; peak = Math.max(peak, inflight); await new Promise(r => setTimeout(r, 5)); inflight--; if (n === 4) { const e = new Error("boom"); e.code = "40P01"; e.detail = "cycle"; throw e; } return n * 10; });
  assert.equal(peak, 2);
  assert.deepEqual(out.map(r => r.ok ? r.value : `${r.code}:${r.error}:${r.detail}`), [10, 20, 30, "40P01:boom:cycle", 50, 60]);
  assert.deepEqual(tally(out, v => v > 30 ? "big" : "small"), { small: 3, big: 2, "error:40P01": 1 });
});

test("report: hard checks and latency ceilings fail the run, soft mode downgrades latency only", () => {
  const quiet = { log: () => {} };
  const r = new Report({ ...quiet, softLatency: false, strict: false });
  r.scenario("X1", "one"); r.check(true, "fine"); r.check(false, "broken", { n: 1 }); r.latency("slow", [10, 20, 900], 100); r.latency("fast", [1, 2, 3], 100); r.finish();
  assert.deepEqual(r.failures, ["X1: broken ({\"n\":1})", "X1: slow p95 900ms > 100ms"]);
  assert.match(r.markdown(), /\| X1 one \| 1\/2 \| slow: 20 \/ 900 \/ 900 \(3\) BREACH<br>fast: 2 \/ 3 \/ 3 \(3\) \| FAIL \|/);
  const soft = new Report({ ...quiet, softLatency: true });
  soft.scenario("X2", "two"); soft.latency("slow", [10, 900], 100); soft.finish();
  assert.deepEqual(soft.failures, []);
  assert.equal(soft.scenarios[0].latencies[0].breached, true);
});

test("report: a known bug passes with a KNOWN-BUG line unless STRESS_STRICT", () => {
  const lines = [];
  const r = new Report({ log: l => lines.push(l), strict: false });
  r.scenario("X3", "known"); r.known("BUG_ID", false, "still reproduces", "7 deadlocks"); r.known("OTHER", true, "fixed"); r.finish();
  assert.deepEqual(r.failures, []);
  assert.deepEqual(r.knownBugs, ["X3: BUG_ID: still reproduces (7 deadlocks)"]);
  assert.ok(lines.some(l => l.includes("KNOWN-BUG BUG_ID: still reproduces (7 deadlocks)")));
  assert.match(r.markdown(), /pass \(1 known bug\)/);
  assert.equal(r.scenarios[0].checks.length, 1, "a known bug that no longer reproduces is recorded as an ordinary passing check");
  const strict = new Report({ log: () => {}, strict: true });
  strict.scenario("X4", "strict"); strict.known("BUG_ID", false, "still reproduces"); strict.finish();
  assert.deepEqual(strict.failures, ["X4: still reproduces [BUG_ID]"]);
  assert.deepEqual(JSON.parse(JSON.stringify(strict)).strict, true);
});
