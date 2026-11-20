import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LEGAL } from "@/lib/legal";
import TeamReplyPill from "./TeamReplyPill";

// TS-07: the "Team" pill on a team member's reply in the fan's chat shows
// only when the owner's switch (LEGAL.teamReplyLabel.enabled) is on, and only
// on a creator message the server marked fromTeam. The switch is off in code;
// this test flips it in memory only.

let passed = 0;
const check = (label: string, cond: unknown) => { assert.ok(cond, label); passed++; };
const render = (message: { sender: "fan" | "creator"; fromTeam?: boolean }) => renderToStaticMarkup(createElement(TeamReplyPill, { message }));
const flag = LEGAL.teamReplyLabel as { enabled: boolean; label: string };

check("the switch ships off", LEGAL.teamReplyLabel.enabled === false);
check("off: a team reply has no pill", render({ sender: "creator", fromTeam: true }) === "");

flag.enabled = true;
try {
  const html = render({ sender: "creator", fromTeam: true });
  check("on: a team reply shows the pill with the configured label", html.includes('data-testid="team-reply-pill"') && html.includes(`>${LEGAL.teamReplyLabel.label}<`));
  check("on: the creator's own reply has no pill", render({ sender: "creator", fromTeam: false }) === "" && render({ sender: "creator" }) === "");
  check("on: a fan message never has one", render({ sender: "fan", fromTeam: true }) === "");
} finally {
  flag.enabled = false;
}
check("off again after the test", render({ sender: "creator", fromTeam: true }) === "");

console.log(`TeamReplyPill: ${passed} checks passed`);
