import assert from "node:assert";
import { deliveryLabel, firstEmbedded, toWinDelivery, winDate, winDateLocal } from "./delivery";

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

// T5: each redemption status maps to what the fan sees, from existing columns only.
check("pending reads as waiting", toWinDelivery("pending", null)?.status === "waiting");
check("in_progress reads as in progress", toWinDelivery("in_progress", null)?.status === "in_progress");
const delivered = toWinDelivery("fulfilled", "2026-11-04T10:00:00Z");
check("fulfilled reads as delivered with its time", delivered?.status === "delivered" && delivered.at === "2026-11-04T10:00:00Z");
check("cancelled reads as cancelled", toWinDelivery("cancelled", null)?.status === "cancelled");
check("a stale fulfilled_at never dates a waiting win", toWinDelivery("pending", "2026-11-04T10:00:00Z")?.at === null);
check("an unknown status shows nothing", toWinDelivery("weird", null) === undefined && toWinDelivery(undefined, undefined) === undefined);

check("labels: waiting", deliveryLabel({ status: "waiting", at: null }) === "Waiting for the creator");
check("labels: in progress", deliveryLabel({ status: "in_progress", at: null }) === "In progress");
check("labels: delivered with a date", deliveryLabel(delivered!) === "Delivered November 4, 2026");
check("labels: delivered without a date", deliveryLabel({ status: "delivered", at: null }) === "Delivered");
check("labels: cancelled", deliveryLabel({ status: "cancelled", at: null }) === "Cancelled by the creator");

check("dates are UTC calendar days", winDate("2026-01-31T23:59:59Z") === "January 31, 2026");
check("a bad date is blank, never a throw", winDate("nope") === "");
check("RF-10: the local day follows the viewer's zone", winDateLocal("2026-01-31T23:30:00Z", "en-US", "Pacific/Auckland") === "February 1, 2026" && winDateLocal("2026-01-31T23:30:00Z", "en-US", "America/Los_Angeles") === "January 31, 2026");
check("RF-10: a bad local date is blank", winDateLocal("nope") === "");

check("embeds: object", firstEmbedded({ a: 1 })?.a === 1);
check("embeds: array", firstEmbedded([{ a: 2 }])?.a === 2);
check("embeds: empty array or null", firstEmbedded([]) === null && firstEmbedded(null) === null);

console.log(`delivery.test: ${passed} checks passed`);
