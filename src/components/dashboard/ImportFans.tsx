"use client";

import { useMemo, useState } from "react";
import { useToast } from "@/components/ui/Toast";
import { submitFanImport } from "./importIntent";
import CreatorRequestRecovery from "./CreatorRequestRecovery";
import { useCreatorDraft, useCreatorLeave } from "./CreatorDrafts";

interface ParsedRow {
  name: string;
  spins: number;
  amountCents?: number;
}

interface ParseResult {
  rows: ParsedRow[];
  warnings: string[];
  skippedHeader: boolean;
}

const MAX_ROWS = 500;

// Parse pasted/loaded CSV text into fan rows. Columns: name, spins, amount($).
// Header row optional — if the first line's 2nd cell isn't a number, skip it.
function parseCsv(text: string): ParseResult {
  const warnings: string[] = [];
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  let skippedHeader = false;
  if (lines.length > 0) {
    const firstCells = lines[0].split(",").map((c) => c.trim());
    const spinsCell = firstCells[1] ?? "";
    // A header is detected when the spins column isn't a number.
    if (spinsCell === "" || Number.isNaN(Number(spinsCell))) {
      lines.shift();
      skippedHeader = true;
    }
  }

  const rows: ParsedRow[] = [];
  lines.forEach((line, i) => {
    const cells = line.split(",").map((c) => c.trim());
    const name = cells[0] ?? "";
    if (!name) {
      warnings.push(`Row ${i + 1}: missing name — skipped.`);
      return;
    }
    const spinsRaw = cells[1] ?? "";
    const spinsNum = Number(spinsRaw);
    if (spinsRaw === "" || Number.isNaN(spinsNum)) {
      warnings.push(`Row ${i + 1} (${name}): invalid spins "${spinsRaw}" — skipped.`);
      return;
    }
    const spins = Math.max(0, Math.floor(spinsNum));

    let amountCents: number | undefined;
    const amountRaw = cells[2] ?? "";
    if (amountRaw !== "") {
      const dollars = Number(amountRaw.replace(/[$,]/g, ""));
      if (Number.isNaN(dollars)) {
        warnings.push(`Row ${i + 1} (${name}): invalid amount "${amountRaw}" — ignored.`);
      } else {
        amountCents = Math.max(0, Math.round(dollars * 100));
      }
    }

    rows.push({ name, spins, amountCents });
  });

  if (rows.length > MAX_ROWS) {
    warnings.push(`Only the first ${MAX_ROWS} rows will be imported (cap reached).`);
  }

  return { rows: rows.slice(0, MAX_ROWS), warnings, skippedHeader };
}

/**
 * The bulk-import form. The "Import fans" trigger lives in the Fans list
 * controls, so the form is controlled: mount it while `open`, `onClose` hides.
 */
