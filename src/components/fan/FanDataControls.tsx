"use client";

import { useId, useState } from "react";
import { FAN_DELETE_PHRASE } from "@/lib/privacy/config";
import { fanDataErrorMessage } from "@/lib/privacy/messages";
import { exportDownloadWarning } from "@/lib/privacy/exportRecords";
import { copyToClipboard } from "@/lib/hooks/useClipboard";
import { clearFanStorage } from "./fanStorage";
import { detectInAppBrowser } from "./inAppBrowser";

/**
 * A fan's own privacy controls: "Download my data" and "Delete my data". The
 * fan link's token is the only credential; the server pins everything to the
 * fan it resolves to (src/lib/data/privacy.ts). Used inside the Safety &
 * privacy menu and on the "this link isn't active" page.
 */

/** The fan's export as text, ready to save or show. */
export interface FanDataFile { name: string; text: string; warning: string | null }

/** Ask the server for this fan's export. */
export async function fetchFanData(token: string): Promise<FanDataFile | { error: string }> {
  try {
    const res = await fetch("/api/fan-data/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
      cache: "no-store",
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      return { error: fanDataErrorMessage(d.error, "export") };
    }
    const text = await res.text();
    const name =
      /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ?? "fanfunnel-my-data.json";
    return { name, text, warning: exportDownloadWarning(JSON.parse(text)) };
  } catch {
    return { error: fanDataErrorMessage(undefined, "export") };
  }
}

/**
 * FD-7: whether this browser can't start a file download from the page. An
 * app's built-in browser (Instagram, TikTok, X…) silently drops blob
 * downloads, and a browser without the download attribute navigates instead.
 */
export function fanDataNeedsInline(
  userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent,
  supportsDownload = typeof document !== "undefined" && "download" in document.createElement("a"),
): boolean {
  return detectInAppBrowser(userAgent) !== null || !supportsDownload;
}

