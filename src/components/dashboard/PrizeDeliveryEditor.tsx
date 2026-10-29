"use client";

import { useEffect, useId, useRef, useState } from "react";
import { gameRefusalMessage } from "./gameEditor";
import {
  MAX_CODES_PER_PASTE,
  MAX_CODE_LENGTH,
  MAX_REWARD_LINK,
  MAX_REWARD_TEXT,
  normalizeRewardLink,
  normalizeRewardText,
  parseCodeList,
  type PrizeDelivery,
  type PrizeDeliveryView,
} from "@/lib/rewards/config";

const LABEL: Record<PrizeDelivery, string> = {
  manual: "Manual", link: "Instant link", text: "Instant text", codes: "Code list",
};
const ERROR: Record<string, string> = {
  unauthorized: "Your session ended. Sign in again to change delivery.",
  forbidden: "You don't have permission to change this prize.",
  not_found: "This prize is no longer available. Reload the wheel and try again.",
  reward_key_missing: "Instant delivery is unavailable right now. Keep this prize manual or try again later.",
  too_many_codes: "This prize has reached its code limit. Wait until more codes have been delivered.",
  invalid_link: "Enter a valid https link without a username or password.",
  invalid_text: `Enter between 1 and ${MAX_REWARD_TEXT} characters.`,
  code_too_long: `Keep each code to ${MAX_CODE_LENGTH} characters or fewer.`,
  too_many_codes_per_paste: `Add no more than ${MAX_CODES_PER_PASTE} codes at a time.`,
};
const button = "inline-flex min-h-9 items-center justify-center rounded-lg border border-[var(--hair)] px-3 text-xs font-semibold text-ink transition-colors hover:bg-[color-mix(in_oklab,var(--color-ink)_6%,transparent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] disabled:cursor-not-allowed disabled:opacity-50";

