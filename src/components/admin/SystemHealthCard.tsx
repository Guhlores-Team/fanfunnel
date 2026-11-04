"use client";

import { useCallback, useEffect, useId, useState } from "react";
import { canaryMessage, initializationMessage, ledgerMessage, parseSystemHealthStatus, rateLimitStoreMessage, type SystemHealthStatus } from "./systemHealthCopy";
import { btnGhost, raised, SectionTitle } from "./adminUi";

const date = (value: string | null | undefined) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : "Not recorded";

export default function SystemHealthCard() {
  const id = useId();
  const [health, setHealth] = useState<SystemHealthStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [backedUp, setBackedUp] = useState(false);
  const [message, setMessage] = useState("");
  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/admin/system-health", { cache: "no-store" });
      const result = parseSystemHealthStatus(await response.json());
      if (!result || (!response.ok && response.status !== 503)) throw new Error();
      setHealth(result);
    } catch { setMessage("System health could not be loaded. Sign in with two-factor authentication and try again."); }
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async fetch; state changes only after the response arrives
    void load();
  }, [load]);
  async function act(action: "run-checks" | "initialize-canary") {
    if (busy) return;
    setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/admin/system-health", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, ...(action === "initialize-canary" ? { keysBackedUp: backedUp } : {}) }) });
      const result = await response.json();
      setMessage(action === "initialize-canary" ? initializationMessage(result.outcome) : response.ok ? "Checks completed. Review the results below." : "Checks need attention or could not complete. Review the results and Errors section below.");
      await load();
    } catch { setMessage("The request could not complete. Refresh the status before trying again."); }
    finally { setBusy(false); }
  }
  const missing = health?.canary.status === "missing";
  return (
    <section aria-labelledby={`${id}-title`} className={`${raised} overflow-hidden rounded-xl`}>
      <SectionTitle id={`${id}-title`}>System health</SectionTitle>
      <div className="space-y-4 p-4 text-sm text-ink sm:p-[18px]">
        <p>{health ? canaryMessage(health.canary.status) : "Loading system health…"}</p>
        {health && !health.demo && <>
          <p>{ledgerMessage(health.summary)}</p>
          {rateLimitStoreMessage(health.rateLimitStore) && <p>{rateLimitStoreMessage(health.rateLimitStore)}</p>}
          {health.summary?.canaryFailureAt && <p>A previous key protection failure still needs acknowledgement. Restore the original configuration, then run checks successfully to clear it.</p>}
          <dl className="grid gap-1 text-xs text-muted">
            <div><dt className="inline font-semibold">Inventory checks: </dt><dd className="inline">{date(health.summary?.invariantsCheckedAt)}</dd></div>
            <div><dt className="inline font-semibold">Last authenticated maintenance: </dt><dd className="inline">{date(health.summary?.lastMaintenanceAt)}</dd></div>
          </dl>
          {health.summary && Object.values(health.summary.invariantCounts).some(count => Number(count) > 0) && <p>Mismatches found: {Object.values(health.summary.invariantCounts).reduce<number>((total, count) => total + Number(count), 0)}. Your operator can review the redacted check counts.</p>}
          <p className="text-xs text-muted">A recorded maintenance run does not confirm that daily scheduling or email alerts are configured. Check Errors for redacted alerts.</p>
          {missing && <div className="space-y-3">
            <p>Before initializing, have your operator securely back up the encryption key, its version and the stable fingerprint key. Never paste keys or reward codes into this page or a chat.</p>
            <label className="flex items-start gap-2"><input type="checkbox" checked={backedUp} onChange={event => setBackedUp(event.target.checked)} disabled={busy} className="mt-1" /><span>I have securely backed up both reward keys and the encryption key version.</span></label>
            <button className={btnGhost} disabled={busy || !backedUp} onClick={() => void act("initialize-canary")}>Initialize reward key protection</button>
          </div>}
          <button className={btnGhost} disabled={busy} onClick={() => void act("run-checks")}>{busy ? "Checking…" : "Run checks now"}</button>
        </>}
        <button className={`${btnGhost} ml-2`} disabled={busy} onClick={() => { setMessage(""); void load(); }}>Refresh status</button>
        <p role="status" aria-live="polite">{message}</p>
      </div>
    </section>
  );
}
