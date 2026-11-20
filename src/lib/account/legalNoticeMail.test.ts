import assert from "node:assert/strict";
import { buildLegalNoticeEmail, sendLegalNoticeEmails } from "./legalNoticeMail";
import type { AccountMail, AccountMailConfig } from "./accountMail";

// TS-06: the e-mail the Terms promise creators before a material change. One
// message per address (never a shared To line), no account data in the body,
// honest counts back to the admin, and nothing attempted when no sender is
// configured or in local development.

let passed = 0;
const check = (label: string, cond: unknown) => {
  assert.ok(cond, label);
  passed++;
};

const notice = { version: "2027-01-31", effectiveDate: "2027-01-31" };
const cfg: AccountMailConfig = { apiKey: "re_test", from: "FanFunnel <no-reply@example.test>" } as AccountMailConfig;

async function main() {
  const mail = buildLegalNoticeEmail(notice, "https://fanfunnel.example", "Prizes section rewritten.");
  check("the subject names the date", mail.subject === "FanFunnel's Terms and Privacy Policy change on January 31, 2027");
  check("the body links the published text", mail.text.includes("https://fanfunnel.example/terms") && mail.text.includes("https://fanfunnel.example/privacy"));
  check("the admin's sentence is included", mail.text.includes("Prizes section rewritten."));
  check("it says what happens on the date", /dashboard asks you to agree/.test(mail.text) && /fans are asked on their spin page/.test(mail.text));
  check("no purchase or gambling words", !/\b(buy|paid|purchase|gamble|bet|lottery)\b/i.test(mail.text));
  const bare = buildLegalNoticeEmail(notice, null);
  check("without an origin there is no button and no broken link", !/undefined|null\//.test(bare.text) && !bare.html.includes("href=\"null"));

  const sentTo: string[][] = [];
  const send = async (_cfg: AccountMailConfig, to: string[], _mail: AccountMail) => {
    sentTo.push(to);
    return !to[0].startsWith("bounce");
  };
  const all = await sendLegalNoticeEmails(notice, ["a@x.test", "b@x.test", "bounce@x.test", "c@x.test"], { cfg, send, environment: "production", origin: null });
  check("every address gets its own message", sentTo.length === 4 && sentTo.every((to) => to.length === 1));
  check("counts are honest", all.status === "partial" && all.sent === 3 && all.failed === 1 && all.unsent === 0);

  sentTo.length = 0;
  const clean = await sendLegalNoticeEmails(notice, ["a@x.test", "b@x.test"], { cfg, send, environment: "production", origin: null });
  check("all accepted → sent", clean.status === "sent" && clean.sent === 2);

  sentTo.length = 0;
  check("no sender → nothing attempted", (await sendLegalNoticeEmails(notice, ["a@x.test"], { cfg: { ...cfg, apiKey: "" } as AccountMailConfig, send, environment: "production" })).status === "not_configured" && sentTo.length === 0);
  check("local development never sends", (await sendLegalNoticeEmails(notice, ["a@x.test"], { cfg, send, environment: "development" })).status === "not_configured" && sentTo.length === 0);
  check("no creators → none", (await sendLegalNoticeEmails(notice, [], { cfg, send, environment: "production" })).status === "none");

  // The time budget: once it is spent, the rest are reported unsent, not silently dropped.
  let clock = 0;
  const slow = async () => {
    clock += 10_000;
    return true;
  };
  const many = Array.from({ length: 20 }, (_, i) => `c${i}@x.test`);
  const budget = await sendLegalNoticeEmails(notice, many, { cfg, send: slow, environment: "production", origin: null, budgetMs: 25_000, now: () => clock });
  check("the budget stops the run and reports the rest", budget.status === "partial" && budget.sent >= 1 && budget.unsent > 0 && budget.sent + budget.unsent === 20);

  const thrower = async () => {
    throw new Error("network");
  };
  const threw = await sendLegalNoticeEmails(notice, ["a@x.test"], { cfg, send: thrower, environment: "production", origin: null });
  check("a throwing sender is a failed address, not a crash", threw.status === "partial" && threw.failed === 1);

  console.log(`legal notice mail: ${passed} checks passed`);
}
void main();
