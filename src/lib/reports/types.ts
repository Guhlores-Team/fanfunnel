// Admin › Reports shapes, shared by the server data layer and the client
// panel. Types only, so a "use client" module can import them without
// reaching the server-only data layer.
import type { ReportStatus } from "./config";

export interface AdminReport {
  id: string;
  reason: string;
  /** What the fan wrote (may be empty). Shown to admins only. */
  detail: string | null;
  status: ReportStatus;
  urgent: boolean;
  createdAt: string;
  resolvedAt: string | null;
  resolutionNote: string | null;
  creator: { id: string; name: string; email: string | null; publicSlug: string | null };
  /** The reporting fan's name as their creator entered it; null once deleted. */
  fan: { id: string; name: string } | null;
  /** Last characters of the spin link the report came from (never the link). */
  linkHint: string | null;
}

export type ReportFilter = { status: ReportStatus | "all"; reason?: string };

export interface ReportPage {
  reports: AdminReport[];
  /** Open reports across every reason, for the Admin badge. */
  openCount: number;
  urgentOpenCount: number;
  /** Pass back as `before` for the next page; null on the last page. */
  next: string | null;
}
