// Demo-mode store for fan → FanFunnel safety reports (mirrors creator_reports
// after 0064). Pinned to globalThis like the main mock store, so the fan's
// POST /api/report and the admin's /api/admin/reports bundles share it.
import type { ReportStatus } from "@/lib/reports/config";

export interface MockReport {
  id: string;
  creatorId: string;
  fanId: string | null;
  token: string | null;
  reason: string;
  detail: string | null;
  status: ReportStatus;
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolutionNote: string | null;
}

const g = globalThis as unknown as { __ffMockReports?: MockReport[] };

export function mockReportStore(): MockReport[] {
  return (g.__ffMockReports ??= []);
}

/** Test hook: forget every demo report. */
export function resetMockReports(): void {
  g.__ffMockReports = [];
}

export function addMockReport(input: Pick<MockReport, "creatorId" | "fanId" | "token" | "reason" | "detail">): MockReport {
  const row: MockReport = {
    id: crypto.randomUUID(),
    ...input,
    status: "open",
    createdAt: new Date().toISOString(),
    resolvedAt: null,
    resolvedBy: null,
    resolutionNote: null,
  };
  mockReportStore().push(row);
  return row;
}

/** The same stamping rules as the 0064 creator_reports_review_stamp trigger. */
export function reviewMockReport(
  id: string,
  status: ReportStatus,
  note: string | null,
  actorId: string | null,
): MockReport | null {
  const row = mockReportStore().find((r) => r.id === id);
  if (!row) return null;
  if (row.status !== status) {
    row.status = status;
    if (status === "open") {
      row.resolvedAt = null;
      row.resolvedBy = null;
      row.resolutionNote = null;
      return row;
    }
    row.resolvedAt = new Date().toISOString();
    row.resolvedBy = actorId;
  }
  if (status !== "open") row.resolutionNote = note;
  return row;
}
