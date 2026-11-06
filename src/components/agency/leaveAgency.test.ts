import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LeaveAgencyView, LeftAgency, leaveErrorMessage, leaveKind, type LeaveStep } from "./LeaveAgency";

// "Leave agency" on /agency (0071 org_leave, POST /api/agency/leave). Who sees
// it is decided by leaveKind on the /api/agency answer: a staff seat in someone
// else's agency or a creator an agency manages. NEGATIVE: an owner, the demo
// and anyone without an agency never get the control. The route's refusals
// are asserted in src/app/api/agency/leave/route.test.ts; this file covers the
// UI's confirmation, pending and error states and its wiring.

let passed = 0;
const check = (label: string, cond: unknown) => { assert.ok(cond, label); passed++; };

const ORG = { id: "0a0a0a0a-0000-4000-8000-00000000000a", name: "Acme Talent" };

// --- who sees it ------------------------------------------------------------
check("an agency owner gets no leave control", leaveKind({ org: ORG, isOwner: true }) === null);
check("an owner flag that is missing never shows it either", leaveKind({ org: ORG }) === null);
check("a staff seat in someone else's agency can leave it", leaveKind({ org: ORG, isOwner: false }) === "staff");
check("a managed creator with its agency id can leave it", leaveKind({ org: null, managed: true, orgId: ORG.id }) === "creator");
check("a managed answer without an id shows nothing to click", leaveKind({ org: null, managed: true }) === null && leaveKind({ org: null, managed: true, orgId: "" }) === null);
check("the demo gets no leave control", leaveKind({ org: null, demo: true }) === null && leaveKind({ org: ORG, isOwner: false, demo: true }) === null);
check("someone with no agency gets no leave control", leaveKind(null) === null && leaveKind({ org: null }) === null);

// --- the confirmation step, pending and error -------------------------------
const noop = () => {};
const view = (step: LeaveStep, error: string | null = null, kind: "creator" | "staff" = "creator") =>
  renderToStaticMarkup(createElement(LeaveAgencyView, { kind, orgName: kind === "staff" ? ORG.name : null, step, error, onAsk: noop, onCancel: noop, onConfirm: noop }));

const idle = view("idle");
check("idle: a labelled section with one 'Leave agency' button", /<section[^>]*aria-labelledby=/.test(idle) && /data-testid="agency-leave-start"[^>]*>Leave agency</.test(idle) && /type="button"/.test(idle));
check("idle: the button is described by what leaving does", /aria-describedby="[^"]+"/.test(idle) && /stop acting for your account/.test(idle));
check("idle: nothing is confirmed yet", !idle.includes("Yes, leave") && !idle.includes('role="group"'));
const confirm = view("confirm");
check("confirm: a labelled group asks before anything is sent", /role="group"[^>]*aria-labelledby=/.test(confirm) && /Leave this agency\?/.test(confirm));
check("confirm: 'Yes, leave' and 'Cancel' are both offered", />Yes, leave</.test(confirm) && />Cancel</.test(confirm));
check("confirm: the start button is gone (no double entry)", !confirm.includes("agency-leave-start"));
const pending = view("pending");
check("pending: says it is leaving and marks the group busy", />Leaving…</.test(pending) && /aria-busy="true"/.test(pending));
check("pending: both buttons are disabled (no double submit, no cancel mid-request)", (pending.match(/<button[^>]*disabled=""/g) ?? []).length === 2);
const failed = view("confirm", leaveErrorMessage("not_member"));
check("error: announced as an alert, with the retry still offered", /role="alert"[^>]*>[^<]*not in this agency/.test(failed) && />Yes, leave</.test(failed));
const staff = view("idle", null, "staff");
check("staff: names the agency and says the seat ends", staff.includes("Leave Acme Talent") && /staff seat ends/.test(staff));
check("after leaving: a focusable heading and a status line, and a full page load back", /<h1[^>]*tabindex="-1"[^>]*>You left the agency/.test(renderToStaticMarkup(createElement(LeftAgency, { kind: "creator" }))) && /role="status"/.test(renderToStaticMarkup(createElement(LeftAgency, { kind: "staff" }))) && /<a href="\/dashboard"/.test(renderToStaticMarkup(createElement(LeftAgency, { kind: "staff" }))));

for (const code of ["not_member", "demo_only", "rate_limited", "unauthorized", "forbidden"]) {
  check(`${code} has its own message`, leaveErrorMessage(code) !== leaveErrorMessage("db_error"));
}
check("an unknown code is the generic message, never echoed", leaveErrorMessage("<b>x</b>") === leaveErrorMessage("db_error") && !leaveErrorMessage("<b>x</b>").includes("<b>"));

// --- wiring -----------------------------------------------------------------
const root = join(import.meta.dirname, "../../..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const leave = read("src/components/agency/LeaveAgency.tsx");
check("a client module that never imports the server Supabase helpers", leave.startsWith('"use client"') && !/supabase\/server|createServiceClient|SERVICE_ROLE/.test(leave));
check("posts { orgId } as JSON to /api/agency/leave, like the other agency controls", /fetch\("\/api\/agency\/leave", \{\s*method: "POST",\s*headers: \{ "Content-Type": "application\/json" \},\s*body: JSON\.stringify\(\{ orgId \}\)/.test(leave));
const client = read("src/components/agency/AgencyClient.tsx");
check("/agency decides with leaveKind on the server's answer", /const canLeave = leaveKind\(data\);/.test(client));
check("the console shows the staff control only for canLeave === \"staff\"", /\{canLeave === "staff" && <LeaveAgency kind="staff"/.test(client) && (client.match(/<LeaveAgency /g) ?? []).length === 2);
check("the managed view gets the id only for canLeave === \"creator\"", /orgId=\{canLeave === "creator" \? data\.orgId \?\? null : null\}/.test(client) && /\{orgId && <LeaveAgency kind="creator"/.test(client));
check("success replaces the view with the 'You left' confirmation", /if \(left\) return <LeftAgency kind=\{left\} \/>;/.test(client));

console.log(`leaveAgency: ${passed} checks passed`);
