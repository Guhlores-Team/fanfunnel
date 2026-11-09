// Data layer — Admin › Reports: the fan → FanFunnel safety queue
// (creator_reports, 0012 + the 0064 review trail).
//
// Fans insert reports through the service role (reportCreator in ./fans).
// Reading and reviewing them is admin-only: the route checks requireAdminRoute
// (is_admin(): role, is_active and aal2) first, and this layer then uses the
// caller's own cookie-bound client, so the creator_reports RLS policy
// (is_admin()) is a second gate. Who resolved a report and when are stamped
// by the 0064 trigger from the session, never taken from the request. Demo
// mode uses the pinned in-memory store with the same rules.
import { isSupabaseConfigured, createClient } from "@/lib/supabase/server";
import {
  REPORTS_PAGE_SIZE,
  URGENT_REPORT_REASONS,
  isUrgentReportReason,
  type ReportStatus,
} from "@/lib/reports/config";
import { mockReportStore, reviewMockReport, type MockReport } from "./mockReports";
import { reportTokenHint } from "@/lib/reports/reportToken";
import { mockReportParties } from "./mock";

import type { AdminReport, ReportFilter, ReportPage } from "@/lib/reports/types";
export type { AdminReport, ReportFilter, ReportPage };

// N4: reports store a digest + hint (reportToken.ts); legacy rows the raw token.
const hint = reportTokenHint;

// Keyset cursor: "<created_at>|<id>".
export function encodeReportCursor(r: { createdAt: string; id: string }): string {
  return `${r.createdAt}|${r.id}`;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function decodeReportCursor(raw: string | null | undefined): { createdAt: string; id: string } | null {
  if (!raw) return null;
  const [createdAt, id] = raw.split("|");
  if (!createdAt || !id || !UUID.test(id) || Number.isNaN(Date.parse(createdAt))) return null;
  return { createdAt, id };
}

function sortNewest<T extends { createdAt: string; id: string }>(a: T, b: T): number {
  return b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);
}

function fromMock(r: MockReport): AdminReport {
  const parties = mockReportParties(r.creatorId, r.fanId);
  return {
    id: r.id,
    reason: r.reason,
    detail: r.detail,
    status: r.status,
    urgent: isUrgentReportReason(r.reason),
    createdAt: r.createdAt,
    resolvedAt: r.resolvedAt,
    resolutionNote: r.resolutionNote,
    creator: {
      id: r.creatorId,
      name: parties.creator?.name ?? "Creator",
      email: parties.creator?.email ?? null,
      publicSlug: null,
    },
    fan: r.fanId && parties.fanName ? { id: r.fanId, name: parties.fanName } : null,
    linkHint: hint(r.token),
  };
}

type DbReport = {
  id: string;
  reason: string;
  detail: string | null;
  status: string;
  created_at: string;
  resolved_at: string | null;
  resolution_note: string | null;
  token: string | null;
  creator_id: string;
  fan_id: string | null;
  creator: { display_name: string | null; email: string | null; public_slug: string | null } | null;
  fan: { display_name: string | null; handle: string | null } | null;
};

function fromDb(r: DbReport): AdminReport {
  const status = (["open", "resolved", "dismissed"] as const).find((s) => s === r.status) ?? "open";
  return {
    id: r.id,
    reason: r.reason,
    detail: r.detail,
    status,
    urgent: isUrgentReportReason(r.reason),
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
    resolutionNote: r.resolution_note,
    creator: {
      id: r.creator_id,
      name: r.creator?.display_name || r.creator?.email || "Creator",
      email: r.creator?.email ?? null,
      publicSlug: r.creator?.public_slug ?? null,
    },
    fan: r.fan_id ? { id: r.fan_id, name: r.fan?.display_name ?? r.fan?.handle ?? "Fan" } : null,
    linkHint: hint(r.token),
  };
}

