import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FanAccountSummary } from "../data/types";
import { fillTemplate, templateHasLink, TEMPLATE_TOKENS } from "./template";
import {
  contactedLabel,
  selectDormant,
  winbackAutopilotCard,
  winbackStats,
  type OutreachRow,
  type WinbackCandidate,
} from "./list";
import {
  DEFAULT_WINBACK_TEMPLATE,
  WINBACK_CONTACT_COOLDOWN_DAYS,
  WINBACK_LIST_LIMIT,
  WINBACK_MODE,
  WINBACK_QUIET_DAYS,
  WINBACK_SNOOZE_DAYS,
} from "./config";
import { contactToken, fanEngagementAllowed } from "../engagement";

let passed = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  passed++;
};
const eq = <T,>(a: T, b: T, label: string) => {
  assert.equal(a, b, label);
  passed++;
};

// --- Decisions (D6 and the hard-coded guardrails) --------------------------
eq(WINBACK_MODE, "queue", "D6 default is (b): copy + work-the-queue");
eq(WINBACK_QUIET_DAYS, 14, "quiet = 14+ days");
eq(WINBACK_CONTACT_COOLDOWN_DAYS, 14, "14-day minimum between contacts");
eq(WINBACK_SNOOZE_DAYS, 30, "snooze = 30 days");

// --- fillTemplate -----------------------------------------------------------
const all = { name: "Nova", link: "https://x.test/spin/abc", lastWin: "VIP Month", days: 21, creator: "Mia" };
eq(
  fillTemplate("{name}|{link}|{lastWin}|{days}|{creator}", all),
  "Nova|https://x.test/spin/abc|VIP Month|21|Mia",
  "every token is filled",
);
eq(TEMPLATE_TOKENS.join(" "), "{name} {link} {lastWin} {days} {creator}", "the editor lists all five tokens");
eq(fillTemplate("{link} and {link}", all), "https://x.test/spin/abc and https://x.test/spin/abc", "a token can repeat");
eq(fillTemplate("Hi {unknown} {Name}", all), "Hi {unknown} {Name}", "unknown tokens are left as typed (case-sensitive)");
eq(fillTemplate("Hey {name}! Your link: {link}", { link: "L" }), "Hey! Your link: L", "a missing value is blank, with no stray space");
eq(fillTemplate("It's been {days} days", { days: 0 }), "It's been 0 days", "zero days is a value, not missing");
eq(fillTemplate("A\n\n{name}", { name: null }), "A\n\n", "newlines are kept");
eq(fillTemplate("Hi {name}", { name: "{link}" }), "Hi {link}", "a value is inserted literally, never re-expanded");
eq(
  fillTemplate("Hi {name} <b>{lastWin}</b>", { name: "<script>alert(1)</script>", lastWin: "&amp;" }),
  "Hi <script>alert(1)</script> <b>&amp;</b>",
  "plain text in, plain text out: nothing is escaped or interpreted",
);
eq(fillTemplate("Hi  there", { name: "x" }), "Hi  there", "the creator's own spacing is untouched when nothing is blank");
ok(templateHasLink(DEFAULT_WINBACK_TEMPLATE.body), "the default template carries the link");
ok(!templateHasLink("Miss you!"), "a template without {link} is detected");
eq(
  fillTemplate(DEFAULT_WINBACK_TEMPLATE.body, all),
  "Hey Nova! It's been 21 days since your VIP Month — I saved you a fresh spin: https://x.test/spin/abc",
  "the default template reads naturally",
);

