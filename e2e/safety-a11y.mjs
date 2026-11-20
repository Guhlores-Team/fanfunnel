// Independent axe states for Admin › Reports (A1) and a blocked fan (A4).
// Each makes its own fan (and report) through the real demo APIs, so none
// depends on e2e's data surviving the first-run wipe.
import { randomUUID } from "node:crypto";
import { BASE, clickTab, goto } from "./harness.mjs";
import { safetyFan } from "./safety.mjs";

const PHONE = { width: 390, height: 844 };

async function reportFixture(request, reason) {
  const tag = randomUUID().slice(0, 6);
  const fan = await safetyFan(request, `A11y Reporter ${tag}`);
  const res = await request.post(BASE + "/api/report", {
    data: { token: fan.token, reason, detail: `A11y scan report ${tag}. Please take a look at the creator's public page.` },
  });
  if (!res.ok()) throw new Error(`could not file the scan report (${res.status()})`);
  return { ...fan, tag };
}

async function findReport(page, fan, status = "Open") {
  await clickTab(page, "Admin");
  const region = page.getByRole("region", { name: "Reports", exact: true });
  await region.waitFor({ timeout: 8000 });
  if (status !== "Open") await region.getByRole("group", { name: "Show reports" }).getByRole("button", { name: status }).click();
  const row = region.getByTestId("admin-report").filter({ hasText: fan.name }).first();
  await row.waitFor({ timeout: 8000 });
  await row.scrollIntoViewIfNeeded();
  return { region, row };
}

/** An open urgent report with the fan's words revealed and a note typed. */
const openUrgentReport = async (page) => {
  const fan = await reportFixture(page.request, "Involves someone under 18");
  const { row } = await findReport(page, fan);
  await row.getByRole("button", { name: "What the fan wrote" }).click();
  await row.getByLabel("Note (optional, admins only)").fill("Checked the public page");
  await page.waitForTimeout(400);
};

/** A photo report, resolved with a note, under the Resolved filter. */
const openResolvedReport = async (page) => {
  const fan = await reportFixture(page.request, "Inappropriate photo");
  const list = await (await page.request.get(BASE + "/api/admin/reports?status=open")).json();
  const id = list.reports?.find((r) => r.fan?.name === fan.name)?.id;
  if (!id) throw new Error("the scan report is not in the open queue");
  const res = await page.request.post(BASE + "/api/admin/reports", { data: { id, status: "resolved", note: "Photos removed" } });
  if (!res.ok()) throw new Error(`could not resolve the scan report (${res.status()})`);
  await goto(page, "/dashboard", 1200);
  await findReport(page, fan, "Resolved");
  await page.waitForTimeout(400);
};

/** Leave the queue as we found it: dismiss this scan's own reports. */
const dismissScanReports = async (page) => {
  const list = await (await page.request.get(BASE + "/api/admin/reports?status=all")).json().catch(() => ({}));
  for (const r of list.reports ?? []) {
    if (r.status !== "dismissed" && /^A11y scan report /.test(r.detail ?? "")) {
      await page.request.post(BASE + "/api/admin/reports", { data: { id: r.id, status: "dismissed" } });
    }
  }
};

async function blockedFixture(page) {
  const fan = await safetyFan(page.request, `A11y Blocked ${randomUUID().slice(0, 6)}`);
  const res = await page.request.post(`${BASE}/api/fans/${fan.fanId}/block`, { data: { blocked: true } });
  if (!res.ok()) throw new Error(`could not block the scan fan (${res.status()})`);
  return fan;
}

/** The blocked fan's own page: the note instead of chat and the wishlist. */
const openBlockedFan = async (page) => {
  const fan = await blockedFixture(page);
  await goto(page, `/spin/${fan.token}`, 1200);
  await page.getByTestId("fan-blocked-note").waitFor({ timeout: 8000 });
};

/** Blocked mid-session: the chat's refusal note replaces the composer. */
const openBlockedChat = async (page) => {
  const fan = await safetyFan(page.request, `A11y Chat ${randomUUID().slice(0, 6)}`);
  await goto(page, `/spin/${fan.token}`, 1200);
  await page.locator("button[aria-label='Message creator']").first().click();
  const input = page.locator("input[aria-label^='Message ']");
  await input.waitFor({ timeout: 8000 });
  const res = await page.request.post(`${BASE}/api/fans/${fan.fanId}/block`, { data: { blocked: true } });
  if (!res.ok()) throw new Error(`could not block the scan fan (${res.status()})`);
  await input.fill("Hello?");
  await page.keyboard.press("Enter");
  await page.locator("[aria-label^='Chat with'] [role='alert']").waitFor({ timeout: 8000 });
  await page.waitForTimeout(300);
};

export function safetyA11yStates(dashAdvisory) {
  return [
    { path: "/dashboard", name: "dashboard (Admin Reports: urgent, details open)", prep: openUrgentReport, cleanup: dismissScanReports, advisory: dashAdvisory },
    { path: "/dashboard", name: "dashboard phone (Admin Reports: urgent, details open)", viewport: PHONE, prep: openUrgentReport, cleanup: dismissScanReports, advisory: dashAdvisory },
    { path: "/dashboard", name: "dashboard (Admin Reports: resolved with a note)", prep: openResolvedReport, cleanup: dismissScanReports, advisory: dashAdvisory },
    { path: null, name: "fan spin (blocked fan)", prep: openBlockedFan },
    { path: null, name: "fan spin phone (blocked fan)", viewport: PHONE, prep: openBlockedFan },
    { path: null, name: "fan chat (blocked mid-session)", prep: openBlockedChat },
  ];
}
