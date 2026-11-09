"use client";

import { useCallback, useEffect, useId, useState } from "react";
import { useRouter } from "next/navigation";
import CreatorMfaRecovery from "@/components/auth/CreatorMfaRecovery";
import type { CreatorOverview, FanAccountSummary } from "@/lib/data/types";
import { useToast } from "@/components/ui/Toast";
import { loadJson } from "@/lib/hooks/loadJson";
import LoadFailed from "./LoadFailed";
import { owedSentence, owedSummary } from "./owedSummary";
import { useCreatorDraft } from "./CreatorDrafts";

const raised = "border border-[var(--hair)] [background:var(--s1)] shadow-[var(--lift)]";
const secondaryBtn =
  "inline-flex min-h-10 items-center justify-center gap-1.5 rounded-[10px] border border-line px-4 text-sm font-semibold text-ink transition-colors hover:border-[var(--brand)]/60 hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-50";
const dangerBtn =
  "inline-flex min-h-10 items-center justify-center gap-1.5 rounded-[10px] bg-[#dc2626] px-4 text-sm font-bold text-white transition-colors hover:bg-[#ef4444] disabled:cursor-not-allowed disabled:opacity-40";
const ALERT = "M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z";

type Owed = { state: "loading" } | { state: "ok"; sentence: string } | { state: "failed"; error: unknown };

/**
 * "Clear all data" (C4 + C20): lives in Settings › Your data beside "Close my
 * account" (it used to sit in Boosts). Before the RESET word it says what fans
 * are still owed, so a wipe is never a surprise. RESET + MFA as before.
 */
export default function ClearDataCard() {
  const toast = useToast();
  const router = useRouter();
  const titleId = useId();
  const owedId = useId();
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [mfaRequired, setMfaRequired] = useState(false);
  const [owed, setOwed] = useState<Owed>({ state: "loading" });
  useCreatorDraft("clear-data", "the Clear all data confirmation", typed.length > 0, busy);

  const loadOwed = useCallback(async () => {
    setOwed({ state: "loading" });
    try {
      const [overview, list] = await Promise.all([
        loadJson<CreatorOverview>("/api/overview"),
        loadJson<{ fans?: FanAccountSummary[] }>("/api/fans"),
      ]);
      setOwed({ state: "ok", sentence: owedSentence(owedSummary(overview, list.fans ?? [])) });
    } catch (error) {
      setOwed({ state: "failed", error });
    }
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- read what is owed when the confirmation opens
    if (confirming) void loadOwed();
  }, [confirming, loadOwed]);

  async function reset() {
    setBusy(true);
    try {
      const res = await fetch("/api/account/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: typed }),
      });
      if (res.ok) {
        toast("Account reset — starting fresh.", { tone: "success" });
        // #9: re-run the server components to reflect the wipe instead of a
        // hard page reload. A short delay lets the toast register first.
        setTimeout(() => router.refresh(), 700);
      } else {
        const body = await res.json().catch(() => null);
        if (body?.error === "mfa_required") {
          setMfaRequired(true);
          setTyped("");
          return;
        }
        toast(res.status === 401 ? "Couldn't clear your data: you're signed out. Sign in and try again." : "Couldn't clear your data. Try again.", { tone: "error" });
      }
    } catch {
      toast("Couldn't clear your data. Check your connection and try again.", { tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby={titleId} data-testid="clear-data" className={`min-w-0 space-y-4 rounded-2xl border-[#ef4444]/40 p-5 ${raised}`}>
      <div>
        <h3 id={titleId} className="flex items-center gap-2 text-[15px] font-bold text-ink">
          <span className="text-[#f87171]">
            <svg width={17} height={17} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" className="shrink-0"><path d={ALERT} /></svg>
          </span>
          Clear all data
        </h3>
        <p className="mt-1 text-xs text-muted">
          Clear all data — games, prizes, fans, links, spins, campaigns and numbers — and start fresh, keeping your account.
          This <strong className="text-ink">cannot be undone</strong>.
        </p>
      </div>
      <CreatorMfaRecovery required={mfaRequired} destination="reset" />
      {!confirming ? (
        <button type="button" onClick={() => setConfirming(true)} className={secondaryBtn}>
          Clear all data…
        </button>
      ) : (
        <div className="flex flex-col gap-3">
          {owed.state === "loading" ? (
            <p className="text-[13px] text-muted" aria-busy="true">Checking what fans are still owed…</p>
          ) : owed.state === "failed" ? (
            <LoadFailed compact error={owed.error} what="what fans are still owed" onRetry={loadOwed} testId="clear-data-owed-failed" />
          ) : (
            <p id={owedId} data-testid="clear-data-owed" className={owed.sentence ? "rounded-xl border border-amber-400/40 bg-amber-400/5 p-3 text-[13px] text-amber-100" : "text-[13px] text-muted"}>
              {owed.sentence
                ? <>{owed.sentence} Clearing removes these too: deliver the prizes or settle the spins with those fans first.</>
                : "No fan is waiting on a prize or holding spins they paid for."}
            </p>
          )}
          <label className="flex flex-col gap-1.5 text-sm text-ink">
            <span>
              Type <strong>RESET</strong> to confirm:
            </span>
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              className="ff-input w-full sm:max-w-xs"
              placeholder="RESET"
              autoComplete="off"
              aria-describedby={owed.state === "ok" ? owedId : undefined}
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={reset} disabled={busy || typed !== "RESET" || owed.state !== "ok"} className={dangerBtn}>
              {busy ? "Clearing…" : "Permanently clear everything"}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setConfirming(false);
                setTyped("");
              }}
              className={secondaryBtn}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
