/**
 * CSV for spreadsheet downloads (PR-07). Every cell is quoted; a cell that a
 * spreadsheet would read as a formula (starting with =, +, -, @, tab or CR)
 * is prefixed with an apostrophe so a fan name like "=HYPERLINK(...)" is
 * text, never code (CSV injection). Rows end in CRLF and the file starts
 * with a UTF-8 BOM so Excel reads accents correctly.
 */
export function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function toCsv(rows: readonly (readonly unknown[])[]): string {
  return "﻿" + rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

/** The attachment headers for a CSV download. */
export function csvHeaders(filename: string): Record<string, string> {
  const safe = filename.replace(/[^A-Za-z0-9._-]/g, "_");
  return {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${safe}"`,
    "Cache-Control": "no-store",
  };
}

/** A file-name date stamp (UTC), e.g. 2026-11-10. */
export function csvDateStamp(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}