/** One page of reports, newest first, plus the open counts (admin only). */
export async function listReports(
  filter: ReportFilter,
  before?: string | null,
  limit: number = REPORTS_PAGE_SIZE,
): Promise<ReportPage | { error: "load_failed" }> {
  const cursor = decodeReportCursor(before);
  const size = Math.min(Math.max(1, limit), REPORTS_PAGE_SIZE);

  if (!isSupabaseConfigured()) {
    const all = mockReportStore().slice().sort((a, b) => sortNewest(a, b));
    const open = all.filter((r) => r.status === "open");
    const rows = all
      .filter((r) => filter.status === "all" || r.status === filter.status)
      .filter((r) => !filter.reason || r.reason === filter.reason)
      .filter((r) => !cursor || sortNewest(r, cursor) > 0);
    const page = rows.slice(0, size);
    return {
      reports: page.map(fromMock),
      openCount: open.length,
      urgentOpenCount: open.filter((r) => isUrgentReportReason(r.reason)).length,
      next: rows.length > size ? encodeReportCursor(page[page.length - 1]) : null,
    };
  }

  const sb = await createClient();
  let q = sb
    .from("creator_reports")
    .select(
      "id, reason, detail, status, created_at, resolved_at, resolution_note, token, creator_id, fan_id, " +
        "creator:profiles!creator_reports_creator_id_fkey(display_name, email, public_slug), fan:fans(display_name, handle)",
    );
  if (filter.status !== "all") q = q.eq("status", filter.status);
  if (filter.reason) q = q.eq("reason", filter.reason);
  if (cursor) {
    q = q.or(`created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`);
  }
  const head = { count: "exact" as const, head: true };
  const [list, openRes, openRows] = await Promise.all([
    q.order("created_at", { ascending: false }).order("id", { ascending: false }).limit(size + 1),
    sb.from("creator_reports").select("id", head).eq("status", "open"),
    sb.from("creator_reports").select("id", head).eq("status", "open").in("reason", [...URGENT_REPORT_REASONS]),
  ]);
  if (list.error || openRes.error || openRows.error) return { error: "load_failed" };
  const rows = (list.data ?? []) as unknown as DbReport[];
  const page = rows.slice(0, size).map(fromDb);
  return {
    reports: page,
    openCount: openRes.count ?? 0,
    urgentOpenCount: openRows.count ?? 0,
    next: rows.length > size ? encodeReportCursor(page[page.length - 1]) : null,
  };
}

/** Open reports (admin badge). Null when they can't be read. */
export async function countOpenReports(): Promise<number | null> {
  if (!isSupabaseConfigured()) return mockReportStore().filter((r) => r.status === "open").length;
  const sb = await createClient();
  const { count, error } = await sb
    .from("creator_reports")
    .select("id", { count: "exact", head: true })
    .eq("status", "open");
  return error ? null : count ?? 0;
}

/**
 * Resolve, dismiss or reopen one report (admin). A note is kept for resolved
 * and dismissed reports and cleared on reopen.
 */
export async function reviewReport(
  id: string,
  status: ReportStatus,
  note: string | null,
  actorId: string | null,
): Promise<{ ok: true; report: AdminReport } | { error: "not_found" | "db_error" }> {
  const keptNote = status === "open" ? null : note;
  if (!isSupabaseConfigured()) {
    const row = reviewMockReport(id, status, keptNote, actorId);
    return row ? { ok: true, report: fromMock(row) } : { error: "not_found" };
  }
  const sb = await createClient();
  const { data, error } = await sb
    .from("creator_reports")
    .update({ status, resolution_note: keptNote })
    .eq("id", id)
    .select(
      "id, reason, detail, status, created_at, resolved_at, resolution_note, token, creator_id, fan_id, " +
        "creator:profiles!creator_reports_creator_id_fkey(display_name, email, public_slug), fan:fans(display_name, handle)",
    )
    .maybeSingle();
  if (error) return { error: "db_error" };
  if (!data) return { error: "not_found" };
  return { ok: true, report: fromDb(data as unknown as DbReport) };
}
