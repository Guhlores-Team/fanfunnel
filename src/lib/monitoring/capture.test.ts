import assert from "node:assert";

// The server pipeline end to end on the in-memory store: everything stored or
// e-mailed is redacted, noise and Next control flow are dropped, and the send
// decision (first occurrence / reopen, production only, throttled) holds.

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

const FAN_TOKEN = "0123456789abcdef0123456789abcdef";
const SECRETS = [FAN_TOKEN, "fan@example.com", "hunter2", "eyJhbGciOiJIUzI1NiJ9", "?utm", "secret-ref", "re_live_key"];

const tick = () => new Promise((r) => setTimeout(r, 30));

async function main() {
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  // VERCEL_ENV stays unset: production without Supabase env fails closed, so
  // these tests pass the environment explicitly (currentEnvironment() is
  // checked separately below).
  delete process.env.VERCEL_ENV;
  process.env.RESEND_API_KEY = "re_live_key";
  process.env.ALERT_EMAIL_TO = "ops@example.com";
  process.env.NEXT_PUBLIC_SITE_URL = "https://ff.example";

  const sent: { subject: string; html: string; text: string }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    if (url === "https://api.resend.com/emails") sent.push(JSON.parse(String(init.body)));
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;

  const store = await import("@/lib/data/appErrors");
  const cap = await import("./capture");
  store.resetMemoryAppErrors();

  const dirty = {
    source: "client" as const,
    environment: "production" as const,
    message: `Spin failed for fan@example.com on https://ff.example/spin/${FAN_TOKEN}?utm=x {"password":"hunter2"}`,
    stack: `Error: x\n    at spin (https://ff.example/_next/static/chunks/app.js:1:2)\n    at fetch (https://ff.example/api/spin?token=${FAN_TOKEN}&ref=secret-ref)\n    Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc`,
    route: `https://ff.example/spin/${FAN_TOKEN}?ref=secret-ref`,
    userAgent: "Mozilla/5.0 (fan@example.com)",
  };

  const clean = cap.cleanError(dirty)!;
  const blob = JSON.stringify(clean);
  check(`cleanError leaves no secret (leaked: ${SECRETS.filter((s) => blob.includes(s)).join(", ")})`, SECRETS.every((s) => !blob.includes(s)));
  check("route is stored as a path with the token replaced", clean.route === "/spin/[token]");
  check("environment is kept", clean.environment === "production");
  const { currentEnvironment } = await import("./config");
  check(
    "currentEnvironment() reads VERCEL_ENV, anything else is development",
    currentEnvironment({ VERCEL_ENV: "production" } as unknown as NodeJS.ProcessEnv) === "production" &&
      currentEnvironment({ VERCEL_ENV: "preview" } as unknown as NodeJS.ProcessEnv) === "preview" &&
      currentEnvironment({ VERCEL_ENV: "staging" } as unknown as NodeJS.ProcessEnv) === "development" &&
      currentEnvironment({} as unknown as NodeJS.ProcessEnv) === "development",
  );

  const outcome = await cap.storeError(clean);
  await cap.alertFor(clean, outcome!);
  const rows = await store.listAppErrors({ status: "open" });
  const storedBlob = JSON.stringify(rows);
  check("one row stored", Array.isArray(rows) && rows.length === 1);
  check("the STORED row has no secret", SECRETS.every((s) => !storedBlob.includes(s)));
  check("first occurrence in production → one alert e-mail", sent.length === 1);
  check("the e-mail has no secret", SECRETS.every((s) => !JSON.stringify(sent[0]).includes(s)));
  check("the e-mail links to Admin › Errors", sent[0].html.includes("https://ff.example/dashboard?section=admin#errors"));

  const again = await cap.storeError(cap.cleanError(dirty)!);
  await cap.alertFor(clean, again!);
  check("a repeat bumps the count", again?.count === 2);
  check("a repeat sends no e-mail", sent.length === 1);

  await store.resolveAppError(outcome!.id, true);
  const back = await cap.storeError(cap.cleanError(dirty)!);
  await cap.alertFor(clean, back!);
  check("a resolved error coming back sends again", back?.reopened === true && sent.length === 2 && /back/.test(sent[1].subject));

  const dev = cap.cleanError({ ...dirty, message: "only in dev", environment: "development" })!;
  await cap.alertFor(dev, (await cap.storeError(dev))!);
  check("a new error outside ALERT_ENVIRONMENTS sends nothing", sent.length === 2);

  // Noise and empty input are dropped.
  check("cross-origin 'Script error.' is dropped", cap.cleanError({ source: "client", message: "Script error." }) === null);
  check("extension errors are dropped", cap.cleanError({ source: "client", message: "x", stack: "at chrome-extension://abc/x.js:1:1" }) === null);
  check("an empty message is dropped", cap.cleanError({ source: "client", message: "   " }) === null);

  // Server capture via the instrumentation hook (this process is "development",
  // so let development alert for this part).
  process.env.ALERT_ENVIRONMENTS = "development";
  store.resetMemoryAppErrors();
  await cap.captureServerError(
    Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/login;307;" }),
    { path: "/dashboard" },
    { routePath: "/dashboard" },
  );
  check("Next redirects are not errors", ((await store.listAppErrors({ status: "open" })) as unknown[]).length === 0);
  await cap.captureServerError(
    new Error(`db exploded for fan@example.com token ${FAN_TOKEN}`),
    { path: `/spin/${FAN_TOKEN}?x=1`, headers: { "user-agent": "UA/1.0" } },
    { routePath: "/spin/[token]", routeType: "render" },
  );
  await tick();
  const srv = (await store.listAppErrors({ status: "open" })) as { source: string; route: string; message: string; userAgent: string }[];
  check("a server error is recorded with source=server", srv.length === 1 && srv[0].source === "server");
  check("…under the route FILE path", srv[0].route === "/spin/[token]");
  check("…redacted", !srv[0].message.includes(FAN_TOKEN) && !srv[0].message.includes("fan@example.com"));
  check("…with the user agent", srv[0].userAgent === "UA/1.0");
  check("…and alerted (first occurrence)", sent.length === 3 && /db exploded/.test(sent[2].subject));
  let threw = false;
  try {
    await cap.captureServerError(null, {}, {});
    await cap.captureServerError({ message: 42 }, {}, {});
  } catch {
    threw = true;
  }
  check("captureServerError never throws on odd input", !threw);

  // Alerts unset → silently off (no request).
  delete process.env.RESEND_API_KEY;
  store.resetMemoryAppErrors();
  const before = sent.length;
  const info = console.info;
  console.info = () => {};
  try {
    const n = cap.cleanError({ source: "server", message: "fresh" })!;
    await cap.alertFor(n, (await cap.storeError(n))!);
  } finally {
    console.info = info;
  }
  check("no RESEND_API_KEY → no e-mail", sent.length === before);

  console.log(`monitoring/capture: ${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