// --- F6 engagement gate -----------------------------------------------------
const NOW = Date.parse("2026-10-27T12:00:00Z");
const DAY = 86_400_000;
const iso = (d: number) => new Date(NOW + d * DAY).toISOString();
ok(fanEngagementAllowed({ blocked: false, selfExcluded: false }, NOW), "an ordinary fan may be nudged");
ok(!fanEngagementAllowed({ blocked: true, selfExcluded: false }, NOW), "never a blocked fan");
ok(!fanEngagementAllowed({ blocked: false, selfExcluded: true }, NOW), "never a fan who paused a link");
ok(!fanEngagementAllowed({ blocked: false, selfExcluded: false, breakUntil: iso(3) }, NOW), "never a fan on a break");
ok(fanEngagementAllowed({ blocked: false, selfExcluded: false, breakUntil: iso(-1) }, NOW), "a finished break no longer blocks");
ok(!fanEngagementAllowed({ blocked: false, selfExcluded: false, breakUntil: "soon" }, NOW), "an unreadable break date fails closed");
eq(contactToken({ blocked: false, selfExcluded: false, activeToken: "t" }, NOW), "t", "the active link is offered");
eq(contactToken({ blocked: true, selfExcluded: false, activeToken: "t" }, NOW), null, "no link for a gated fan");

// --- selectDormant / winbackStats ---------------------------------------------
const fan = (id: string, over: Partial<WinbackCandidate> = {}): WinbackCandidate => ({
  fanId: id,
  name: id,
  totalSpent: 1000,
  daysSince: 20,
  lastActiveAt: iso(-20),
  primaryToken: `tok-${id}`,
  ...over,
});
const fans = [
  fan("big", { totalSpent: 9000 }),
  fan("small", { totalSpent: 100 }),
  fan("free", { totalSpent: 0 }),
  fan("gated", { primaryToken: null }),
  fan("fresh", { daysSince: 13, lastActiveAt: iso(-13) }),
  fan("never", { daysSince: null, lastActiveAt: null }),
  fan("edge", { daysSince: 14, lastActiveAt: iso(-14) }),
];
const ids = (rows: { fanId: string }[]) => rows.map((r) => r.fanId).join(",");
eq(ids(selectDormant(fans, [], NOW)), "big,edge,small", "quiet paying fans with a link, highest spend first");

const log: OutreachRow[] = [
  { fanId: "big", contactedAt: iso(-13.9), snoozedUntil: null },
  { fanId: "small", contactedAt: null, snoozedUntil: iso(1) },
];
eq(ids(selectDormant(fans, log, NOW)), "edge", "contacted (cooldown) and snoozed fans drop out");
eq(
  ids(selectDormant(fans, [{ fanId: "big", contactedAt: iso(-14), snoozedUntil: null }], NOW)),
  "big,edge,small",
  "the cooldown ends at exactly 14 days",
);
eq(
  ids(selectDormant(fans, [...log, { fanId: "big", contactedAt: iso(-40), snoozedUntil: null }], NOW)),
  "edge",
  "the latest contact counts, not an older one",
);
const many = Array.from({ length: 30 }, (_, i) => fan(`f${i}`, { totalSpent: 100 + i }));
eq(selectDormant(many, [], NOW).length, WINBACK_LIST_LIMIT, "the list is capped");

const stats = winbackStats(
  [fan("a", { lastActiveAt: iso(-1) }), fan("b"), fan("c")],
  [
    { fanId: "a", contactedAt: iso(-5), snoozedUntil: null },
    { fanId: "a", contactedAt: iso(-9), snoozedUntil: null },
    { fanId: "b", contactedAt: iso(-2), snoozedUntil: null },
    { fanId: "c", contactedAt: iso(-45), snoozedUntil: null },
    { fanId: "c", contactedAt: null, snoozedUntil: iso(10) },
    { fanId: "gone", contactedAt: iso(-1), snoozedUntil: null },
  ],
  NOW,
);
eq(stats.contacted, 2, "each fan counts once; old contacts, snoozes and deleted fans don't count");
eq(stats.cameBack, 1, "a spin after the latest contact = came back");
eq(stats.recent.map((r) => `${r.fanId}:${r.cameBack}`).join(","), "b:false,a:true", "recent: newest contact first");

