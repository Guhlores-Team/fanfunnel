import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pingHeartbeat, HEARTBEAT_TIMEOUT_MS } from "./heartbeat";

let passed = 0;
const check = (label: string, ok: unknown) => { assert.ok(ok, label); passed++; };

async function main() {
  const calls: { url: string; init?: RequestInit }[] = [];
  const ok = (async (url: URL, init?: RequestInit) => { calls.push({ url: String(url), init }); return new Response("ok"); }) as unknown as typeof fetch;
  check("unset → off, no request", (await pingHeartbeat({}, ok)) === "off" && calls.length === 0);
  check("blank → off", (await pingHeartbeat({ HEARTBEAT_URL: "  " }, ok)) === "off" && calls.length === 0);
  check("http is refused", (await pingHeartbeat({ HEARTBEAT_URL: "http://hc-ping.com/abc" }, ok)) === "failed" && calls.length === 0);
  check("garbage is refused", (await pingHeartbeat({ HEARTBEAT_URL: "not a url" }, ok)) === "failed" && calls.length === 0);
  check("https → one GET", (await pingHeartbeat({ HEARTBEAT_URL: "https://hc-ping.com/abc" }, ok)) === "sent" && calls.length === 1 && calls[0].init?.method === "GET" && calls[0].init?.signal instanceof AbortSignal);
  const logs: string[] = [];
  const warn = console.warn;
  console.warn = (...a: unknown[]) => { logs.push(a.join(" ")); };
  try {
    const refused = (async () => new Response("no", { status: 500 })) as unknown as typeof fetch;
    const throwing = (async () => { throw new Error("connect ECONNREFUSED https://hc-ping.com/secret-uuid"); }) as unknown as typeof fetch;
    check("a refused ping → failed, not thrown", (await pingHeartbeat({ HEARTBEAT_URL: "https://hc-ping.com/secret-uuid" }, refused)) === "failed");
    check("a network error → failed, not thrown", (await pingHeartbeat({ HEARTBEAT_URL: "https://hc-ping.com/secret-uuid" }, throwing)) === "failed");
    check("failures are logged without the URL", logs.length === 2 && !logs.some((l) => l.includes("secret-uuid")));
  } finally { console.warn = warn; }
  check("timeout is 3 s", HEARTBEAT_TIMEOUT_MS === 3000);
  const route = readFileSync("src/app/api/cron/retention/route.ts", "utf8");
  // OPS3-10: the ping means "the job ran to the end"; a failed step is alerted
  // by name, and the ping still goes out after every step (never before).
  check("the cron pings after every step, unconditionally, and records a refused ping", /const heartbeat = await pingHeartbeat\(\);\s*if \(heartbeat === "failed"\) reportHeartbeatFailed\(\);/.test(route) && route.indexOf("await pingHeartbeat()") > route.indexOf("const status =") && route.indexOf("await pingHeartbeat()") > route.lastIndexOf("runStep("));
  console.log(`heartbeat: ${passed} checks passed`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
