"use client";

import { useMemo, useState } from "react";
import { useToast } from "@/components/ui/Toast";

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

export default function ImportFans({
  campaignId,
  onImported,
}: {
  campaignId?: string;
  onImported: () => void;
}) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const parsed = useMemo(() => parseCsv(text), [text]);

  async function submit() {
    if (parsed.rows.length === 0) return;
    setSubmitting(true);
    try {
      const res = await fetch("/api/fans/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rows: parsed.rows.map((r) => ({
            name: r.name,
            spins: r.spins,
            amountCents: r.amountCents,
            campaignId: campaignId || undefined,
          })),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast(
          data.error === "too_many_rows"
            ? `Too many rows (max ${MAX_ROWS}).`
            : "Import failed. Are you signed in?",
          { tone: "error" }
        );
        return;
      }
      const { created = 0, failed = 0 } = data as { created: number; failed: number };
      toast(`${created} created, ${failed} failed`, {
        tone: failed > 0 ? "info" : "success",
      });
      setText("");
      setOpen(false);
      onImported();
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

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-lg border border-line px-3 py-1.5 text-xs font-semibold text-muted transition hover:text-ink"
      >
        Import CSV
      </button>
    );
  }

  return (
    <div className="card mt-2 rounded-xl border border-line p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h4 className="font-bold text-ink">Bulk import fans</h4>
          <p className="mt-1 text-xs text-muted">
            Columns: <code className="text-ink">name, spins, amount</code> (amount in
            dollars, optional). Header row optional. Up to {MAX_ROWS} rows.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-lg border border-line px-3 py-1.5 text-xs font-semibold text-muted transition hover:text-ink"
        >
          Close
        </button>
      </div>

      <textarea
        className="ff-input mt-3 h-32 w-full font-mono text-sm"
        placeholder={"@bigfan, 5, 25\n@superfan, 3\nJamie, 10, 100"}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />

      <div className="mt-2 flex flex-wrap items-center gap-3">
        <label className="text-xs font-semibold text-muted">
          <span className="cursor-pointer rounded-lg border border-line px-3 py-1.5 transition hover:text-ink">
            Choose .csv file
          </span>
          <input type="file" accept=".csv" onChange={onFile} className="hidden" />
        </label>
        <span className="text-xs text-muted">
          {parsed.rows.length} valid row{parsed.rows.length === 1 ? "" : "s"}
          {parsed.skippedHeader ? " · header skipped" : ""}
        </span>
      </div>

      {parsed.warnings.length > 0 && (
        <ul className="mt-3 space-y-1 rounded-lg bg-amber-500/10 p-3 text-xs text-amber-300">
          {parsed.warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      )}

      {parsed.rows.length > 0 && (
        <div className="mt-3 max-h-64 overflow-auto rounded-lg border border-line">
          <table className="w-full text-left text-sm">
            <thead className="sticky top-0 bg-surface text-xs text-muted">
              <tr>
                <th className="px-3 py-2 font-semibold">Name</th>
                <th className="px-3 py-2 text-right font-semibold">Spins</th>
                <th className="px-3 py-2 text-right font-semibold">Amount</th>
              </tr>
            </thead>
            <tbody>
              {parsed.rows.map((r, i) => (
                <tr key={i} className="border-t border-line">
                  <td className="truncate px-3 py-1.5 text-ink">{r.name}</td>
                  <td className="px-3 py-1.5 text-right tnum text-ink">{r.spins}</td>
                  <td className="px-3 py-1.5 text-right tnum text-muted">
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

      <button
        type="button"
        onClick={submit}
        disabled={submitting || parsed.rows.length === 0}
        className="btn-brand mt-3 rounded-lg px-5 py-2 text-sm font-bold disabled:opacity-50"
      >
        {submitting
          ? "Importing…"
          : `Create ${parsed.rows.length} fan${parsed.rows.length === 1 ? "" : "s"}`}
      </button>
    </div>
  );
}