export default function ImportFans({
  campaignId,
  onImported,
  onClose,
}: {
  campaignId?: string;
  onImported: () => void;
  onClose: () => void;
}) {
  const toast = useToast();
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [pending, setPending] = useState(false);
  const [checking, setChecking] = useState(false);
  const leave = useCreatorLeave();
  useCreatorDraft("fan-import", "a fan import", text.trim().length > 0, submitting || pending || checking);

  const parsed = useMemo(() => parseCsv(text), [text]);

  async function submit() {
    if (parsed.rows.length === 0 || pending || checking || submitting) return;
    setSubmitting(true);
    try {
      const rows = parsed.rows.map(row => ({ name: row.name, spins: row.spins, amountCents: row.amountCents, campaignId: campaignId || undefined }));
      const outcome = await submitFanImport(window.sessionStorage, "current", rows, body => fetch("/api/fans/import", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      }));
      if (outcome.status !== "confirmed") {
        setPending(true);
        toast("Import could not be confirmed. Retry these same rows before starting another import.", { tone: "error" });
        return;
      }
      toast(outcome.replayed ? `Import recovered: ${outcome.created} fan links, ${outcome.failed} failed` : `${outcome.created} created, ${outcome.failed} failed`, { tone: outcome.failed > 0 ? "info" : "success" });
      setPending(false);
      setText("");
      onClose();
      onImported();
    } catch {
      setPending(true);
      toast("Import could not be confirmed. Retry these same rows before starting another import.", { tone: "error" });
    } finally {
      setSubmitting(false);
    }
  }

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setText(String(reader.result ?? ""));
    reader.readAsText(file);
    e.target.value = "";
  }

  return (
    <section
      aria-label="Bulk import fans"
      className="lift-in rounded-2xl border border-[var(--hair)] p-4 shadow-[var(--lift)] [background:var(--s1)] sm:p-5"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="flex items-center gap-[9px] text-[15px] font-bold text-ink">
            <span aria-hidden="true" className="h-4 w-[3px] shrink-0 rounded-sm bg-[var(--brand)]" />
            Import fans
          </h3>
          <p className="mt-1 text-[13px] text-muted">
            Columns: <code className="text-ink">name, spins, amount</code> (amount in
            dollars, optional). Header row optional. Up to {MAX_ROWS} rows.
          </p>
        </div>
        <button
          type="button"
          onClick={() => leave(onClose, { scope: "fan-import", consequence: "Closing the import discards its unsent rows." })}
          className="min-h-9 shrink-0 rounded-[9px] border border-line px-3 text-xs font-semibold text-muted transition-colors hover:text-ink"
        >
          Close
        </button>
      </div>

      <textarea
        className="ff-input mt-3 h-32 w-full font-mono text-sm"
        aria-label="CSV rows"
        placeholder={"@bigfan, 5, 25\n@superfan, 3\nJamie, 10, 100"}
        value={text}
        disabled={submitting || pending || checking}
        onChange={(e) => setText(e.target.value)}
      />

      <div className="mt-2 flex flex-wrap items-center gap-3">
        <label className="text-xs font-semibold text-muted">
          <span className="inline-flex min-h-8 cursor-pointer items-center rounded-[9px] border border-line px-3 transition-colors hover:text-ink">
            Choose .csv file
          </span>
          <input type="file" accept=".csv" disabled={submitting || pending || checking} onChange={onFile} className="sr-only" />
        </label>
        <span className="tnum text-xs text-muted">
          {parsed.rows.length} valid row{parsed.rows.length === 1 ? "" : "s"}
          {parsed.skippedHeader ? " · header skipped" : ""}
        </span>
      </div>

      {parsed.warnings.length > 0 && (
        <ul className="mt-3 space-y-1 rounded-[10px] bg-[#f59e0b]/15 p-3 text-xs text-[#fcd34d]">
          {parsed.warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      )}

      {parsed.rows.length > 0 && (
        <div className="mt-3 max-h-64 overflow-auto rounded-[10px] border border-[var(--hair)] [background:var(--s2)]">
          <table className="w-full text-left text-sm">
            <thead className="sticky top-0 text-[11px] uppercase tracking-[0.04em] text-muted [background:var(--s2)]">
              <tr>
                <th className="px-3 py-2 font-semibold">Name</th>
                <th className="px-3 py-2 text-right font-semibold">Spins</th>
                <th className="px-3 py-2 text-right font-semibold">Amount</th>
              </tr>
            </thead>
            <tbody>
              {parsed.rows.map((r, i) => (
                <tr key={i} className="border-t border-[var(--hair)]">
                  <td className="truncate px-3 py-1.5 text-ink">{r.name}</td>
                  <td className="tnum px-3 py-1.5 text-right text-ink">{r.spins}</td>
                  <td className="tnum px-3 py-1.5 text-right text-muted">
                    {r.amountCents != null
                      ? `$${(r.amountCents / 100).toFixed(2)}`
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <CreatorRequestRecovery scope="fan-import:current" kind="import" guardScope="fan-import" refreshKey={submitting} disabled={submitting} onFound={() => setPending(true)} onBusyChange={setChecking} onResolved={(status) => {
        setPending(false);
        if (status === "committed" || status === "gone") {
          setText("");
          onImported();
          toast(status === "committed" ? "The previous import completed. The fan list has been refreshed." : "The previous result was removed. It will not be recreated.", { tone: "info" });
        }
      }} />

      <button
        type="button"
        onClick={submit}
        disabled={submitting || pending || checking || parsed.rows.length === 0}
        className="btn-brand mt-3 min-h-10 rounded-[10px] px-[18px] text-sm font-bold disabled:opacity-50"
      >
        {submitting
          ? "Importing…"
          : `Create ${parsed.rows.length} fan${parsed.rows.length === 1 ? "" : "s"}`}
      </button>
    </section>
  );
}
