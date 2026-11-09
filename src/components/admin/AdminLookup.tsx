"use client";

import { useId, useState, type FormEvent } from "react";
import { btnGhost, raised, SectionTitle } from "./adminUi";

// OPS-04: Admin › "Look up a win". Paste the verify link (or share id) a fan
// sends with a complaint; POST /api/admin/lookup answers with the win's facts
// (audited as admin.lookup). Read-only: nothing here changes a win.
interface Win {
  shareId: string;
  at: string;
  prize: string;
  rarity: string;
  gameKind: string;
  kind: string;
  creator: { id: string | null; title: string | null; status: string | null };
  redemption: { status: string; createdAt: string; fulfilledAt: string | null } | null;
  fanDeleted: boolean;
}

const when = (iso: string | null | undefined) => (iso && Number.isFinite(Date.parse(iso)) ? new Date(iso).toLocaleString() : "—");
const ERRORS: Record<string, string> = {
  invalid_reference: "That doesn't look like a verify link or share id. Paste the whole /verify/… link.",
  not_found: "No win has that link. Check it was copied in full.",
  lookup_failed: "The lookup could not complete. Try again in a moment.",
  rate_limited: "Too many lookups. Wait a minute and try again.",
  mfa_required: "Sign in with two-factor authentication to look up wins.",
};

export default function AdminLookup() {
  const id = useId();
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [win, setWin] = useState<Win | null>(null);
  const [message, setMessage] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !query.trim()) return;
    setBusy(true);
    setMessage("");
    setWin(null);
    try {
      const res = await fetch("/api/admin/lookup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: query.trim() }) });
      const body = (await res.json().catch(() => ({}))) as { win?: Win; error?: string };
      if (res.ok && body.win) setWin(body.win);
      else setMessage(ERRORS[body.error ?? ""] ?? "The lookup could not complete. Try again in a moment.");
    } catch {
      setMessage("The lookup could not complete. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby={`${id}-title`} className={`${raised} overflow-hidden rounded-xl`}>
      <SectionTitle id={`${id}-title`}>Look up a win</SectionTitle>
      <div className="space-y-4 p-4 text-sm text-ink sm:p-[18px]">
        <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
          <label className="flex min-w-[14rem] flex-1 flex-col gap-1 text-xs text-muted">
            Verify link or share id
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              maxLength={512}
              autoComplete="off"
              spellCheck={false}
              placeholder="https://…/verify/…"
              className="rounded-lg border border-[var(--hair)] bg-transparent px-3 py-2 text-[13px] text-ink"
            />
          </label>
          <button type="submit" className={btnGhost} disabled={busy || !query.trim()}>{busy ? "Looking up…" : "Look up"}</button>
        </form>
        <p className="text-xs text-muted">Read-only. Each lookup is recorded in Activity. Fan names and links are never shown.</p>
        <p role="status" aria-live="polite">{message}</p>
        {win && (
          <dl data-testid="admin-lookup-result" className="grid gap-x-4 gap-y-1 text-[13px] sm:grid-cols-[max-content_1fr]">
            <dt className="font-semibold text-muted">Prize</dt><dd>{win.prize} <span className="text-muted">({win.rarity}, {win.gameKind}{win.kind === "bonus" ? ", bonus" : ""})</span></dd>
            <dt className="font-semibold text-muted">Won</dt><dd>{when(win.at)}</dd>
            <dt className="font-semibold text-muted">Creator</dt><dd>{win.creator.title ?? "Unnamed creator"}{win.creator.status && win.creator.status !== "approved" && win.creator.status !== "active" ? <span className="text-muted"> ({win.creator.status})</span> : null}</dd>
            <dt className="font-semibold text-muted">Delivery</dt>
            <dd data-testid="admin-lookup-delivery">{win.redemption ? `${win.redemption.status} · recorded ${when(win.redemption.createdAt)}${win.redemption.fulfilledAt ? ` · delivered ${when(win.redemption.fulfilledAt)}` : ""}` : "No delivery record (an instant reward or an older win)"}</dd>
            <dt className="font-semibold text-muted">Fan data</dt><dd>{win.fanDeleted ? "The fan deleted their data. The win is kept, anonymized." : "Kept (the fan has not deleted it)"}</dd>
          </dl>
        )}
      </div>
    </section>
  );
}