/** Delivery is saved separately: reward values must never enter a wheel draft. */
export default function PrizeDeliveryEditor({
  prizeId, prizeLabel, delivery = "manual", canSave, disabled, onSaved, onDirtyChange, onBusyChange,
}: {
  prizeId: string;
  prizeLabel: string;
  delivery?: PrizeDelivery;
  canSave: boolean;
  disabled: boolean;
  onSaved: (view: PrizeDeliveryView) => void;
  onDirtyChange: (prizeId: string, dirty: boolean) => void;
  onBusyChange: (prizeId: string, busy: boolean) => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<PrizeDeliveryView | null>(null);
  const [kind, setKind] = useState<PrizeDelivery>(delivery);
  const [value, setValue] = useState("");
  const [codes, setCodes] = useState("");
  const [confirmedRemoval, setConfirmedRemoval] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const mounted = useRef(true);
  const request = useRef<AbortController | null>(null);
  const dirty = !!view && (kind !== view.delivery || codes.trim() !== "" || ((kind === "link" || kind === "text") && value !== (view.value ?? "")));
  const removesCodes = !!view && view.delivery === "codes" && kind !== "codes" && view.codesLeft > 0;
  const locked = disabled || busy || loading || !canSave || !view;
  const valueError = error === ERROR.invalid_link || error === ERROR.invalid_text;
  const codesError = error === ERROR.code_too_long || error === ERROR.too_many_codes_per_paste || error === "Paste at least one code, one per line.";

  useEffect(() => {
    onDirtyChange(prizeId, dirty);
    return () => onDirtyChange(prizeId, false);
  }, [dirty, onDirtyChange, prizeId]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      request.current?.abort();
    };
  }, []);

  async function load() {
    if (!canSave || loading || busy) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/prizes/${encodeURIComponent(prizeId)}/reward`, { cache: "no-store", signal: controller.signal });
      const data = await res.json() as { delivery?: PrizeDeliveryView; error?: string };
      if (!res.ok || !data.delivery) throw new Error(data.error ?? "load_failed");
      if (!mounted.current) return;
      setView(data.delivery);
      setKind(data.delivery.delivery);
      setValue(data.delivery.value ?? "");
      setCodes("");
      setConfirmedRemoval(false);
      onSaved(data.delivery);
    } catch (e) {
      if (controller.signal.aborted || !mounted.current) return;
      const code = e instanceof Error ? e.message : "";
      setError(ERROR[code] ?? "Couldn't load delivery. Try again.");
    } finally {
      if (mounted.current && request.current === controller) setLoading(false);
    }
  }

  function toggleOpen() {
    setOpen(!open);
    if (!open && !view) void load();
  }

  async function save() {
    if (locked || !view || !dirty || (removesCodes && !confirmedRemoval)) return;
    const parsed = parseCodeList(codes);
    let body: { kind: "manual" } | { kind: "link" | "text"; value: string } | { codes: string };
    if (kind === "codes") {
      if (parsed.tooLong) { setError(ERROR.code_too_long); return; }
      if (!parsed.codes.length) { setError("Paste at least one code, one per line."); return; }
      if (parsed.codes.length > MAX_CODES_PER_PASTE) { setError(ERROR.too_many_codes_per_paste); return; }
      body = { codes };
    } else if (kind === "manual") {
      body = { kind: "manual" };
    } else {
      const normalized = kind === "link" ? normalizeRewardLink(value) : normalizeRewardText(value);
      if (!normalized) { setError(ERROR[kind === "link" ? "invalid_link" : "invalid_text"]); return; }
      body = { kind, value: normalized };
    }
    setBusy(true);
    onBusyChange(prizeId, true);
    setError("");
    setStatus("");
    try {
      const res = await fetch(`/api/prizes/${encodeURIComponent(prizeId)}/${kind === "codes" ? "codes" : "reward"}`, {
        method: kind === "codes" ? "POST" : "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        cache: "no-store",
      });
      const data = await res.json() as { delivery?: PrizeDeliveryView; error?: string; added?: number; duplicates?: number };
      if (!res.ok || !data.delivery) throw new Error(data.error ?? "save_failed");
      if (!mounted.current) return;
      setView(data.delivery);
      setKind(data.delivery.delivery);
      setValue(data.delivery.value ?? "");
      setCodes("");
      setConfirmedRemoval(false);
      onSaved(data.delivery);
      const skipped = data.duplicates ?? 0;
      setStatus(kind === "codes" ? `${data.added ?? parsed.codes.length} codes added.${skipped ? ` ${skipped} duplicate line${skipped === 1 ? " was" : "s were"} ignored.` : ""}` : "Delivery saved.");
    } catch (e) {
      if (mounted.current) {
        const code = e instanceof Error ? e.message : "";
        setError(gameRefusalMessage(code) ?? ERROR[code] ?? "Couldn't save delivery. Your draft is still here; try again.");
      }
    } finally {
      onBusyChange(prizeId, false);
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <div data-testid="prize-delivery-editor" data-prize-id={prizeId} className="mt-3 min-w-0 rounded-[10px] border border-[var(--hair)] p-3 [background:var(--s2)]">
      <button type="button" data-testid="delivery-toggle" aria-expanded={open} aria-controls={`${id}-panel`} onClick={toggleOpen} className="flex min-h-9 w-full items-center justify-between gap-2 rounded text-left text-xs font-semibold text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]">
        <span>Delivery · {LABEL[delivery]}</span><span aria-hidden="true">{open ? "−" : "+"}</span>
      </button>
      {open && (
        <div id={`${id}-panel`} className="min-w-0 pt-2">
          {!canSave && <p className="text-xs text-muted">Save your game changes before setting delivery for this prize.</p>}
          {loading && <p role="status" className="text-xs text-muted">Loading delivery…</p>}
          {error && <p id={`${id}-error`} role="alert" data-testid="delivery-error" className="mb-2 text-xs text-[#fca5a5]">{error}</p>}
          {!view && canSave && !loading && <button type="button" onClick={() => void load()} className={button}>Load delivery</button>}
          {view && (
            <>
              {!view.ready && <p className="mb-2 text-xs text-muted">Instant delivery is unavailable right now. Manual prizes still work.</p>}
              <fieldset disabled={locked} className="flex min-w-0 flex-col gap-3 disabled:opacity-70">
                <legend className="sr-only">Delivery for {prizeLabel || "this prize"}</legend>
                <label className="flex min-w-0 flex-col gap-1.5 text-xs font-semibold text-muted">
                  Delivery
                  <select data-testid="delivery-kind" className="ff-input w-full" value={kind} onChange={(e) => {
                    const next = e.target.value as PrizeDelivery;
                    setKind(next); setValue(next === view.delivery ? view.value ?? "" : ""); setConfirmedRemoval(false); setError(""); setStatus("");
                  }}>
                    {(["manual", "link", "text", "codes"] as const).map((k) => <option key={k} value={k} disabled={k !== "manual" && !view.ready}>{LABEL[k]}</option>)}
                  </select>
                </label>
                {kind === "manual" && <p className="text-xs text-muted">You fulfil this prize yourself from the prize queue.</p>}
                {(kind === "link" || kind === "text") && (
                  <label className="flex min-w-0 flex-col gap-1.5 text-xs font-semibold text-muted">
                    {kind === "link" ? "Reward link (https)" : "Reward text"}
                    {kind === "link" ? <input data-testid="delivery-value" type="url" className="ff-input w-full min-w-0" value={value} maxLength={MAX_REWARD_LINK} autoComplete="off" spellCheck={false} aria-invalid={valueError || undefined} aria-describedby={`${id}-value-help${valueError ? ` ${id}-error` : ""}`} onChange={(e) => { setValue(e.target.value); setStatus(""); setError(""); }} /> : <textarea data-testid="delivery-value" className="ff-input w-full min-w-0 resize-y" rows={3} value={value} maxLength={MAX_REWARD_TEXT} autoComplete="off" aria-invalid={valueError || undefined} aria-describedby={`${id}-value-help${valueError ? ` ${id}-error` : ""}`} onChange={(e) => { setValue(e.target.value); setStatus(""); setError(""); }} />}
                    <span id={`${id}-value-help`} className="font-normal">{kind === "link" ? "Links must comply with your platform's rules. Winners open this off-site." : `${value.length}/${MAX_REWARD_TEXT} characters. Only the winning fan sees this.`}</span>
                  </label>
                )}
                {kind === "codes" && (
                  <>
                    <p data-testid="delivery-code-count" className="text-xs text-ink">{view.delivery === "codes" ? view.codesLeft : 0} codes left · {view.delivery === "codes" ? view.codesUsed : 0} delivered</p>
                    {view.delivery === "codes" && view.preview.length > 0 && <p data-testid="delivery-code-preview" className="break-all font-mono text-xs text-muted">{view.preview.join(" · ")}</p>}
                    <label className="flex min-w-0 flex-col gap-1.5 text-xs font-semibold text-muted">
                      Add codes (one per line)
                      <textarea data-testid="delivery-codes" className="ff-input w-full min-w-0 resize-y font-mono" rows={4} value={codes} autoComplete="off" spellCheck={false} onChange={(e) => { setCodes(e.target.value); setStatus(""); setError(""); }} aria-invalid={codesError || undefined} aria-describedby={`${id}-codes-help${codesError ? ` ${id}-error` : ""}`} />
                    </label>
                    <p id={`${id}-codes-help`} className="text-xs text-muted">Stock follows the unused code count. Full codes are never shown back after saving. Add up to {MAX_CODES_PER_PASTE} at a time.</p>
                  </>
                )}
                {removesCodes && <label className="flex items-start gap-2 rounded-lg border border-amber-300/30 p-2.5 text-xs text-ink"><input data-testid="delivery-remove-codes-confirm" type="checkbox" checked={confirmedRemoval} onChange={(e) => setConfirmedRemoval(e.target.checked)} className="mt-0.5 shrink-0 accent-[var(--brand)]" /><span>Remove {view.codesLeft} unused code{view.codesLeft === 1 ? "" : "s"} and change delivery. Rewards already won remain available to their winners.</span></label>}
                <div className="flex flex-wrap gap-2">
                  <button type="button" data-testid="delivery-save" onClick={() => void save()} disabled={!dirty || (kind !== "manual" && !view.ready) || (removesCodes && !confirmedRemoval)} className={`${button} btn-brand`}>{busy ? "Saving…" : kind === "codes" ? "Add codes" : "Save delivery"}</button>
                  {dirty && <button type="button" onClick={() => { setKind(view.delivery); setValue(view.value ?? ""); setCodes(""); setConfirmedRemoval(false); setError(""); setStatus(""); }} className={button}>Discard delivery changes</button>}
                </div>
              </fieldset>
              {dirty && <p className="mt-2 text-xs text-muted">Delivery changes are not saved yet. Use {kind === "codes" ? "Add codes" : "Save delivery"} above.</p>}
            </>
          )}
          <p role="status" aria-live="polite" data-testid="delivery-status" className="mt-2 empty:hidden text-xs text-ink">{status}</p>
        </div>
      )}
    </div>
  );
}
