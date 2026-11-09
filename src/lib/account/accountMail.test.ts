import assert from "node:assert";
import { accountMailConfig, brandedEmail, canSendAccountEmail, sendAccountEmail } from "./accountMail";

// C5: account e-mail has its own "FanFunnel" sender on the owner's verified
// domain, the sign-in e-mails' look, and is only possible with a Resend key.

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}
const env = (e: Record<string, string>) => e as unknown as NodeJS.ProcessEnv;

async function main() {
  check("default sender is FanFunnel on the default domain", accountMailConfig(env({})).from === "FanFunnel <account@easysimplesites.org>");
  check(
    "keeps the owner's domain from ALERT_EMAIL_FROM",
    accountMailConfig(env({ ALERT_EMAIL_FROM: "Ops <ops@owner.example>" })).from === "FanFunnel <account@owner.example>",
  );
  check("a bare alert address works too", accountMailConfig(env({ ALERT_EMAIL_FROM: "ops@owner.example" })).from === "FanFunnel <account@owner.example>");
  check("ACCOUNT_EMAIL_FROM wins", accountMailConfig(env({ ACCOUNT_EMAIL_FROM: "Hi <hi@x.example>", ALERT_EMAIL_FROM: "a@b.example" })).from === "Hi <hi@x.example>");
  check("no key → cannot send", !canSendAccountEmail(env({ VERCEL_ENV: "production" })));
  check("key on production → can send", canSendAccountEmail(env({ VERCEL_ENV: "production", RESEND_API_KEY: "re_x" })));
  check("key on preview → can send", canSendAccountEmail(env({ VERCEL_ENV: "preview", RESEND_API_KEY: "re_x" })));
  check("local development never sends", !canSendAccountEmail(env({ RESEND_API_KEY: "re_x" })));

  const mail = brandedEmail({
    subject: "S",
    preheader: "P <b>",
    heading: "H & co",
    paragraphs: ["One <script>", "Two"],
    button: { label: "Go", url: 'https://x.example/"><img>' },
    footnote: "F",
  });
  check("escapes every piece", !mail.html.includes("<script>") && !mail.html.includes('"><img>') && mail.html.includes("H &amp; co"));
  check("text carries the link", mail.text.includes('Go: https://x.example/"><img>') && mail.text.startsWith("H & co"));
  check("has the sign-in e-mails' gradient bar", mail.html.includes("linear-gradient(90deg,#ec4899,#a855f7)"));

  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const ok = await sendAccountEmail({ apiKey: "re_x", from: "FanFunnel <account@x.example>" }, ["a@x.example"], mail, (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch);
  check("sends one Resend request from the account sender", ok && calls.length === 1 && calls[0].body.from === "FanFunnel <account@x.example>");
  check("no key → nothing sent", !(await sendAccountEmail({ apiKey: null, from: "x" }, ["a@x.example"], mail)));
  const warn = console.warn;
  console.warn = () => {};
  check("a network failure → false, never thrown", !(await sendAccountEmail({ apiKey: "k", from: "x" }, ["a@x.example"], mail, (async () => { throw new Error("down"); }) as unknown as typeof fetch)));
  console.warn = warn;
  console.log(`accountMail.test: ${passed} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
