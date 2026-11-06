"use client";

import { useEffect, useRef, useState } from "react";
import type { Grant } from "@/lib/data/types";
import { formatCents } from "@/lib/format";
import { Field } from "./ui";
import { useToast } from "@/components/ui/Toast";
import { useCreatorDraft } from "./CreatorDrafts";
import CreatorRequestRecovery from "./CreatorRequestRecovery";
import { grantImpact, grantPriceError, revenueChangeText } from "./grantImpact";
import { buildGrantEditPatch, grantEditFields, grantEditScope, rebaseGrantEditFields, submitGrantEdit, type GrantEditPatch } from "./grantEditIntent";

const well = "rounded-[10px] border border-[var(--hair)] [background:var(--s2)]";
const secondary = "min-h-9 rounded-[9px] border border-line px-3 text-xs font-semibold text-muted transition-colors hover:text-ink disabled:opacity-50";
export default function GrantEditRow({ g, draftScope, fanSpinsRemaining, campaigns, onSaved }: { g: Grant; draftScope: string; fanSpinsRemaining: number; campaigns: { id: string; name: string }[]; onSaved: () => Promise<Grant | null> }) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [baseline, setBaseline] = useState(g);
  const [fields, setFields] = useState(() => grantEditFields(g));
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [uncertain, setUncertain] = useState(false);
  const [refreshRequired, setRefreshRequired] = useState(false);
  const [error, setError] = useState("");
  const [pendingPatch, setPendingPatch] = useState<GrantEditPatch | null>(null);
  const markBusy = (next: boolean) => { busyRef.current = next; setBusy(next); };
  const patch = buildGrantEditPatch(baseline, fields);
  const dirty = Object.keys(patch).length > 0;
  const changedOnServer = g.spins !== baseline.spins || g.amountCents !== baseline.amountCents || g.campaignId !== baseline.campaignId;
  useCreatorDraft(draftScope, "fan notes or grant edits", editing && dirty, busy || uncertain);
  useEffect(() => {
    if (editing || uncertain || refreshRequired) return;
    /* eslint-disable react-hooks/set-state-in-effect -- mirror authoritative grant terms into the idle editor only */
    setBaseline(g); setFields(grantEditFields(g));
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [g, editing, uncertain, refreshRequired]);
  const impact = grantImpact({ grantSpins: baseline.spins, spinsInput: fields.spins, fanSpinsRemaining, passSpinsRemaining: baseline.editPass ? baseline.editPass.spinsRemaining : null, wheelTitle: baseline.editPass?.wheelTitle });
  const priceError = grantPriceError({ grant: baseline, spinsInput: fields.spins, perSpinInput: fields.perSpin });
  const revenueLine = revenueChangeText(baseline.amountCents, patch.amountCents ?? baseline.amountCents);
  const canSave = impact.allowed && !priceError && dirty && !changedOnServer && !refreshRequired;
  const previewId = `grant-impact-${g.id}`;
  const priceErrorId = `grant-price-error-${g.id}`;

  async function refreshCurrent(preserveDraft: boolean) {
    const current = await onSaved();
    if (!current) throw new Error("grant_unavailable");
    setFields(preserveDraft ? rebaseGrantEditFields(baseline, current, fields) : grantEditFields(current)); setBaseline(current);
    setRefreshRequired(false);
    return current;
  }
  async function review() {
    if (busyRef.current || uncertain) return;
    markBusy(true); setError("");
    try { await refreshCurrent(true); }
    catch { setRefreshRequired(true); setError("The latest saved grant couldn't load. Review it successfully before sending a new edit."); }
    finally { markBusy(false); }
  }
  async function save() {
    if (busyRef.current || refreshRequired || (uncertain ? !pendingPatch : !canSave)) return;
    markBusy(true); setError("");
    const intent = pendingPatch ?? { ...patch };
    setPendingPatch(intent);
    let confirmed = false;
    try {
      const outcome = await submitGrantEdit(window.sessionStorage, g.id, intent, (body) => fetch(`/api/grants/${encodeURIComponent(g.id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
      if (outcome.status === "not_sent") {
        if (outcome.reason === "intent_pending") { setPendingPatch(null); setUncertain(true); setError("An earlier edit still needs checking. Use Check outcome or cancel the uncompleted request before changing these details."); }
        else { setPendingPatch(null); setError(outcome.reason === "invalid_patch" ? "Review the spin count, price and campaign before saving." : "No edit was sent because this browser couldn't save a safe retry receipt. Allow session storage and try again."); }
        return;
      }
      if (outcome.status === "pending") { setUncertain(true); setError(`${outcome.error === "insufficient_spins" ? "The server couldn't accept this spin count. " : ""}The edit outcome is unconfirmed. Keep this exact selection and check it again, or use the verified outcome/cancellation controls below.`); return; }
      confirmed = true;
      setPendingPatch(null); setUncertain(false);
      setRefreshRequired(true);
      await refreshCurrent(false);
      setEditing(false);
      toast(outcome.replayed ? "The earlier edit was already recorded. Latest saved terms refreshed." : "Grant updated", { tone: "success" });
    } catch {
      if (!confirmed) setPendingPatch(null);
      setError(confirmed ? "The edit was confirmed, but the latest saved terms couldn't load. Refresh those terms before making another edit." : "No edit could be sent safely. Restore browser session storage before trying again.");
    }
    finally { markBusy(false); }
  }
  const recovery = <CreatorRequestRecovery scope={grantEditScope(g.id)} guardScope={draftScope} kind="edit" refreshKey={busy} disabled={busy} onFound={() => { setUncertain(true); setEditing(true); }} onBusyChange={markBusy} onResolved={async (status) => {
    setPendingPatch(null); setUncertain(false); setRefreshRequired(true); setError("");
    await refreshCurrent(status === "cancelled" || status === "rejected");
    if (status === "committed" || status === "gone") setEditing(false);
  }} />;
  if (!editing) return <li className={`space-y-2 px-[13px] py-[9px] ${well}`}><div className="flex items-center gap-2.5"><span className="tnum shrink-0 text-sm font-bold text-ink">+{g.spins}</span><span className="min-w-0 flex-1 truncate text-[13px] text-muted"><span className="tnum font-semibold text-ink">{formatCents(g.amountCents)}</span> · {g.campaignName ?? "No campaign"}</span><button type="button" disabled={busy || refreshRequired} onClick={() => { setBaseline(g); setFields(grantEditFields(g)); setEditing(true); setError(""); }} className="inline-flex min-h-8 shrink-0 items-center rounded-[7px] border border-line px-[9px] text-[11.5px] font-semibold text-muted disabled:opacity-50">Edit</button></div>{error && <p role="alert" className="text-xs text-amber-200">{error}</p>}{refreshRequired && <button type="button" disabled={busy} onClick={() => void review()} className={secondary}>Refresh saved terms</button>}{recovery}</li>;
  return <li data-testid="grant-edit-form" className="space-y-2 rounded-[10px] border border-[color-mix(in_oklab,var(--brand)_40%,transparent)] px-3 py-3 [background:var(--s2)]">
    <fieldset disabled={busy || uncertain || refreshRequired} className="grid grid-cols-2 gap-2"><legend className="sr-only">Edit this grant</legend><Field label="Spins"><input type="number" min={0} value={fields.spins} onChange={(event) => setFields({ ...fields, spins: event.target.value })} aria-invalid={!impact.allowed || undefined} className="ff-input tnum w-full" /></Field><Field label="$ / spin"><input type="number" min={0} step={0.01} value={fields.perSpin} onChange={(event) => setFields({ ...fields, perSpin: event.target.value })} placeholder="0.00" aria-invalid={!!priceError || undefined} aria-errormessage={priceError ? priceErrorId : undefined} className="ff-input tnum w-full" /></Field><div className="col-span-2"><Field label="Campaign"><select value={fields.campaignId} onChange={(event) => setFields({ ...fields, campaignId: event.target.value })} className="ff-input w-full"><option value="">No campaign (untracked)</option>{campaigns.map((campaign) => <option key={campaign.id} value={campaign.id}>{campaign.name}</option>)}</select></Field></div></fieldset>
    {priceError && <p id={priceErrorId} role="alert" className="text-xs font-semibold text-[#f87171]">{priceError}</p>}
    <p id={previewId} role="status" className={`text-xs text-pretty ${impact.allowed ? "text-muted" : "font-semibold text-[#f87171]"}`}>{impact.message}{impact.allowed && !priceError && revenueLine && <> {revenueLine}</>}</p>
    {error && <p role="alert" className="text-xs text-amber-200">{error}</p>}
    {changedOnServer && !uncertain && <p role="status" className="text-xs text-amber-200">The saved grant changed while this form was open. Review the latest saved terms before sending your edit; your changed fields stay in the draft.</p>}
    <div className="flex flex-wrap gap-2"><button type="button" data-testid="grant-edit-save" onClick={() => void save()} disabled={busy || refreshRequired || (uncertain ? !pendingPatch : !canSave)} className="btn-brand min-h-9 rounded-[9px] px-3 text-xs font-bold disabled:opacity-50">{busy ? "Checking…" : uncertain ? "Check this edit again" : "Save"}</button><button type="button" disabled={busy || uncertain} onClick={() => { setEditing(false); setFields(grantEditFields(g)); setBaseline(g); }} className={secondary}>{dirty ? "Discard edits" : "Cancel"}</button>{(changedOnServer || refreshRequired) && <button type="button" disabled={busy || uncertain} onClick={() => void review()} className={secondary}>Refresh saved terms</button>}</div>
    {uncertain && !pendingPatch && <p className="text-xs text-muted">The earlier edit is saved as an opaque receipt. Check its outcome or cancel it below; you do not need to re-enter private details.</p>}
    {recovery}
  </li>;
}
