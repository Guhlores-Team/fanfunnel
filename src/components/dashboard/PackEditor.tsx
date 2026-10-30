"use client";

import { useCallback, useEffect, useState } from "react";
import type { CampaignPack } from "@/lib/data/types";
import { formatCents } from "@/lib/format";
import { useToast } from "@/components/ui/Toast";
import { addPackUnit, findMatchingPack } from "./packHelpers";
import { EmptyState, Field } from "./ui";
import { MAX_COMBINED_BOOST, MAX_FOCUS_SPINS, MIN_FOCUS_MULTIPLIER, MIN_FOCUS_SPINS } from "@/lib/focus/config";
import { packFormDraft, parsePackForm, type PackFormDraft, type PackKind } from "./focusPackForm";
import { FocusValuePicker } from "./FocusValuePreview";
import { useCreatorDraft } from "./CreatorDrafts";

const ghostBtn = "inline-flex min-h-9 items-center justify-center gap-1.5 rounded-[9px] border border-line px-3 text-[12.5px] font-semibold text-muted transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] disabled:opacity-50";
const KIND_LABEL = { spins: "Spins", focus: "Focus", chase: "Chase" };

/** Saved presets; modifier packs never inherit ordinary quantity stacking. */
export default function PackEditor({ campaignId }: { campaignId: string | null }) {
  const toast = useToast();
  const [packs, setPacks] = useState<CampaignPack[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<PackFormDraft>(() => packFormDraft());
  const [error, setError] = useState("");
  const scope = `packs:${campaignId ?? "global"}`;
  useCreatorDraft(scope, "spin-pack changes", JSON.stringify(draft) !== JSON.stringify(packFormDraft()), busy);
  const load = useCallback(async () => {
    const query = campaignId ? `?campaignId=${encodeURIComponent(campaignId)}` : "";
    const response = await fetch(`/api/campaign-packs${query}`, { cache: "no-store" });
    if (!response.ok) throw new Error();
    const data = await response.json() as { packs?: CampaignPack[] };
    setPacks(data.packs ?? []);
  }, [campaignId]);
  useEffect(() => {
    let live = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount; state is updated after the network response
    load().catch(() => { if (live) setError("Couldn't load packs. Refresh before making changes."); });
    return () => { live = false; };
  }, [load]);

  async function addPack() {
    const parsed = parsePackForm(draft);
    if ("error" in parsed) { setError(parsed.error); return; }
    if (!packs || busy) return;
    const value = parsed.value;
    const match = value.packKind === "spins" ? packs.findIndex((pack) => (pack.packKind ?? "spins") === "spins" && findMatchingPack([pack], value) === 0) : -1;
    setBusy(true); setError("");
    let saved = false;
    try {
      const response = match >= 0 ? await fetch(`/api/campaign-packs/${packs[match].id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(addPackUnit(packs[match], value)) }) : await fetch("/api/campaign-packs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ campaignId, ...value }) });
      if (!response.ok) throw new Error();
      saved = true;
      setDraft(packFormDraft());
      toast(match >= 0 ? "Pack quantity increased" : "Pack added", { tone: "success" });
      await load();
    } catch { setError(saved ? "The pack was saved, but the refreshed list couldn't load. Refresh before adding another." : "Couldn't confirm this pack's save. Your draft is still here; check the list before retrying."); }
    finally { setBusy(false); }
  }
  async function updatePack(id: string, patch: Partial<CampaignPack>) {
    if (busy) return false;
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/campaign-packs/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
      if (!response.ok) throw new Error();
      await load(); toast("Pack updated", { tone: "success" }); return true;
    } catch { setError("Couldn't update this pack. Your edits are still here."); return false; }
    finally { setBusy(false); }
  }
  async function deletePack(id: string) {
    if (busy) return;
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/campaign-packs/${id}`, { method: "DELETE" });
      if (!response.ok) throw new Error();
      await load(); toast("Pack deleted", { tone: "success" });
    } catch { setError("Couldn't delete the pack. Refresh and try again."); }
    finally { setBusy(false); }
  }
  return (
    <section data-testid="pack-editor" className="rounded-xl border border-[var(--hair)] p-4 [background:var(--s2)] sm:p-5" aria-label="Spin pack presets">
      <h3 className="text-sm font-bold text-ink">Spin packs</h3>
      <p className="mt-1 text-[13px] text-muted">Ordinary spins, a temporary Focus boost, or a Chase guarantee. Focus and Chase are granted to an existing fan after choosing their target and pass.</p>
      {error && <p role="alert" className="mt-3 text-sm text-amber-200">{error}</p>}
      <fieldset disabled={busy} className="mt-4 min-w-0">
        <legend className="sr-only">New pack</legend>
        <PackFields draft={draft} onChange={setDraft} />
        <PackEstimate draft={draft} />
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" onClick={() => void addPack()} disabled={busy || !packs} className="btn-brand min-h-10 rounded-[10px] px-4 text-sm font-bold disabled:opacity-50">{busy ? "Saving…" : "Add pack"}</button>
          {JSON.stringify(draft) !== JSON.stringify(packFormDraft()) && <button type="button" onClick={() => { setDraft(packFormDraft()); setError(""); }} className={ghostBtn}>Discard new pack</button>}
        </div>
      </fieldset>
      <div className="mt-5">
        {packs === null ? <p role="status" className="text-sm text-muted">Loading packs…</p> : packs.length === 0 ? <EmptyState title="No packs yet" body="Add a saved preset above, then grant it from a fan's details." /> : <ul className="space-y-2">{packs.map((pack) => <PackRow key={pack.id} pack={pack} busy={busy} scope={scope} onSave={(patch) => updatePack(pack.id, patch)} onDelete={() => void deletePack(pack.id)} />)}</ul>}
      </div>
    </section>
  );
}

function PackFields({ draft, onChange, editing = false }: { draft: PackFormDraft; onChange: (draft: PackFormDraft) => void; editing?: boolean }) {
  const patch = (value: Partial<PackFormDraft>) => onChange({ ...draft, ...value });
  return <>
    <div className="grid min-w-0 grid-cols-2 gap-3 sm:grid-cols-4">
      <Field label="Label"><input className="ff-input w-full min-w-0" aria-label={editing ? "Pack label" : undefined} placeholder="Starter" maxLength={60} value={draft.label} onChange={(e) => patch({ label: e.target.value })} /></Field>
      <Field label="Pack type"><select data-testid="pack-kind" className="ff-input w-full min-w-0" value={draft.kind} onChange={(e) => patch({ kind: e.target.value as PackKind })}>{(["spins", "focus", "chase"] as const).map((kind) => <option key={kind} value={kind}>{KIND_LABEL[kind]}</option>)}</select></Field>
      <Field label="Amount ($)"><input className="ff-input tnum w-full min-w-0" aria-label={editing ? "Pack amount in dollars" : undefined} type="number" min={0} step="0.01" inputMode="decimal" placeholder="5.00" value={draft.amount} onChange={(e) => patch({ amount: e.target.value })} /></Field>
      {draft.kind === "spins" ? <>
        <Field label="Spins"><input className="ff-input tnum w-full min-w-0" aria-label={editing ? "Pack spins" : undefined} type="number" min={1} step={1} inputMode="numeric" value={draft.spins} placeholder="10" onChange={(e) => patch({ spins: e.target.value })} /></Field>
        <Field label="Bonus spins"><input className="ff-input tnum w-full min-w-0" aria-label={editing ? "Pack bonus spins" : undefined} type="number" min={0} step={1} inputMode="numeric" value={draft.bonus} placeholder="0" onChange={(e) => patch({ bonus: e.target.value })} /></Field>
      </> : <>
        <Field label={draft.kind === "chase" ? "Guaranteed within (spins)" : "Focus spins"}><input data-testid="pack-duration" className="ff-input tnum w-full min-w-0" type="number" min={MIN_FOCUS_SPINS} max={MAX_FOCUS_SPINS} step={1} value={draft.duration} onChange={(e) => patch({ duration: e.target.value })} /></Field>
        {draft.kind === "focus" && <Field label="Focus multiplier"><input data-testid="pack-focus-multiplier" className="ff-input tnum w-full min-w-0" type="number" min={MIN_FOCUS_MULTIPLIER} max={MAX_COMBINED_BOOST} step="any" value={draft.multiplier} onChange={(e) => patch({ multiplier: e.target.value })} /></Field>}
      </>}
    </div>
    {draft.kind !== "spins" && <p className="mt-2 text-xs text-muted">This pack grants {draft.duration || "—"} spins, with no bonus spins. {draft.kind === "focus" ? `Focus is a chance boost, not a guarantee. The combined boost is capped at ×${MAX_COMBINED_BOOST}.` : "Chase reserves one target unit at grant. You can save the preset now; granting stays off until the creator is enabled for the TEST pilot."}</p>}
  </>;
}
function PackEstimate({ draft }: { draft: PackFormDraft }) {
  const parsed = parsePackForm(draft);
  if (draft.kind === "spins" || "error" in parsed) return null;
  return <FocusValuePicker options={{ kind: draft.kind, spins: parsed.value.spins, multiplier: parsed.value.focusMultiplier, within: parsed.value.chaseWithin, priceCents: parsed.value.amountCents }} />;
}
function PackRow({ pack, busy, scope, onSave, onDelete }: { pack: CampaignPack; busy: boolean; scope: string; onSave: (patch: Partial<CampaignPack>) => Promise<boolean>; onDelete: () => void }) {
  const [editing, setEditing] = useState(false), [confirmDelete, setConfirmDelete] = useState(false);
  const [draft, setDraft] = useState(() => packFormDraft(pack));
  const [error, setError] = useState("");
  const dirty = editing && JSON.stringify(draft) !== JSON.stringify(packFormDraft(pack));
  useCreatorDraft(scope, "spin-pack changes", dirty, false);
  async function save() {
    const parsed = parsePackForm(draft);
    if ("error" in parsed) { setError(parsed.error); return; }
    if (await onSave(parsed.value)) { setEditing(false); setError(""); }
  }
  if (editing) return <li className="min-w-0 rounded-xl border border-line bg-base p-3"><fieldset disabled={busy}><legend className="sr-only">Edit pack</legend><PackFields draft={draft} onChange={setDraft} editing /><PackEstimate draft={draft} />{error && <p role="alert" className="mt-2 text-xs text-amber-200">{error}</p>}<div className="mt-3 flex flex-wrap gap-2"><button type="button" onClick={() => void save()} className="btn-brand min-h-9 rounded-[9px] px-3.5 text-[12.5px] font-bold">Save</button><button type="button" onClick={() => { setDraft(packFormDraft(pack)); setEditing(false); setError(""); }} className={ghostBtn}>{dirty ? "Discard edits" : "Cancel"}</button></div></fieldset></li>;
  return <li className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-line bg-base px-3 py-2.5"><div className="min-w-0 flex-1 basis-40"><span className="block truncate font-semibold text-ink">{pack.label}</span><p className="tnum mt-0.5 text-xs text-muted">{KIND_LABEL[pack.packKind ?? "spins"]} · {pack.spins} spins · {formatCents(pack.amountCents)}{pack.bonusSpins > 0 ? ` · +${pack.bonusSpins} bonus` : ""}</p></div><button type="button" disabled={busy} onClick={() => { setDraft(packFormDraft(pack)); setEditing(true); }} className={ghostBtn}>Edit</button>{confirmDelete ? <><button type="button" disabled={busy} onClick={onDelete} className={`${ghostBtn} !text-red-300`}>Confirm</button><button type="button" disabled={busy} onClick={() => setConfirmDelete(false)} className={ghostBtn}>Cancel</button></> : <button type="button" disabled={busy} onClick={() => setConfirmDelete(true)} className={ghostBtn}>Delete</button>}</li>;
}
