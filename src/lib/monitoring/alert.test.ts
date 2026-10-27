import assert from "node:assert";
import {
  adminErrorsUrl,
  alertConfig,
  buildDigestEmail,
  buildErrorEmail,
  noteAlertsOff,
  sendAlertEmail,
  shouldAlert,
} from "./alert";
import { ALERT_MAX_PER_HOUR, DEFAULT_ALERT_EMAIL_FROM } from "./config";

// E-mail alerts: config from server-only env, the send decision, the e-mail
// body (no PII, escaped) and a send that can never throw.

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

async function main() {
  // --- config ------------------------------------------------------------------
  const off = alertConfig({} as unknown as NodeJS.ProcessEnv);
  check("unset env → alerts off", off.enabled === false);
  check("default sender", off.from === DEFAULT_ALERT_EMAIL_FROM);
  check("default environments = production only", JSON.stringify(off.environments) === '["production"]');
  check("throttle constant defaults to 10/hour", off.maxPerHour === ALERT_MAX_PER_HOUR && ALERT_MAX_PER_HOUR === 10);
  check("key without recipients → off", !alertConfig({ RESEND_API_KEY: "re_x" } as unknown as NodeJS.ProcessEnv).enabled);
  check("recipients without key → off", !alertConfig({ ALERT_EMAIL_TO: "a@b.co" } as unknown as NodeJS.ProcessEnv).enabled);
  const on = alertConfig({
    RESEND_API_KEY: "re_test_key",
    ALERT_EMAIL_TO: " ops@example.com, not-an-email ,dev@example.com",
    ALERT_ENVIRONMENTS: "production, Preview",
    ALERT_EMAIL_FROM: "Ops <ops@example.org>",
  } as unknown as NodeJS.ProcessEnv);
  check("both set → on", on.enabled);
  check("recipient list parsed, junk dropped", JSON.stringify(on.to) === '["ops@example.com","dev@example.com"]');
  check("ALERT_ENVIRONMENTS parsed + lowercased", JSON.stringify(on.environments) === '["production","preview"]');
  check("ALERT_EMAIL_FROM overrides the default", on.from === "Ops <ops@example.org>");

  // --- decision ----------------------------------------------------------------
  const prod = "production" as const;
  check("first occurrence in production → alert", shouldAlert({ isNew: true, reopened: false }, prod, on));
  check("resolved one coming back → alert", shouldAlert({ isNew: false, reopened: true }, prod, on));
  check("a repeat of an open error → no alert", !shouldAlert({ isNew: false, reopened: false }, prod, on));
  check("new error in development → no alert", !shouldAlert({ isNew: true, reopened: false }, "development", on));
  check("new error in preview when listed → alert", shouldAlert({ isNew: true, reopened: false }, "preview", on));
  check("preview is not alerted by default", !shouldAlert({ isNew: true, reopened: false }, "preview", { ...on, environments: ["production"] }));
  check("alerts off → never", !shouldAlert({ isNew: true, reopened: false }, prod, off));

  // --- log once when off ---------------------------------------------------------
  const logs: string[] = [];
  noteAlertsOff(off, (m) => logs.push(m));
  noteAlertsOff(off, (m) => logs.push(m));
  check("'alerts are off' is logged exactly once", logs.length === 1 && !/re_/.test(logs[0]));

  // --- admin link ------------------------------------------------------------------
  check("link from NEXT_PUBLIC_SITE_URL", adminErrorsUrl({ NEXT_PUBLIC_SITE_URL: "https://ff.example/" } as unknown as NodeJS.ProcessEnv) === "https://ff.example/dashboard?section=admin#errors");
  check(
    "production uses the production domain",
    adminErrorsUrl({ VERCEL_ENV: "production", VERCEL_PROJECT_PRODUCTION_URL: "ff.example", VERCEL_URL: "x-123.vercel.app" } as unknown as NodeJS.ProcessEnv) === "https://ff.example/dashboard?section=admin#errors",
  );
  check("preview uses its deployment URL", adminErrorsUrl({ VERCEL_ENV: "preview", VERCEL_URL: "x-123.vercel.app" } as unknown as NodeJS.ProcessEnv) === "https://x-123.vercel.app/dashboard?section=admin#errors");
  check("no origin → null", adminErrorsUrl({} as unknown as NodeJS.ProcessEnv) === null);

  // --- e-mail body -----------------------------------------------------------------
  const mail = buildErrorEmail(
    {
      environment: "production",
      source: "client",
      route: "/spin/[token]",
      message: "TypeError: <script>alert(1)</script> & co",
      count: 3,
      firstSeen: "2026-10-27T10:00:00.000Z",
      reopened: false,
    },
    { pending: 2, link: "https://ff.example/dashboard?section=admin#errors" },
  );
  check("subject names the environment and that it is new", mail.subject.startsWith("[FanFunnel production] New error: TypeError"));
  check("HTML escapes the message", !mail.html.includes("<script>alert(1)</script>") && mail.html.includes("&lt;script&gt;"));
  for (const [label, needle] of [
    ["environment", "production"],
    ["route", "/spin/[token]"],
    ["count", ">3<"],
    ["first seen", "2026-10-27 10:00:00 UTC"],
    ["admin link", "https://ff.example/dashboard?section=admin#errors"],
    ["held-back count", "Plus 2 more new errors"],
  ] as const) {
    check(`HTML shows the ${label}`, mail.html.includes(needle));
  }
  check("plain-text part carries the same facts", /Route: \/spin\/\[token\]/.test(mail.text) && /Count: 3/.test(mail.text) && mail.text.includes("https://ff.example/"));
  check("branded like the auth templates", mail.html.includes("#ec4899") && mail.html.includes("Fan<span"));
  check("no user agent, IP or fan data in the e-mail", !/user.?agent|Mozilla|\bip\b/i.test(mail.text));
  const back = buildErrorEmail(
    { environment: "production", source: "server", route: null, message: "boom", count: 9, firstSeen: "x", reopened: true },
    { pending: 0, link: null },
  );
  check("reopened alert says so", back.subject.includes("Resolved error is back") && /happened again/.test(back.html));
  check("without a link it points to Admin › Errors", back.text.includes("Admin › Errors") && !back.html.includes("href="));
  const digest = buildDigestEmail(4, "production", null);
  check("digest subject: 'N more new errors'", digest.subject === "[FanFunnel production] 4 more new errors");

  // --- sending ---------------------------------------------------------------------
  const calls: { url: string; init: RequestInit }[] = [];
  const okFetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  check("a 2xx send resolves true", (await sendAlertEmail(on, mail, okFetch)) === true);
  const sentBody = JSON.parse(String(calls[0].init.body));
  check("posts to Resend's e-mail endpoint", calls[0].url === "https://api.resend.com/emails" && calls[0].init.method === "POST");
  check("authenticates with the key as a Bearer token", (calls[0].init.headers as Record<string, string>).Authorization === "Bearer re_test_key");
  check("sends from/to/subject/html/text", sentBody.from === on.from && sentBody.to.length === 2 && sentBody.subject === mail.subject && !!sentBody.html && !!sentBody.text);

  const warn = console.warn;
  const warned: string[] = [];
  console.warn = (m: string) => void warned.push(m);
  try {
    const failing = (async () => new Response("bad key re_test_key", { status: 401 })) as unknown as typeof fetch;
    check("a non-2xx send resolves false", (await sendAlertEmail(on, mail, failing)) === false);
    const throwing = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    let threw = false;
    try {
      check("a network failure resolves false", (await sendAlertEmail(on, mail, throwing)) === false);
    } catch {
      threw = true;
    }
    check("a failed send never throws", !threw);
    check("failure logs never contain the key", warned.every((w) => !w.includes("re_test_key")));
  } finally {
    console.warn = warn;
  }
  let offCalls = 0;
  await sendAlertEmail(off, mail, (async () => {
    offCalls++;
    return new Response();
  }) as unknown as typeof fetch);
  check("alerts off → no request at all", offCalls === 0);

  console.log(`monitoring/alert: ${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
