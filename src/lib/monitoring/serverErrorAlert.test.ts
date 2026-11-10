import assert from "node:assert/strict";
import { mock } from "node:test";
import { readFileSync } from "node:fs";

// RS-03: a server error captured from instrumentation.ts (onRequestError, which
// runs OUTSIDE a request scope) must store the row AND send its alert e-mail
// before captureServerError resolves. `after()` throws there and the fallback
// is a dangling promise a serverless host may freeze, so the alert must never
// be scheduled through runAfterResponse on this path.
let scheduled = 0;
mock.module("@/lib/afterResponse", { namedExports: { runAfterResponse: (task: () => Promise<unknown>) => { scheduled++; void task().catch(() => undefined); } } });

let passed = 0;
const check = (label: string, ok: unknown) => { assert.ok(ok, label); passed++; };

async function main() {
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.VERCEL_ENV;
  process.env.RESEND_API_KEY = "re_test_key";
  process.env.ALERT_EMAIL_TO = "ops@example.com";
  process.env.ALERT_ENVIRONMENTS = "development";

  const sent: string[] = [];
  let resendResolved = false;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    if (url === "https://api.resend.com/emails") {
      // Slow enough that a dangling (un-awaited) alert could not have landed.
      await new Promise((r) => setTimeout(r, 120));
      sent.push(JSON.parse(String(init.body)).subject);
      resendResolved = true;
    }
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;

  const store = await import("@/lib/data/appErrors");
  const cap = await import("./capture");
  store.resetMemoryAppErrors();

  await cap.captureServerError(new Error("route handler exploded"), { path: "/api/x" }, { routePath: "/api/x", routeType: "route" });
  check("the row is stored", ((await store.listAppErrors({ status: "open" })) as unknown[]).length === 1);
  check("the alert e-mail was accepted BEFORE captureServerError resolved", resendResolved && sent.length === 1 && /route handler exploded/.test(sent[0]));
  check("nothing on this path went through runAfterResponse", scheduled === 0);

  // The browser-report path still defers (after() is supported there).
  cap.captureAfterResponse({ source: "client", message: "browser thing", environment: "development" });
  check("captureAfterResponse keeps using runAfterResponse", scheduled === 1);

  // Static: the server path calls captureInline and never the deferred capture.
  const src = readFileSync(new URL("./capture.ts", import.meta.url), "utf8");
  const fn = src.slice(src.indexOf("export async function captureServerError("));
  check("captureServerError awaits captureInline", /await captureInline\(/.test(fn));
  check("…and never schedules through runAfterResponse / captureNow / captureAfterResponse", !/runAfterResponse|captureNow\(|captureAfterResponse\(/.test(fn));
  const inline = src.slice(src.indexOf("export async function captureInline("), src.indexOf("export function captureAfterResponse("));
  check("captureInline awaits alertFor", /await alertFor\(/.test(inline) && !/runAfterResponse/.test(inline));
  const inst = readFileSync(new URL("../../instrumentation.ts", import.meta.url), "utf8");
  check("onRequestError awaits captureServerError", /await captureServerError\(/.test(inst));
  console.log(`serverErrorAlert: ${passed} checks passed`);
}
process.exitCode = 1;
main().then(() => { process.exitCode = 0; }, (e) => { console.error(e); process.exitCode = 1; });
