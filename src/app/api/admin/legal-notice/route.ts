import { NextResponse } from "next/server";
import { requireAdminRoute } from "@/lib/auth/admin";
import { rateLimitOr429 } from "@/lib/api/limit";
import { BAD_REQUEST, parseJsonBody } from "@/lib/api/handler";
import { recordAudit } from "@/lib/data/audit";
import { getStoredLegalNotice, listCreatorEmailsForLegalNotice, setLegalNotice } from "@/lib/data/legalNotice";
import { sendLegalNoticeEmails, type LegalNoticeMailResult } from "@/lib/account/legalNoticeMail";
import { LEGAL, legalNoticeInputError } from "@/lib/legal";
import { currentEnvironment } from "@/lib/monitoring/config";
import { NO_STORE_HEADERS } from "@/lib/privacy/respond";

// TS-06: Admin › "Terms change notice". An admin announces the version that
// will replace the current Terms/Privacy text and the date it takes effect;
// fan pages and the dashboard then show one line until that date, and every
// active creator is e-mailed. Admins on a two-factor session only
// (requireAdminRoute: is_admin() + aal2; set_legal_terms_notice() checks
// is_admin() again in the database). Audited as legal.notice.
const json = (value: unknown, status = 200) => NextResponse.json(value, { status, headers: NO_STORE_HEADERS });
export const maxDuration = 60;

export async function GET() {
  const admin = await requireAdminRoute();
  if (!admin.ok) admin.response.headers.set("Cache-Control", "no-store");
  if (!admin.ok) return admin.response;
  return json({ notice: await getStoredLegalNotice(), current: LEGAL.version, noticeDays: LEGAL.changeNoticeDays });
}

export async function POST(req: Request) {
  const admin = await requireAdminRoute();
  if (!admin.ok) admin.response.headers.set("Cache-Control", "no-store");
  if (!admin.ok) return admin.response;
  // The same ceiling as the admin win lookup: an admin correcting a date a few times is never refused.
  const limited = await rateLimitOr429(`admin-legal-notice:${admin.userId ?? "demo"}`, 30, 60_000);
  if (limited) {
    limited.headers.set("Cache-Control", "no-store");
    return limited;
  }
  const body = await parseJsonBody<{ version?: unknown; effectiveDate?: unknown; sooner?: unknown; summary?: unknown; clear?: unknown }>(req);
  if (body === BAD_REQUEST) return json({ error: "bad_request" }, 400);

  if (body.clear === true) {
    const cleared = await setLegalNotice(null);
    if ("error" in cleared) return json({ error: cleared.error }, cleared.error === "unauthorized" ? 401 : cleared.error === "forbidden" ? 403 : 500);
    await recordAudit({ actorId: admin.userId, action: "legal.notice", targetType: null, targetId: null, details: { cleared: true } });
    return json({ notice: null });
  }

  const invalid = legalNoticeInputError(body.version, body.effectiveDate, { sooner: body.sooner === true });
  if (invalid) return json({ error: invalid }, 400);
  if (body.summary !== undefined && (typeof body.summary !== "string" || body.summary.length > 280)) return json({ error: "invalid_summary" }, 400);
  const notice = { version: body.version as string, effectiveDate: body.effectiveDate as string };
  const saved = await setLegalNotice(notice);
  if ("error" in saved) {
    const status = saved.error === "unauthorized" ? 401 : saved.error === "forbidden" ? 403 : saved.error === "invalid_notice" ? 400 : 500;
    return json({ error: saved.error }, status);
  }

  // The e-mail the Terms promise creators. Its failure never undoes the notice.
  const recipients = await listCreatorEmailsForLegalNotice();
  const mail: LegalNoticeMailResult =
    recipients === "error"
      ? { status: "partial", sent: 0, failed: 0, unsent: 0 }
      : await sendLegalNoticeEmails(notice, recipients, { environment: currentEnvironment(), summary: typeof body.summary === "string" ? body.summary : null });
  await recordAudit({
    actorId: admin.userId,
    action: "legal.notice",
    targetType: null,
    targetId: null,
    details: { version: notice.version, effective: notice.effectiveDate, sooner: body.sooner === true, mailed: mail.sent, mail_failed: mail.failed + mail.unsent, mail: mail.status },
  });
  return json({ notice: saved.notice ?? notice, mail: { ...mail, listFailed: recipients === "error" } });
}
