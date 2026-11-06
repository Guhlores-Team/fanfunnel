import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { WonPrize } from "@/lib/data/types";
import { groupWonPrizes, parseDeliveredReward, parseRewardHistoryPage, rewardViewError } from "./instantReward";
import InstantReward from "./InstantReward";
import RewardReveal from "../reveal/RewardReveal";

let passed = 0;
function check(label: string, value: boolean) {
  assert.ok(value, label);
  passed++;
}

// A repeated prize still has one card, but every actual delivered code can be
// reopened by its own share id. A manual win never becomes a reward reference.
const history: readonly WonPrize[] = Object.freeze([
  Object.freeze({ label: "Gift", rarity: "common" as const, at: "2026-10-28T12:00:00Z", instant: true, shareId: "code_new" }),
  Object.freeze({ label: "Gift", rarity: "common" as const, at: "2026-10-27T12:00:00Z", instant: true, shareId: "code_old" }),
  Object.freeze({ label: "Gift", rarity: "common" as const, at: "2026-10-26T12:00:00Z", shareId: "manual_win" }),
  Object.freeze({ label: "Gift", rarity: "legendary" as const, at: "2026-10-25T12:00:00Z", instant: true, shareId: "legendary_win" }),
]);
const groups = groupWonPrizes(history);
check("rarity grouping and order survive", groups.length === 2 && groups[0].rarity === "legendary");
const common = groups.find((g) => g.rarity === "common")!;
check("repeated collection card keeps its count", common.count === 3);
check("the latest time survives", common.latest === history[0].at);
check("both instant wins have distinct reopen targets", common.instantWins.map((w) => w.shareId).join() === "code_new,code_old");
check("manual win is not offered as an instant reward", !common.instantWins.some((w) => w.shareId === "manual_win"));
check("references expose only the win id and date", common.instantWins.every((w) => Object.keys(w).sort().join() === "at,shareId"));
check("duplicate history references get one reopen control", groupWonPrizes([history[0], history[0]])[0].instantWins.length === 1);
check("invalid share id never becomes a request target", groupWonPrizes([{ ...history[0], shareId: "../other" }])[0].instantWins.length === 0);

const page = parseRewardHistoryPage({
  wins: [{ shareId: "old_win", label: "Earlier gift", rarity: "rare", at: "2025-01-01T00:00:00Z", value: "must-not-propagate", cipher: "must-not-propagate" }],
  nextCursor: "opaque-cursor",
});
check("history keeps old references without a recent-win cutoff", page?.wins[0].shareId === "old_win");
check("history cursor is returned unchanged", page?.nextCursor === "opaque-cursor");
check("history strips every extra field", Object.keys(page!.wins[0]).sort().join() === "at,label,rarity,shareId");
check("empty final page accepted", parseRewardHistoryPage({ wins: [], nextCursor: null })?.nextCursor === null);
for (const bad of [
  null,
  { wins: [] },
  { wins: [], nextCursor: 1 },
  { wins: [], nextCursor: "" },
  { wins: [{ ...page!.wins[0], shareId: "../invalid" }], nextCursor: null },
  { wins: [{ ...page!.wins[0], rarity: "invalid" }], nextCursor: null },
  { wins: [{ ...page!.wins[0], at: "not-a-date" }], nextCursor: null },
]) check("invalid history response refused", parseRewardHistoryPage(bad) === null);

// The caller's own API response is still untrusted input for an href. Never
// render javascript/data/http/credential links, or a malformed reward shape.
for (const value of ["javascript:alert(1)", "data:text/html,x", "http://example.test/x", "/relative", "https://user:password@example.test/x"]) {
  check("unsafe reward link refused", parseDeliveredReward({ kind: "link", value }) === null);
  const html = renderToStaticMarkup(createElement(InstantReward, { reward: { kind: "link", value } }));
  check("unsafe link never produces an anchor", !html.includes("<a "));
}
for (const input of [null, "secret", {}, { kind: "other", value: "x" }, { kind: "text", value: 42 }, { kind: "code", value: "" }]) {
  check("malformed reward is refused", parseDeliveredReward(input) === null);
}
check("text length bounded", parseDeliveredReward({ kind: "text", value: "x".repeat(501) }) === null);
check("code length bounded", parseDeliveredReward({ kind: "code", value: "x".repeat(201) }) === null);
check("a code is preserved exactly", parseDeliveredReward({ kind: "code", value: "ABC-1234" })?.value === "ABC-1234");

const link = renderToStaticMarkup(createElement(InstantReward, { reward: { kind: "link", value: "https://rewards.example.test/redeem?code=private" } }));
check("external link uses a separate tab", link.includes('target="_blank"'));
check("external link blocks opener and referrer", link.includes('rel="noopener noreferrer"') && link.includes('referrerPolicy="no-referrer"'));
check("external destination explained before opening", link.includes("Opens an external website in a new tab.") && link.includes("rewards.example.test"));
const code = renderToStaticMarkup(createElement(InstantReward, { reward: { kind: "code", value: "ABC<script>1234" } }));
check("reward values are escaped text", !code.includes("<script>") && code.includes("&lt;script&gt;"));
check("copy is an explicit button", code.includes('type="button"') && code.includes("Copy code"));
check("copy notice has a live status", code.includes('role="status"') && code.includes('aria-live="polite"'));
check("rate limiting has a useful retry message", rewardViewError(429).includes("Wait a moment"));
check("blocked link does not disclose another reward", rewardViewError(403).includes("Contact your creator"));

const revealProps = {
  prize: { id: "gift", label: "Gift", rarity: "common" as const, weight: 1 },
  shareId: "public_win",
  entrance: "static" as const,
  onClose: () => undefined,
};
const instantReveal = renderToStaticMarkup(createElement(RewardReveal, {
  ...revealProps,
  instant: true,
  extra: createElement(InstantReward, { reward: { kind: "code", value: "OWN-CODE-1234" } }),
}));
check("instant win displays its private reward slot", instantReveal.includes("OWN-CODE-1234"));
check("instant win explains re-view access", instantReveal.includes("You can reopen it from Your wins."));
check("instant win does not ask for manual claiming", !instantReveal.includes("Screenshot this"));
const manualReveal = renderToStaticMarkup(createElement(RewardReveal, revealProps));
check("manual win preserves existing claiming instructions", manualReveal.includes("Screenshot this"));

console.log(`instantReward.test: ${passed} checks passed`);
