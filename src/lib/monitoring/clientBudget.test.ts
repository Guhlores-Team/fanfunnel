import assert from "node:assert";

// C3 (batch 6 attack audit): anonymous POST /api/errors reports get their own
// budgets. A flood of unique browser errors can neither use up the hourly
// alert e-mails server errors depend on, nor fill the table so the prune
// evicts server rows from Admin › Errors; the client text never reaches an
// e-mail subject; the route keeps its per-address limit and body cap.

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

const word = (i: number) => [...i.toString(26)].map((c) => String.fromCharCode(97 + parseInt(c, 26))).join("") + "q";
const tick = () => new Promise((r) => setTimeout(r, 20));

async function main() {
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.VERCEL_ENV;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.KV_REST_API_URL;
  process.env.RESEND_API_KEY = "re_live_key";
  process.env.ALERT_EMAIL_TO = "ops@example.com";
  process.env.NEXT_PUBLIC_SITE_URL = "https://ff.example";

  const sent: { subject: string; text: string }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    if (url === "https://api.resend.com/emails") sent.push(JSON.parse(String(init.body)));
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;

  const store = await import("@/lib/data/appErrors");
  const cap = await import("./capture");
  const cfg = await import("./config");
  store.resetMemoryAppErrors();

  // --- alert budget: client reports take at most their share -------------------
  for (let i = 0; i < 12; i++) {
    const e = cap.cleanError({ source: "client", environment: "production", message: `Supabase key expired, visit evil.example ${word(i)}` })!;
    const out = await cap.storeError(e);
    if (out) await cap.alertFor(e, out);
  }
  check(`12 unique browser errors send at most ${cfg.CLIENT_ALERT_MAX_PER_HOUR} alert e-mails`, cfg.CLIENT_ALERT_MAX_PER_HOUR === 3 && sent.length === 3);
  check("no client text in any subject", sent.every((m) => m.subject === "[FanFunnel production] New error (browser)"));
  check("…the scrubbed text is in the body", sent[0].text.includes("Message: Supabase key expired"));
  const before = sent.length;
  const server = cap.cleanError({ source: "server", environment: "production", message: "TypeError: db down" })!;
  await cap.alertFor(server, (await cap.storeError(server))!);
  check("a server error still e-mails after the browser flood", sent.length === before + 1 && sent.at(-1)!.subject.includes("db down"));

  // --- row quota: client rows can never fill the table ------------------------
  store.resetMemoryAppErrors();
  const serverRow = cap.cleanError({ source: "server", environment: "production", message: "Error: real server failure" })!;
  const srv = await cap.storeError(serverRow);
  let stored = 0;
  for (let i = 0; i < cfg.CLIENT_OPEN_ROWS_MAX + 50; i++) {
    const e = cap.cleanError({ source: "client", environment: "production", message: `flood ${word(i)}` })!;
    if (await cap.storeError(e)) stored++;
  }
  check(`at most ${cfg.CLIENT_OPEN_ROWS_MAX} open client rows are kept`, stored === cfg.CLIENT_OPEN_ROWS_MAX);
  const again = await cap.storeError(cap.cleanError({ source: "client", environment: "production", message: `flood ${word(0)}` })!);
  check("a known client fingerprint still counts past the quota", !!again && again.count === 2);
  const list = await store.recordAppError({ fingerprint: "f".repeat(32), environment: "production", source: "server", message: "probe" }, cfg.APP_ERRORS_MAX_ROWS);
  check("server errors keep recording", !!list && list.isNew);
  check("the quota is below the table cap, so the prune never needs a server row", cfg.CLIENT_OPEN_ROWS_MAX < cfg.APP_ERRORS_MAX_ROWS / 2 && !!srv);

  // --- the route: per-address limit and body cap ------------------------------
  const { POST } = await import("@/app/api/errors/route");
  const post = (ip: string, body: string) =>
    POST(new Request("http://x/api/errors", { method: "POST", headers: { "content-type": "application/json", "x-real-ip": ip }, body }));
  const ok = JSON.stringify({ message: "Error: x", route: "/" });
  const codes: number[] = [];
  for (let i = 0; i < cfg.ERROR_REPORT_PER_IP + 1; i++) codes.push((await post("10.7.0.1", ok)).status);
  check(`one address gets ${cfg.ERROR_REPORT_PER_IP} reports a minute, then 429`, codes.slice(0, -1).every((c) => c === 204) && codes.at(-1) === 429);
  check("another address is unaffected", (await post("10.7.0.2", ok)).status === 204);
  const big = JSON.stringify({ message: "x".repeat(cfg.ERROR_REPORT_MAX_BYTES + 10) });
  check("an oversized body is refused (413)", (await post("10.7.0.3", big)).status === 413);
  await tick();

  console.log(`monitoring/clientBudget: ${passed} checks passed`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