/** Ask the server for this fan's export and save it as a file. */
export async function downloadFanData(token: string): Promise<{ ok: true } | { error: string }> {
  const file = await fetchFanData(token);
  if ("error" in file) return file;
  try {
    const url = URL.createObjectURL(new Blob([file.text], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return file.warning ? { error: file.warning } : { ok: true };
  } catch {
    return { error: fanDataErrorMessage(undefined, "export") };
  }
}

/**
 * FD-7: where a download can't start, the export is shown on the page instead:
 * open it in a new tab, copy it, or read it here. Nothing claims a download.
 */
export function FanDataInline({ file, onBack }: { file: FanDataFile; onBack?: () => void }) {
  const [copied, setCopied] = useState<boolean | null>(null);
  const areaId = useId();
  const openTab = () => {
    const url = URL.createObjectURL(new Blob([file.text], { type: "application/json" }));
    window.open(url, "_blank", "noopener");
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };
  return (
    <div data-testid="fan-data-inline" className="text-left">
      <p className="text-sm font-bold text-ink">Your data</p>
      <p className="mt-2 text-sm text-muted text-pretty">
        This browser can&rsquo;t save files, so your data is shown here. Open it in a new tab or copy it. To save it as a
        file, open this link in Safari or Chrome.
      </p>
      {file.warning && <p role="alert" className="mt-2 text-xs text-amber-300">{file.warning}</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" onClick={openTab} data-testid="fan-data-open"
          className="btn-brand min-h-11 rounded-xl px-4 text-sm font-bold">Open in a new tab</button>
        <button type="button" data-testid="fan-data-copy"
          onClick={async () => setCopied(await copyToClipboard(file.text))}
          className="min-h-11 rounded-xl border border-line px-4 text-sm font-semibold text-ink">{copied ? "Copied" : "Copy"}</button>
      </div>
      <p role="status" className="mt-1 text-xs text-muted">{copied === false ? "Couldn't copy automatically. Select the text below and copy it." : ""}</p>
      <label htmlFor={areaId} className="mt-2 block text-xs font-semibold text-ink">{file.name}</label>
      <textarea id={areaId} readOnly value={file.text} rows={8}
        className="ff-input mt-1 w-full font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
      {onBack && (
        <button type="button" onClick={onBack} className="mt-2 w-full text-center text-xs text-muted hover:text-ink">
          Back
        </button>
      )}
    </div>
  );
}

/** The confirm step of "Delete my data": what happens, a typed word, the button. */
export function FanDeleteFlow({
  token,
  onBack,
  onDeleted,
}: {
  token: string;
  onBack?: () => void;
  onDeleted: () => void;
}) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();
  const errId = useId();
  const ready = typed.trim().toUpperCase() === FAN_DELETE_PHRASE;

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/fan-data/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, confirm: typed.trim() }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setError(fanDataErrorMessage(d.error, "delete"));
        return;
      }
      // The server is done; nothing about this link stays in the browser either.
      await clearFanStorage(token);
      onDeleted();
    } catch {
      setError(fanDataErrorMessage(undefined, "delete"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <p className="text-sm font-bold text-ink">Delete my data?</p>
      <p className="mt-2 text-sm text-muted">This permanently deletes, for this creator:</p>
      <ul className="mt-1.5 list-disc space-y-1 pl-5 text-left text-sm text-muted">
        <li>your name, handle and profile;</li>
        <li>all your links to this creator (this one stops working) and any spins you have left;</li>
        <li>your chat messages, wishlist and referrals.</li>
      </ul>
      <p className="mt-2 text-sm text-muted">
        Your past spins stay in the creator&rsquo;s records without your name, so their prize
        counts and fairness proofs stay correct. A prize you won but haven&rsquo;t received yet
        can&rsquo;t be matched to you any more. This can&rsquo;t be undone, so download your data
        first if you want a copy.
      </p>
      <label htmlFor={inputId} className="mt-3 block text-xs font-semibold text-ink">
        Type {FAN_DELETE_PHRASE} to confirm
      </label>
      <input
        id={inputId}
        className="ff-input mt-1 w-full"
        autoComplete="off"
        spellCheck={false}
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        aria-describedby={error ? errId : undefined}
        aria-invalid={error ? true : undefined}
      />
      <button
        type="button"
        onClick={run}
        disabled={!ready || busy}
        className="mt-4 w-full rounded-xl border border-[#ef4444] py-2.5 text-sm font-bold text-[#f87171] transition hover:bg-[#ef4444]/10 disabled:opacity-50"
      >
        {busy ? "Deleting…" : "Delete my data permanently"}
      </button>
      {error && (
        <p id={errId} role="alert" className="mt-2 text-center text-xs text-amber-300">
          {error}
        </p>
      )}
      {onBack && (
        <button type="button" onClick={onBack} className="mt-2 w-full text-center text-xs text-muted hover:text-ink">
          Back
        </button>
      )}
    </div>
  );
}

export const FAN_DELETED_CONFIRMATION =
  "Your data was deleted. This link no longer works. If you want to play again, ask the creator for a new link.";

/** Both actions as plain buttons, for the "link isn't active" page. */
export function FanDataActions({ token }: { token: string }) {
  const [mode, setMode] = useState<"idle" | "delete" | "done">("idle");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [inline, setInline] = useState<FanDataFile | null>(null);

  if (mode === "done") {
    return (
      <p role="status" className="text-sm text-ink">
        {FAN_DELETED_CONFIRMATION}
      </p>
    );
  }
  if (inline) return <FanDataInline file={inline} onBack={() => setInline(null)} />;
  if (mode === "delete") {
    return <FanDeleteFlow token={token} onBack={() => setMode("idle")} onDeleted={() => setMode("done")} />;
  }
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          if (fanDataNeedsInline()) {
            const file = await fetchFanData(token);
            if ("error" in file) setNote(file.error); else setInline(file);
          } else {
            const r = await downloadFanData(token);
            setNote("error" in r ? r.error : "Your data is downloading.");
          }
          setBusy(false);
        }}
        className="w-full rounded-xl border border-line px-4 py-2.5 text-sm font-semibold text-ink transition hover:border-[var(--brand-ui)] disabled:opacity-50"
      >
        {busy ? "Preparing…" : "Download my data"}
      </button>
      <button
        type="button"
        onClick={() => setMode("delete")}
        className="w-full rounded-xl border border-line px-4 py-2.5 text-sm font-semibold text-ink transition hover:border-[#ef4444]"
      >
        Delete my data
      </button>
      {note && (
        <p role="status" className="text-center text-xs text-muted">
          {note}
        </p>
      )}
    </div>
  );
}
