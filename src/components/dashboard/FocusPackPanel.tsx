"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CreatorFocusView } from "@/lib/data/focusView";
import type { WheelConfig } from "@/lib/games/wheel/types";
import type { PackValueOptions } from "@/lib/focus/ev";
import { DEFAULT_CHASE_WITHIN, DEFAULT_FOCUS_MULTIPLIER, DEFAULT_FOCUS_SPINS, MAX_COMBINED_BOOST } from "@/lib/focus/config";
import { formatCents } from "@/lib/format";
import FocusValuePreview from "./FocusValuePreview";
import { creatorIntent, creatorIntentComplete } from "./creatorIntent";
import { useCreatorDraft, useCreatorLeave } from "./CreatorDrafts";
import CreatorRequestRecovery from "./CreatorRequestRecovery";

const REASON: Record<string, string> = {
  blocked: "This fan is blocked. Packs cannot be granted.", self_excluded: "This fan paused their link. Packs cannot be granted.",
  on_break: "The fan is taking a break. New packs are off until it ends.", active_focus: "This fan already has an active or paused pack. Packs cannot stack.",
  no_active_pass: "Create an active saved fan pass before granting a Focus pack.", focus_disabled: "Focus packs are not enabled for this creator yet.",
  unavailable: "This grant is not available. Refresh the fan's status before trying again.", invalid_target: "This prize is no longer eligible. Refresh and choose an available Boostable prize.",
  invalid_pack: "This saved pack changed or is unavailable. Refresh the choices.", focus_exists: "This fan already has a pack. Refresh to see its current status.",
  sold_out: "The prize is sold out. No pack was granted.", conflict: "This request conflicts with an earlier grant. Refresh the fan's status before making another request.",
  unauthorized: "Your session ended. Sign in again before granting a pack.", forbidden: "You don't have permission to grant packs to this fan.",
};
const PAUSED: Record<string, string> = {
  sold_out: "The target is sold out. Focus spins are kept while it is paused.", other_wheel: "Playing a different wheel pauses this pack; those plays do not use its allowance.",
  no_increase: "The current pool cannot increase this target's odds. Its allowance is kept.", pity: "The next pity-protected draw cannot use this boost. The focus is kept for a later eligible spin.", unavailable: "The target is unavailable. Its unused allowance is kept.",
};
const button = "min-h-10 rounded-lg border border-line px-3 py-2 text-xs font-semibold text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] disabled:cursor-not-allowed disabled:opacity-50";

