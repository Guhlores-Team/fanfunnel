"use client";

import { useEffect, useId, useState, type FormEvent } from "react";
import { LEGAL, formatLegalDate } from "@/lib/legal";
import { refreshLegalChangeNotice } from "@/components/LegalChangeNotice";
import { btnGhost, raised, SectionTitle } from "./adminUi";

// TS-06: Admin › "Terms change notice". Announce the version that will
// replace the current Terms/Privacy text and the date it takes effect.
// POST /api/admin/legal-notice stores it (set_legal_terms_notice, admin
// aal2), e-mails every active creator and is recorded in Activity. Fan pages
// and the dashboard show one line until that date. Withdraw clears it.
interface Stored {
  version: string;
  effectiveDate: string;
}
interface Mail {
  status: "sent" | "partial" | "not_configured" | "none";
  sent: number;
  failed: number;
  unsent: number;
  listFailed?: boolean;
}

const ERRORS: Record<string, string> = {
  invalid_version: "Enter the new version as a date, like 2027-01-31.",
  version_not_later: `The new version must be later than the current one (${LEGAL.version}).`,
  invalid_date: "Enter the date it takes effect, like 2027-01-31.",
  date_in_past: "The effective date can't be in the past.",
  too_soon: `A material change needs at least ${LEGAL.changeNoticeDays} days' notice. Pick a later date, or tick the box if the law or security requires it sooner.`,
  invalid_summary: "Keep the sentence for the e-mail to 280 characters or fewer.",
  invalid_notice: "The database refused that notice. Check the version and the date.",
  rate_limited: "Too many changes in a row. Wait a minute and try again.",
  mfa_required: "Sign in with two-factor authentication to change the notice.",
  forbidden: "Only an admin can change the notice.",
};

function mailLine(mail: Mail | undefined): string {
  if (!mail) return "";
  if (mail.listFailed) return " The list of creators could not be read, so no e-mail was sent: e-mail creators yourself.";
  if (mail.status === "not_configured") return " Account e-mail is not configured here, so creators were NOT e-mailed: e-mail them yourself.";
  if (mail.status === "none") return " There are no active creators to e-mail yet.";
  if (mail.status === "sent") return ` ${mail.sent} creator${mail.sent === 1 ? " was" : "s were"} e-mailed.`;
  return ` ${mail.sent} e-mailed, ${mail.failed + mail.unsent} not sent: e-mail the rest yourself.`;
}

export default function AdminLegalNotice() {
  const id = useId();
  const [stored, setStored] = useState<Stored | null>(null);
  const [loaded, setLoaded] = useState<"loading" | "ok" | "failed">("loading");
  const [version, setVersion] = useState("");
  const [effectiveDate, setEffectiveDate] = useState("");
  const [summary, setSummary] = useState("");
  const [sooner, setSooner] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    fetch("/api/admin/legal-notice", { cache: "no-store" })
      .then((res) => (res.ok ? (res.json() as Promise<{ notice: Stored | null }>) : Promise.reject(new Error("load"))))
      .then((body) => {
        if (!live) return;
        setStored(body.notice ?? null);
        setLoaded("ok");
      })
      .catch(() => {
        if (live) setLoaded("failed");
      });
    return () => {
      live = false;
    };
  }, [attempt]);

  async function send(payload: Record<string, unknown>, done: (mail?: Mail) => string) {
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      const res = await fetch("/api/admin/legal-notice", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const body = (await res.json().catch(() => ({}))) as { notice?: Stored | null; mail?: Mail; error?: string };
      if (!res.ok) {
        setMessage(ERRORS[body.error ?? ""] ?? "The notice could not be saved. Try again in a moment.");
        return;
      }
      setStored(body.notice ?? null);
      setLoaded("ok");
      setMessage(done(body.mail));
      refreshLegalChangeNotice();
    } catch {
      setMessage("The notice could not be saved. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  function announce(event: FormEvent) {
    event.preventDefault();
    void send({ version: version.trim(), effectiveDate: effectiveDate.trim(), sooner, ...(summary.trim() ? { summary: summary.trim() } : {}) }, (mail) => `Announced.${mailLine(mail)}`);
  }

  const field = "rounded-lg border border-[var(--hair)] bg-transparent px-3 py-2 text-[13px] text-ink";
  return (
    <section aria-labelledby={`${id}-title`} className={`${raised} overflow-hidden rounded-xl`}>
      <SectionTitle id={`${id}-title`}>Terms change notice</SectionTitle>
      <div className="space-y-4 p-4 text-sm text-ink sm:p-[18px]">
        <p className="text-xs text-muted">
          Before a material change to the Terms or Privacy Policy, announce it here at least {LEGAL.changeNoticeDays} days ahead. Fan pages and
          the dashboard show one line with the date until it takes effect, and every active creator is e-mailed. Current version:{" "}
          <span className="font-semibold text-ink">{LEGAL.version}</span>.
        </p>
        <p data-testid="admin-legal-notice-current">
          {loaded === "loading"
            ? "Loading the current notice…"
            : loaded === "failed"
              ? "The current notice could not be loaded."
              : stored
                ? `Announced: version ${stored.version} takes effect on ${formatLegalDate(stored.effectiveDate)}.`
                : "No change is announced."}
        </p>
        {loaded === "failed" && (
          <button type="button" className={btnGhost} onClick={() => { setLoaded("loading"); setAttempt((n) => n + 1); }}>
            Retry
          </button>
        )}
        <form onSubmit={announce} className="flex flex-wrap items-end gap-2">
          <label className="flex min-w-[10rem] flex-col gap-1 text-xs text-muted">
            New version (YYYY-MM-DD)
            <input value={version} onChange={(e) => setVersion(e.target.value)} maxLength={10} inputMode="numeric" autoComplete="off" placeholder="2027-01-31" className={field} />
          </label>
          <label className="flex min-w-[10rem] flex-col gap-1 text-xs text-muted">
            Takes effect on (YYYY-MM-DD)
            <input value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)} maxLength={10} inputMode="numeric" autoComplete="off" placeholder="2027-01-31" className={field} />
          </label>
          <label className="flex min-w-[14rem] flex-1 flex-col gap-1 text-xs text-muted">
            One sentence for the e-mail to creators (optional)
            <input value={summary} onChange={(e) => setSummary(e.target.value)} maxLength={280} autoComplete="off" className={field} />
          </label>
          <label className="flex min-h-11 w-full items-center gap-2 text-xs text-muted">
            <input type="checkbox" checked={sooner} onChange={(e) => setSooner(e.target.checked)} className="h-5 w-5" />
            Required by law or needed for security (may take effect sooner than {LEGAL.changeNoticeDays} days)
          </label>
          <button type="submit" className={btnGhost} disabled={busy || loaded !== "ok" || !version.trim() || !effectiveDate.trim()}>
            {busy ? "Saving…" : "Announce"}
          </button>
          {stored && (
            <button type="button" className={btnGhost} disabled={busy} onClick={() => void send({ clear: true }, () => "The notice was withdrawn.")}>
              Withdraw
            </button>
          )}
        </form>
        <p className="text-xs text-muted">Each change is recorded in Activity. Announcing does not change the Terms: publish the new text on the date.</p>
        <p role="status" aria-live="polite" data-testid="admin-legal-notice-status">{message}</p>
      </div>
    </section>
  );
}
