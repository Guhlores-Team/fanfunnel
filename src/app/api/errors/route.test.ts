import assert from "node:assert";

// POST /api/errors is unauthenticated, so: per-IP rate limit, a hard body cap,
// a whitelist schema, no echo of input, and redaction before storage.

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

const FAN_TOKEN = "0123456789abcdef0123456789abcdef";
let ipSeq = 0;
const freshIp = () => `203.0.113.${++ipSeq}`;
const tick = () => new Promise((r) => setTimeout(r, 30));

async function main() {
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.RESEND_API_KEY;
  const { POST } = await import("./route");
  const store = await import("@/lib/data/appErrors");
  const { ERROR_REPORT_PER_IP, ERROR_REPORT_MAX_BYTES } = await import("@/lib/monitoring/config");
  store.resetMemoryAppErrors();
  const info = console.info;
  console.info = () => {};

  async function post(body: BodyInit | null, opts: { ip?: string; type?: string; headers?: Record<string, string> } = {}) {
    const res = await POST(
      new Request("http://localhost/api/errors", {
        method: "POST",
        headers: { "Content-Type": opts.type ?? "application/json", "x-real-ip": opts.ip ?? freshIp(), ...(opts.headers ?? {}) },
        body,
        ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
      } as RequestInit),
    );
    return { status: res.status, text: await res.text() };
  }
  const json = (o: unknown) => JSON.stringify(o);
  const VALID = { message: "TypeError: boom", kind: "error", stack: "TypeError: boom\n    at x (https://a.b/c.js:1:2)", route: "/dashboard" };

  // --- accepted -------------------------------------------------------------------
  {
    const r = await post(json(VALID));
    check("a valid report → 204", r.status === 204);
    check("…with an empty body (never echoes input)", r.text === "");
  }

  // --- junk ---------------------------------------------------------------------------
  const junk: [string, BodyInit][] = [
    ["not JSON", "<<<"],
    ["empty body", ""],
    ["a JSON array", json([VALID])],
    ["a JSON string", json("boom")],
    ["null", "null"],
    ["an unknown key", json({ ...VALID, email: "fan@example.com" })],
    ["a non-string message", json({ message: { a: 1 } })],
    ["an empty message", json({ message: "   " })],
    ["an unknown kind", json({ message: "x", kind: "warning" })],
    ["a numeric stack", json({ message: "x", stack: 12 })],
    ["a malformed digest", json({ message: "x", digest: "<script>" })],
    ["an over-long message", json({ message: "x".repeat(5000) })],
  ];
  for (const [label, body] of junk) {
    const r = await post(body);
    check(`${label} → 400`, r.status === 400);
    check(`${label}: the response does not echo input`, !/boom|fan@example|script|xxxx/.test(r.text));
  }
  check("wrong content type → 415", (await post(json(VALID), { type: "text/plain" })).status === 415);

  // --- size cap ----------------------------------------------------------------------
  const big = json({ message: "x", stack: "y".repeat(ERROR_REPORT_MAX_BYTES) });
  check("an oversized body → 413", (await post(big)).status === 413);
  check(
    "a declared Content-Length over the cap → 413 without reading",
    (await post(json(VALID), { headers: { "content-length": String(ERROR_REPORT_MAX_BYTES + 1) } })).status === 413,
  );
  {
    let pulled = 0;
    const chunk = new TextEncoder().encode("a".repeat(4096));
    const stream = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        pulled++;
        if (pulled > 1000) ctrl.close();
        else ctrl.enqueue(chunk);
      },
    });
    const r = await post(stream);
    check("a streamed body over the cap → 413", r.status === 413);
    check(`…and reading stopped at the cap (pulled ${pulled} chunks, not 1000)`, pulled < 10);
  }

  // --- rate limit ------------------------------------------------------------------------
  {
    const ip = freshIp();
    const statuses: number[] = [];
    for (let i = 0; i < ERROR_REPORT_PER_IP + 2; i++) statuses.push((await post(json({ message: `m${i}` }), { ip })).status);
    check(`first ${ERROR_REPORT_PER_IP} from one IP accepted`, statuses.slice(0, ERROR_REPORT_PER_IP).every((s) => s === 204));
    check("then 429", statuses.slice(ERROR_REPORT_PER_IP).every((s) => s === 429));
    check("another IP is unaffected", (await post(json({ message: "other ip" }))).status === 204);
  }

  // --- redaction before storage -----------------------------------------------------------
  await tick(); // let the earlier reports' after-response writes land first
  store.resetMemoryAppErrors();
  await post(
    json({
      message: `Spin failed for fan@example.com at https://x.app/spin/${FAN_TOKEN}?ref=abc`,
      stack: `Error\n    at f (https://x.app/api/spin?token=${FAN_TOKEN})`,
      route: `/spin/${FAN_TOKEN}`,
    }),
    { headers: { "user-agent": "Mozilla/5.0 (fan@example.com)" } },
  );
  await tick();
  const rows = (await store.listAppErrors({ status: "open" })) as { message: string; route: string; source: string }[];
  const blob = JSON.stringify(rows);
  check("the report was stored after the response", rows.length === 1 && rows[0].source === "client");
  check("stored row has no fan token", !blob.includes(FAN_TOKEN));
  check("stored row has no e-mail", !blob.includes("fan@example.com"));
  check("stored row has no query string", !blob.includes("?ref=abc"));
  check("stored route is the redacted path", rows[0].route === "/spin/[token]");

  console.info = info;
  console.log(`api/errors route: ${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
