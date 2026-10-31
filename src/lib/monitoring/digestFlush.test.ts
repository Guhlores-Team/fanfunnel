import assert from "node:assert";

// A27: throttled errors were only reported in a digest when ANOTHER error came
// along to trigger the check, so a burst that stopped was never sent. The
// maintenance cron now calls flushAlertDigest(): once the hourly budget allows
// it, the waiting errors go out in one digest; nothing is sent when nothing is
// waiting, when alerts are off, or outside ALERT_ENVIRONMENTS.

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

async function main() {
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.VERCEL_ENV;
  delete process.env.ALERT_ENVIRONMENTS;
  process.env.RESEND_API_KEY = "re_test_key";
  process.env.ALERT_EMAIL_TO = "ops@example.com";

  let accept = true;
  const sent: { subject: string; text: string }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    if (url === "https://api.resend.com/emails") sent.push(JSON.parse(String(init.body)));
    return new Response("{}", { status: accept ? 200 : 500 });
  }) as unknown as typeof fetch;
  const warn = console.warn;
  console.warn = () => {};

  // Fingerprints ignore digits, so each failure gets its own word.
  const WORDS = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet", "kilo", "lima", "mike", "november", "oscar", "papa", "quebec", "romeo", "sierra", "tango"];
  const store = await import("@/lib/data/appErrors");
  const cap = await import("./capture");
  const { ALERT_MAX_PER_HOUR } = await import("./config");
  store.resetMemoryAppErrors();

  check("nothing waiting → no digest", (await cap.flushAlertDigest("production")) === "none" && sent.length === 0);

  // Spend the hourly budget, then three more first occurrences are throttled.
  const extra = 3;
  for (let i = 0; i < ALERT_MAX_PER_HOUR + extra; i++) {
    const e = cap.cleanError({ source: "server", message: `distinct failure ${WORDS[i]}`, environment: "production" })!;
    const outcome = (await cap.storeError(e))!;
    await cap.alertFor(e, outcome);
  }
  check(`the hourly budget sent ${ALERT_MAX_PER_HOUR} alerts (got ${sent.length})`, sent.length === ALERT_MAX_PER_HOUR);
  check("within the hour the digest is still throttled", (await cap.flushAlertDigest("production")) === "none" && sent.length === ALERT_MAX_PER_HOUR);

  // No new error arrives. An hour later the cron's flush sends the digest.
  const realNow = Date.now;
  Date.now = () => realNow() + 2 * 60 * 60_000;
  try {
    check("a later cron run sends the waiting digest", (await cap.flushAlertDigest("production")) === "sent");
    const digest = sent.at(-1)!;
    check(`…counting the ${extra} throttled errors`, sent.length === ALERT_MAX_PER_HOUR + 1 && digest.subject.includes(`${extra} more new errors`));
    check("…and only once", (await cap.flushAlertDigest("production")) === "none" && sent.length === ALERT_MAX_PER_HOUR + 1);
  } finally {
    Date.now = realNow;
  }

  // A rejected send is reported as failed (the cron response says so).
  store.resetMemoryAppErrors();
  for (let i = 0; i < ALERT_MAX_PER_HOUR + 1; i++) {
    const e = cap.cleanError({ source: "server", message: `second burst ${WORDS[i]}`, environment: "production" })!;
    await cap.alertFor(e, (await cap.storeError(e))!);
  }
  accept = false;
  Date.now = () => realNow() + 2 * 60 * 60_000;
  try {
    check("a send Resend refuses is reported failed", (await cap.flushAlertDigest("production")) === "failed");
  } finally {
    Date.now = realNow;
    accept = true;
  }

  // Off switches.
  const before = sent.length;
  check("outside ALERT_ENVIRONMENTS → off", (await cap.flushAlertDigest("development")) === "off");
  delete process.env.RESEND_API_KEY;
  const info = console.info;
  console.info = () => {};
  try {
    check("alerts not configured → off", (await cap.flushAlertDigest("production")) === "off");
  } finally {
    console.info = info;
  }
  check("…and neither sends anything", sent.length === before);
  console.warn = warn;

  console.log(`monitoring/digestFlush: ${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