export default function FocusPackPanel({ fanId, initialPackId, onChanged, refreshKey }: { fanId: string; initialPackId?: string | null; onChanged: () => void | Promise<void>; refreshKey?: string }) {
  const [data, setData] = useState<CreatorFocusView | null>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [open, setOpen] = useState(!!initialPackId);
  const [packId, setPackId] = useState(initialPackId ?? "");
  const [prizeId, setPrizeId] = useState("");
  const [passId, setPassId] = useState("");
  const [edited, setEdited] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [cancelConfirm, setCancelConfirm] = useState(false);
  const [wheel, setWheel] = useState<WheelConfig | null>(null);
  const [wheelError, setWheelError] = useState(false);
  const leave = useCreatorLeave();
  const scope = `fan-focus:${fanId}`;
  const primed = useRef(false);
  useCreatorDraft(scope, "this focus-pack selection", open && (edited || uncertain), busy || uncertain);
  const load = useCallback(async () => {
    const response = await fetch(`/api/fans/${encodeURIComponent(fanId)}/focus`, { cache: "no-store" });
    if (!response.ok) throw new Error();
    const next = await response.json() as CreatorFocusView;
    setData(next);
    if (!primed.current) {
      primed.current = true;
      if (initialPackId) {
        const initialKind = next.packs.find((pack) => pack.id === initialPackId)?.packKind;
        const wished = next.targets.find((item) => item.wishlisted && item.available && (initialKind === "chase" || item.weight > 0) && next.passes.some((pass) => pass.wheelId === item.wheelId));
        if (wished) {
          setPrizeId(wished.id);
          const matching = next.passes.filter((pass) => pass.wheelId === wished.wheelId);
          setPassId(matching.length === 1 ? matching[0].id : "");
        }
      }
    }
    return next;
  }, [fanId, initialPackId]);
  useEffect(() => {
    let live = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount; state is updated after the network response
    load().catch(() => { if (live) setError("Couldn't load this fan's pack eligibility. Refresh before granting."); });
    return () => { live = false; };
  }, [load, refreshKey]);
  const selectedPack = data?.packs.find((pack) => pack.id === packId);
  const target = data?.targets.find((item) => item.id === prizeId);
  const passes = data?.passes.filter((pass) => pass.wheelId === target?.wheelId) ?? [];
  const kind = selectedPack?.packKind === "chase" ? "chase" : "focus";
  const duration = kind === "chase" ? selectedPack?.chaseWithin ?? DEFAULT_CHASE_WITHIN : selectedPack?.focusSpins ?? DEFAULT_FOCUS_SPINS;
  const gateReason = data ? !data.canGrant ? REASON[data.blockedReason ?? "unavailable"] ?? REASON.unavailable : kind === "chase" && !data.chaseEnabled ? "Chase grants are disabled until this creator is enabled for the TEST pilot." : "" : "Loading server eligibility…";
  const valid = !!data?.canGrant && !!selectedPack && !!target?.available && (kind === "chase" || target.weight > 0) && passes.some((pass) => pass.id === passId) && !(kind === "chase" && !data.chaseEnabled);
  const preview = useMemo<PackValueOptions | null>(() => selectedPack && target ? ({ kind, spins: duration, prizeId: target.id, multiplier: selectedPack.focusMultiplier ?? DEFAULT_FOCUS_MULTIPLIER, within: selectedPack.chaseWithin ?? DEFAULT_CHASE_WITHIN, priceCents: selectedPack.amountCents }) : null, [selectedPack, target, kind, duration]);
  useEffect(() => {
    if (!target?.wheelId) return;
    const controller = new AbortController();
    fetch(`/api/wheels/${encodeURIComponent(target.wheelId)}`, { cache: "no-store", signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error();
      const body = await response.json() as { wheel?: WheelConfig };
      if (!body.wheel) throw new Error();
      if (!controller.signal.aborted) { setWheel(body.wheel); setWheelError(false); }
    }).catch(() => { if (!controller.signal.aborted) setWheelError(true); });
    return () => controller.abort();
  }, [target?.wheelId, target?.id]);

  function chooseTarget(nextId: string, source = data) {
    setPrizeId(nextId); setReviewed(false); setEdited(true); setWheel(null); setWheelError(false);
    const nextTarget = source?.targets.find((item) => item.id === nextId);
    const matching = source?.passes.filter((pass) => pass.wheelId === nextTarget?.wheelId) ?? [];
    setPassId(matching.length === 1 ? matching[0].id : "");
  }
  function start() {
    if (!data) return;
    setOpen(true); setError(""); setStatus(""); setReviewed(false);
    if (!packId) setPackId(data.packs.find((pack) => pack.packKind === "focus")?.id ?? "");
    const wished = data.targets.find((item) => item.wishlisted && item.available && (kind === "chase" || item.weight > 0) && data.passes.some((pass) => pass.wheelId === item.wheelId));
    if (wished && !prizeId) { chooseTarget(wished.id); setEdited(false); }
  }
  function close() {
    leave(() => { setOpen(false); setEdited(false); setReviewed(false); setPackId(""); setPrizeId(""); setPassId(""); setUncertain(false); }, { scope, consequence: "Closing discards the selection. It does not undo a request already sent." });
  }
  async function grant() {
    if ((!valid && !uncertain) || !reviewed || busy || (!uncertain && (!wheel || wheelError))) return;
    setBusy(true); setError(""); setStatus("");
    let confirmed = false;
    let sent = false;
    let serverError = "";
    try {
      const payload = { packId, prizeId, passId };
      const requestId = await creatorIntent(`focus:${fanId}`, payload);
      sent = true;
      const response = await fetch(`/api/fans/${encodeURIComponent(fanId)}/focus`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId, ...payload }) });
      const result = await response.json() as { error?: string; grantId?: string; replayed?: boolean };
      if (!response.ok || !result.grantId) {
        serverError = REASON[result.error ?? "unavailable"] ?? "The server couldn't confirm this grant.";
        throw new Error("grant_unconfirmed");
      }
      confirmed = true;
      creatorIntentComplete(`focus:${fanId}`, requestId);
      setUncertain(false); setEdited(false); setReviewed(false); setOpen(false);
      setStatus(result.replayed ? "This grant was already recorded; no duplicate spins were added." : "Pack granted. The server recorded the saved pack's spins and price.");
      await load(); await onChanged();
    } catch (error) {
      if (!sent) setError(error instanceof Error && error.message === "intent_pending" ? "An earlier request needs checking. Restore its original selection and retry; a different grant has not been sent." : "No grant was sent because this browser couldn't save a safe retry receipt. Allow session storage and retry.");
      else if (!confirmed) { setUncertain(true); setError(`${serverError ? `${serverError} ` : ""}The grant result couldn't be confirmed. Keep this selection and use Check this grant again; the same request is safe to retry.`); }
      else setError("The grant was confirmed, but the refreshed status couldn't load. Refresh before making another grant.");
    } finally { setBusy(false); }
  }
  async function cancel() {
    if (busy || !data?.focusId) return;
    const expectedFocusId = data.focusId;
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/fans/${encodeURIComponent(fanId)}/focus`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ focusId: expectedFocusId }) });
      const result = await response.json() as { focusId?: unknown; released?: unknown };
      if (!response.ok || result.focusId !== expectedFocusId || typeof result.released !== "boolean") throw new Error();
      setCancelConfirm(false); setStatus(result.released ? "Pack cancelled. Unused reserved stock is released; granted spins stay in the fan's balance. Arrange any refund separately." : "That selected pack is no longer active. Current status has been refreshed.");
      await load(); await onChanged();
    } catch { setError("Couldn't confirm cancellation. Refresh the status, then retry if it is still active."); }
    finally { setBusy(false); }
  }
  return <section data-testid="creator-focus-panel" className="rounded-xl border border-line p-3.5">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-[13px] font-bold text-ink">Focus &amp; Chase packs</h3><button type="button" disabled={busy} className={button} onClick={() => void load().catch(() => setError("Couldn't refresh pack eligibility."))}>Refresh status</button></div>
    {error && <p role="alert" className="mt-2 text-xs text-amber-200">{error}</p>}
    {status && <p role="status" className="mt-2 text-xs text-ink">{status}</p>}
    {!data && <button type="button" className={`${button} mt-2`} onClick={() => void load().catch(() => setError("Couldn't load pack eligibility."))}>Refresh eligibility</button>}
    {data?.focus && <div data-testid="creator-current-focus" className="mt-2 space-y-1 text-xs text-muted">
      <p className="font-semibold text-ink">{data.focus.kind === "chase" ? "Chase" : `Focus ×${data.focus.multiplier}`} · {data.focus.prizeEmoji} {data.focus.prizeLabel}</p>
      <p>{data.focus.status === "paused" ? "Paused" : data.focus.status === "active" ? "Active" : data.focus.status === "completed" ? "Completed" : "Cancelled"} · {data.focus.kind === "chase" ? `${Math.max(0, data.focus.chaseWithin - data.focus.chaseCounter)} eligible spins to guarantee` : `${data.focus.spinsLeft} eligible spins left`}</p>
      {data.focus.pauseReason && <p>{PAUSED[data.focus.pauseReason]}</p>}
      {(data.focus.status === "active" || data.focus.status === "paused") && <>{cancelConfirm ? <div role="group" aria-label="Confirm cancelling the pack" className="space-y-2 rounded-lg border border-amber-300/30 p-2"><p>Cancelling releases unused reserved stock. It does not remove granted spins or refund the fan.</p><button type="button" disabled={busy || !data.focusId} className={button} onClick={() => void cancel()}>Confirm cancel pack</button><button type="button" disabled={busy} className={`${button} ml-2`} onClick={() => setCancelConfirm(false)}>Keep pack</button></div> : <button type="button" disabled={busy || !data.focusId} className={button} onClick={() => setCancelConfirm(true)}>Cancel pack</button>}</>}
    </div>}
    {!open && <><button type="button" data-testid="focus-open" disabled={!data?.canGrant || !data.packs.length || busy} className={`${button} mt-3`} onClick={start}>Choose a Focus pack</button>{data && (!data.canGrant || !data.packs.length) && <p className="mt-2 text-xs text-muted">{!data.canGrant ? REASON[data.blockedReason ?? "unavailable"] ?? REASON.unavailable : "Save a Focus or Chase preset in Campaigns first."}</p>}</>}
    {open && data && <div data-testid="focus-grant-form" className="mt-3 space-y-3">
      <fieldset disabled={busy || uncertain} className="space-y-3">
        <legend className="sr-only">Choose the saved pack, prize and pass</legend>
        <label className="block text-xs text-muted">Saved pack<select data-testid="focus-pack" className="ff-input mt-1 w-full" value={packId} onChange={(e) => { setPackId(e.target.value); setEdited(true); setReviewed(false); }}><option value="">Choose a pack</option>{data.packs.map((pack) => <option key={pack.id} value={pack.id} disabled={pack.packKind === "chase" && !data.chaseEnabled}>{pack.label} · {pack.packKind === "chase" ? "Chase" : "Focus"} · {formatCents(pack.amountCents)}{pack.packKind === "chase" && !data.chaseEnabled ? " · pilot not enabled" : ""}</option>)}</select></label>
        <label className="block text-xs text-muted">Target prize<select data-testid="focus-target" className="ff-input mt-1 w-full" value={prizeId} onChange={(e) => chooseTarget(e.target.value)}><option value="">Choose a Boostable prize</option>{data.targets.map((item) => <option key={item.id} value={item.id} disabled={!item.available || (kind === "focus" && item.weight <= 0) || !data.passes.some((pass) => pass.wheelId === item.wheelId)}>{item.emoji} {item.label} · {item.wheelTitle}{item.wishlisted ? " · wishlisted" : ""}{!item.available ? " · sold out" : kind === "focus" && item.weight <= 0 ? " · no natural odds for Focus" : !data.passes.some((pass) => pass.wheelId === item.wheelId) ? " · no active pass" : ""}</option>)}</select></label>
        <label className="block text-xs text-muted">Saved fan pass<select data-testid="focus-pass" className="ff-input mt-1 w-full" value={passId} onChange={(e) => { setPassId(e.target.value); setEdited(true); setReviewed(false); }}><option value="">Choose the pass to credit</option>{passes.map((pass, index) => <option key={pass.id} value={pass.id}>{pass.wheelTitle} · saved pass {index + 1} · {pass.spinsRemaining} spins left</option>)}</select></label>
      </fieldset>
      {gateReason && <p data-testid="focus-disabled-reason" className="text-xs text-muted">{gateReason}</p>}
      {target?.wishlisted && <p className="text-xs text-muted">This target is on the fan&apos;s wishlist. Review it before granting.</p>}
      {selectedPack && <div className="space-y-1 text-xs text-ink"><p>{selectedPack.spins + selectedPack.bonusSpins} spins will be credited to the chosen pass. Saved pack price: {formatCents(selectedPack.amountCents)}.</p><p>{kind === "focus" ? `×${selectedPack.focusMultiplier ?? DEFAULT_FOCUS_MULTIPLIER} for ${duration} eligible spins; a boost is not a guarantee. All boosts together stay within ×${MAX_COMBINED_BOOST}.` : `The target is guaranteed within ${duration} eligible spins. ${target?.finite ? "One unit is reserved when you grant it." : "The target has unlimited stock."}`}</p>{selectedPack.spins + selectedPack.bonusSpins !== duration && <p className="text-amber-200">The cost preview covers only the {duration}-spin modifier period, not every spin in this saved pack.</p>}</div>}
      {wheelError && <p role="status" className="text-xs text-amber-200">The saved wheel couldn&apos;t load. Refresh eligibility before relying on the preview or granting.</p>}
      {wheel && preview && <FocusValuePreview wheel={wheel} options={preview} />}
      <label className="flex items-start gap-2 text-xs text-ink"><input data-testid="focus-review" type="checkbox" className="mt-0.5 shrink-0 accent-[var(--brand)]" disabled={busy} checked={reviewed} onChange={(e) => { setReviewed(e.target.checked); setEdited(true); }} /><span>Confirm this saved pack, target, pass and recorded price.</span></label>
      <div className="flex flex-wrap gap-2"><button type="button" data-testid="focus-grant" disabled={!reviewed || busy || (!uncertain && (!valid || !wheel || wheelError))} className={`${button} btn-brand`} onClick={() => void grant()}>{busy ? "Checking grant…" : uncertain ? "Check this grant again" : `Grant ${kind === "chase" ? "Chase" : "Focus"} pack`}</button><button type="button" disabled={busy} className={button} onClick={close}>Close selection</button></div>
    </div>}
    <CreatorRequestRecovery scope={`focus:${fanId}`} guardScope={scope} kind="focus" refreshKey={busy} disabled={busy} onFound={() => setUncertain(true)} onBusyChange={setBusy} onResolved={async (outcome) => {
      setUncertain(false); setError("");
      if (outcome === "committed" || outcome === "gone") { setOpen(false); setEdited(false); setReviewed(false); setPackId(""); setPrizeId(""); setPassId(""); }
      await load(); await onChanged();
    }} />
  </section>;
}