// --- RM-6 seam: fans on a break never enter win-back ----------------------------
// RM-6 (0049) fills FanAccountSummary.breakUntil. Until then every fan reads as
// "not on a break". The CRM row's link is contactToken(summary), so a break
// takes the link away and selectDormant drops the fan, with no other wiring.
{
  const summary = (over: Partial<FanAccountSummary> = {}): FanAccountSummary => ({
    fanId: "brk",
    name: "On Break",
    spinsRemaining: 0,
    grantedTotal: 3,
    primaryToken: "tok-brk",
    totalSpent: 5000,
    campaignNames: [],
    tags: [],
    links: [{ token: "tok-brk" }],
    passes: [],
    lastWin: { label: "Shoutout", rarity: "common", at: iso(-20) },
    blocked: false,
    selfExcluded: false,
    activeToken: "tok-brk",
    ...over,
  });
  // The CRM row getCreatorCrm builds (src/lib/data/fans.ts, enrich).
  const row = (f: FanAccountSummary): WinbackCandidate => ({
    fanId: f.fanId,
    name: f.name,
    totalSpent: f.totalSpent,
    daysSince: 20,
    lastActiveAt: f.lastWin?.at ?? null,
    primaryToken: contactToken(f, NOW),
  });
  eq(ids(selectDormant([row(summary())], [], NOW)), "brk", "seam default: a fan with no break field is listed");
  eq(ids(selectDormant([row(summary({ breakUntil: null }))], [], NOW)), "brk", "breakUntil null = not on a break");
  eq(row(summary({ breakUntil: iso(5) })).primaryToken, null, "a fan on a break gets no link");
  eq(ids(selectDormant([row(summary({ breakUntil: iso(5) }))], [], NOW)), "", "a fan on a break never enters win-back");
  eq(ids(selectDormant([row(summary({ breakUntil: iso(-1) }))], [], NOW)), "brk", "…and is back once the break has ended");

  // Both hand-out paths pass the WHOLE summary to the gate, so the field RM-6
  // adds is honoured with no change here (a field-by-field copy would drop it).
  const ROOT = join(import.meta.dirname, "..", "..", "..");
  const fansSrc = readFileSync(join(ROOT, "src/lib/data/fans.ts"), "utf8");
  const crm = fansSrc.slice(fansSrc.indexOf("export async function getCreatorCrm"));
  ok(/const enrich = \(f: FanAccountSummary\): CrmFan =>[\s\S]*?primaryToken: contactToken\(f, now\),/.test(crm), "getCreatorCrm gates each row's link on the whole summary");
  ok(/const dormant = outreach \? selectDormant\(spenders, outreach, now\) : \[\];/.test(crm), "win-back lists only gated rows, and nobody when the log is unreadable");
  const drawer = readFileSync(join(ROOT, "src/components/dashboard/FanDetailDrawer.tsx"), "utf8");
  ok(/const linkFan = summary \? \{ \.\.\.summary, /.test(drawer), "the drawer gates its link on the whole summary");
}

// --- Today › "Needs you now" card ---------------------------------------------
eq(winbackAutopilotCard([]), null, "no quiet fans → no card");
{
  const q = winbackAutopilotCard([{ name: "Nova", daysSince: 21, primaryToken: "t" }, { name: "Kai", daysSince: 30, primaryToken: "u" }])!;
  eq(q.action.kind, "open_winback", "D6 (b): the card opens the queue");
  eq(q.cta, "Start win-back", "…with a Start win-back CTA");
  ok(q.title.startsWith("2 paying fans have"), "the title counts the queue");
  const c = winbackAutopilotCard([{ name: "Nova", daysSince: 21, primaryToken: "t" }], "copy")!;
  ok(c.action.kind === "copy_link" && c.action.token === "t", "copy mode keeps the one-tap link copy");
}

eq(stats.recent[0].daysAgo, 2, "recent rows carry whole days since the contact");
eq(contactedLabel(0), "Contacted today", "same day");
eq(contactedLabel(3), "Contacted 3d ago", "days ago");

console.log(`winback.test: ${passed} checks passed`);
