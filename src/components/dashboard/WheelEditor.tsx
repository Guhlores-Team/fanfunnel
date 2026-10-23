"use client";

import { useEffect, useMemo, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import Wheel from "@/components/Wheel";
import { prizeOdds } from "@/lib/games/wheel/engine";
import {
  RARITY_COLORS,
  RARITY_ORDER,
  type Prize,
  type Rarity,
  type WheelConfig,
} from "@/lib/games/wheel/types";
import type { PrizeTemplate } from "@/lib/data/types";
import { useToast } from "@/components/ui/Toast";
import { OddsBar } from "@/components/dashboard/OddsBar";
import { Field } from "./ui";
import WheelSwitcher from "@/components/dashboard/WheelSwitcher";
import TemplateLibrary from "@/components/dashboard/TemplateLibrary";
import {
  EMOJI_SUGGESTIONS,
  balanceOdds,
  duplicatePrize,
  newPrize,
  reorder,
  RARITY_DEFAULT_WEIGHT,
} from "@/components/dashboard/editorHelpers";

// ---------------------------------------------------------------------------
// Wheel editor
// ---------------------------------------------------------------------------
export default function WheelEditor({
  wheel,
  setWheel,
  initialWheel,
  editingWheelId,
  setEditingWheelId,
  onWheelMutated,
}: {
  wheel: WheelConfig;
  setWheel: Dispatch<SetStateAction<WheelConfig>>;
  initialWheel: WheelConfig;
  editingWheelId: string | null;
  setEditingWheelId: (id: string | null) => void;
  /** Notify the parent (refreshes overview, incl. the wheelBuilt onboarding signal). */
  onWheelMutated: () => void;
}) {
  const odds = useMemo(() => prizeOdds(wheel), [wheel]);
  // OddsBar expects percentages (0–100); prizeOdds returns fractions (0–1).
  const oddsPct = useMemo(() => {
    const m = new Map<string, number>();
    for (const [id, f] of odds) m.set(id, f * 100);
    return m;
  }, [odds]);
  const toast = useToast();
  const [savedJson, setSavedJson] = useState(() => JSON.stringify(initialWheel));
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [showLibrary, setShowLibrary] = useState(false);
  // #9: bumped after a prize is saved to the library (★) so TemplateLibrary
  // refetches and the favorite shows up immediately — no page refresh.
  const [librarySignal, setLibrarySignal] = useState(0);
  const dirty = JSON.stringify(wheel) !== savedJson;

  async function save() {
    setSaving(true);
    setJustSaved(false);
    try {
      const res = await fetch("/api/wheel", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wheel }),
      });
      const data = await res.json();
      if (res.ok && data.wheel) {
        setWheel(data.wheel);
        setSavedJson(JSON.stringify(data.wheel));
        setEditingWheelId(data.wheel.id);
        setJustSaved(true);
        setTimeout(() => setJustSaved(false), 2000);
        // Refresh the onboarding "wheelBuilt" signal now that this wheel saved.
        onWheelMutated();
      } else {
        toast("Couldn't save. Are you signed in?", { tone: "error" });
      }
    } finally {
      setSaving(false);
    }
  }

  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);
  // #8: a prize card is only `draggable` once the drag is armed from its corner
  // grip handle. This keeps the prize text inputs fully selectable/editable —
  // clicking into a field never starts a reorder drag. Armed on the grip's
  // pointer-down, disarmed when the drag ends.
  const [dragArmedIdx, setDragArmedIdx] = useState<number | null>(null);

  // While a prize card is being dragged, auto-scroll the page when the pointer
  // nears the top/bottom of the viewport — without this, long prize lists could
  // only be reordered a couple of rows at a time. Speed ramps with proximity.
  useEffect(() => {
    if (dragIdx === null) return;
    let y = -1;
    let raf = 0;
    const onDragOver = (e: DragEvent) => {
      y = e.clientY;
    };
    const step = () => {
      const EDGE = 90;
      if (y >= 0) {
        if (y < EDGE) window.scrollBy(0, -Math.ceil(((EDGE - y) / EDGE) * 18));
        else if (y > window.innerHeight - EDGE)
          window.scrollBy(0, Math.ceil(((y - (window.innerHeight - EDGE)) / EDGE) * 18));
      }
      raf = requestAnimationFrame(step);
    };
    window.addEventListener("dragover", onDragOver);
    raf = requestAnimationFrame(step);
    return () => {
      window.removeEventListener("dragover", onDragOver);
      cancelAnimationFrame(raf);
    };
  }, [dragIdx]);

  function updatePrize(id: string, patch: Partial<Prize>) {
    setWheel({ ...wheel, prizes: wheel.prizes.map((p) => (p.id === id ? { ...p, ...patch } : p)) });
  }
  function addPrize() {
    setWheel({ ...wheel, prizes: [...wheel.prizes, newPrize()] });
  }
  // Load a wheel's full config into the editor and mark it as the one being
  // edited. The config carries its own id, so the existing save (PUT /api/wheel
  // with the full config) targets the right wheel.
  async function loadWheel(id: string) {
    const res = await fetch(`/api/wheels/${id}`, { cache: "no-store" });
    if (!res.ok) {
      toast("Couldn't open that wheel.", { tone: "error" });
      return;
    }
    const data = (await res.json()) as { wheel?: WheelConfig };
    if (!data.wheel) {
      toast("Couldn't open that wheel.", { tone: "error" });
      return;
    }
    setWheel(data.wheel);
    setSavedJson(JSON.stringify(data.wheel));
    setEditingWheelId(data.wheel.id);
  }
  // Apply a saved wheel template: it mints a fresh wheel from the template
  // server-side, then opens that new wheel in the editor.
  async function applyWheelTemplate(templateId: string) {
    const res = await fetch("/api/wheels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fromTemplateId: templateId }),
    });
    const data = (await res.json()) as { wheel?: WheelConfig };
    if (!res.ok || !data.wheel) {
      toast("Couldn't apply template.", { tone: "error" });
      return;
    }
    await loadWheel(data.wheel.id);
    toast("Template applied", { tone: "success" });
  }
  // Save the current editor wheel as a reusable template.
  async function saveCurrentWheelAsTemplate(name: string) {
    const res = await fetch("/api/templates/wheels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, config: wheel }),
    });
    if (res.ok) toast("Saved as template", { tone: "success" });
    else toast("Couldn't save template.", { tone: "error" });
  }
  // Save every prize on the current wheel into the reusable prize library.
  async function saveCurrentPrizesToLibrary() {
    const results = await Promise.all(
      wheel.prizes.map((p) =>
        fetch("/api/templates/prizes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            label: p.label,
            description: p.description,
            rarity: p.rarity,
            weight: p.weight,
            color: p.color,
            emoji: p.emoji,
          }),
        }).then((r) => r.ok)
      )
    );
    const saved = results.filter(Boolean).length;
    if (saved > 0) {
      // #9: surface the new prizes in the library immediately (no refresh).
      setLibrarySignal((n) => n + 1);
      toast(`Saved ${saved} ${saved === 1 ? "prize" : "prizes"} to library`, { tone: "success" });
    } else toast("Couldn't save prizes.", { tone: "error" });
  }
  // Save a SINGLE prize to the reusable library (the ★ on each prize row).
  async function savePrizeToLibrary(p: Prize) {
    const res = await fetch("/api/templates/prizes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        label: p.label,
        description: p.description,
        rarity: p.rarity,
        weight: p.weight,
        color: p.color,
        emoji: p.emoji,
      }),
    });
    if (res.ok) {
      // #9: favoriting must appear in the Prize Library immediately — bump the
      // signal so TemplateLibrary refetches without a page refresh.
      setLibrarySignal((n) => n + 1);
    }
    toast(
      res.ok ? `Saved "${p.label}" to library` : "Couldn't save prize.",
      { tone: res.ok ? "success" : "error" }
    );
  }
  // Drop a library prize into the current wheel. Reuse the editor's newPrize()
  // so ids/format match, then overlay the template's fields.
  function applyPrizeTemplate(t: PrizeTemplate) {
    const prize = {
      ...newPrize(),
      label: t.label,
      description: t.description,
      rarity: t.rarity,
      weight: t.weight,
      color: t.color,
      emoji: t.emoji,
    };
    setWheel({ ...wheel, prizes: [...wheel.prizes, prize] });
    toast("Prize added from library", { tone: "success" });
  }
  function movePrize(from: number, to: number) {
    if (to < 0 || to >= wheel.prizes.length || from === to) return;
    setWheel({ ...wheel, prizes: reorder(wheel.prizes, from, to) });
  }
  function duplicateAt(index: number) {
    const next = wheel.prizes.slice();
    next.splice(index + 1, 0, duplicatePrize(wheel.prizes[index]));
    setWheel({ ...wheel, prizes: next });
  }
  /** Update rarity: refresh a default color and always re-fill the weight from
   *  the new rarity's default tickets, so moving common → legendary visibly
   *  moves the odds too (the Tickets box stays editable to re-tune after). */
  function changeRarity(p: Prize, rarity: Rarity) {
    const wasDefaultColor = p.color == null || p.color === RARITY_COLORS[p.rarity];
    updatePrize(p.id, {
      rarity,
      color: wasDefaultColor ? RARITY_COLORS[rarity] : p.color,
      weight: RARITY_DEFAULT_WEIGHT[rarity],
    });
  }
  function removePrize(id: string) {
    if (wheel.prizes.length <= 2) return;
    const index = wheel.prizes.findIndex((p) => p.id === id);
    if (index < 0) return;
    const removed = wheel.prizes[index];
    setWheel((current) => ({
      ...current,
      prizes: current.prizes.filter((p) => p.id !== id),
    }));
    toast("Prize removed", {
      tone: "info",
      action: {
        label: "Undo",
        // Functional update against the *current* wheel, not the snapshot at
        // removal time, so re-inserting the prize doesn't clobber any edits the
        // creator made during the undo window.
        onClick: () => {
          setWheel((current) => {
            if (current.prizes.some((p) => p.id === removed.id)) return current;
            const restored = current.prizes.slice();
            restored.splice(Math.min(index, restored.length), 0, removed);
            return { ...current, prizes: restored };
          });
        },
      },
    });
  }

  return (
    <div>
      <div className="mb-6">
        <WheelSwitcher
          currentWheelId={editingWheelId}
          onEdit={loadWheel}
          onChanged={onWheelMutated}
        />
      </div>

      <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-surface px-4 py-3">
        <p className="text-sm">
          {dirty ? (
            <span className="text-amber-300">● Unsaved changes</span>
          ) : justSaved ? (
            <span className="text-emerald-300">✓ Saved</span>
          ) : (
            <span className="text-muted">All changes saved</span>
          )}
        </p>
        <button
          onClick={save}
          disabled={saving || !dirty}
          className="btn-brand rounded-lg px-5 py-2 text-sm font-bold"
        >
          {saving ? "Saving…" : "Save wheel"}
        </button>
      </div>

      <div className="grid gap-8 lg:grid-cols-[1fr_360px]">
        <div className="min-w-0">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Title">
              <input
                className="ff-input w-full"
                data-testid="wheel-title-input"
                value={wheel.title}
                onChange={(e) => setWheel({ ...wheel, title: e.target.value })}
              />
            </Field>
            <Field label="Brand color">
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  className="h-9 w-12 rounded border border-line bg-transparent"
                  value={wheel.brandColor ?? "#ec4899"}
                  onChange={(e) => setWheel({ ...wheel, brandColor: e.target.value })}
                />
                <input
                  className="ff-input w-full flex-1"
                  value={wheel.brandColor ?? ""}
                  onChange={(e) => setWheel({ ...wheel, brandColor: e.target.value })}
                />
              </div>
            </Field>
            {/* #11: per-wheel prize-label text color. Empty = Auto (Wheel.tsx
                picks a readable color per segment). Persists with the wheel. */}
            <Field label="Label text color" full>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  className="h-9 w-12 shrink-0 rounded border border-line bg-transparent"
                  value={wheel.labelColor ?? "#ffffff"}
                  onChange={(e) => setWheel({ ...wheel, labelColor: e.target.value })}
                  aria-label="Prize label color"
                />
                <input
                  className="ff-input min-w-0 flex-1"
                  value={wheel.labelColor ?? ""}
                  placeholder="Auto (readable per slice)"
                  onChange={(e) =>
                    setWheel({
                      ...wheel,
                      labelColor: e.target.value ? e.target.value : undefined,
                    })
                  }
                  aria-label="Prize label color hex"
                />
                <button
                  type="button"
                  onClick={() => setWheel({ ...wheel, labelColor: undefined })}
                  disabled={wheel.labelColor == null}
                  className="shrink-0 text-xs font-semibold text-muted underline-offset-2 transition hover:text-ink hover:underline disabled:opacity-40"
                >
                  Auto
                </button>
              </div>
            </Field>
            {/* Per-wheel prize-label text size. Empty = Auto (fit to slices).
                Larger sizes stay inside each slice (single line + ellipsis). */}
            <Field label="Label text size" full>
              <select
                className="ff-input w-full"
                value={wheel.labelSize ?? ""}
                onChange={(e) =>
                  setWheel({
                    ...wheel,
                    labelSize:
                      (e.target.value || undefined) as WheelConfig["labelSize"],
                  })
                }
                aria-label="Prize label text size"
              >
                <option value="">Auto (fit to slices)</option>
                <option value="s">Small</option>
                <option value="l">Large</option>
                <option value="xl">Extra large</option>
              </select>
            </Field>
            <Field label="Subtitle" full>
              <input
                className="ff-input w-full"
                value={wheel.subtitle ?? ""}
                onChange={(e) => setWheel({ ...wheel, subtitle: e.target.value })}
              />
            </Field>
          </div>

          <div className="card mt-6 rounded-xl p-3">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted">
              Odds
            </span>
            <div className="mt-2">
              <OddsBar prizes={wheel.prizes} odds={oddsPct} />
            </div>
          </div>

          {/* #7: brand-new wheels start with zero prizes — show a friendly
              empty state + "Add your first prize" instead of a bare list. */}
          {wheel.prizes.length === 0 && (
            <div className="mt-4 rounded-xl border border-dashed border-line p-8 text-center">
              <div className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-[color-mix(in_oklab,var(--brand)_14%,transparent)] text-2xl">
                🎁
              </div>
              <p className="mt-3 font-semibold text-ink">No prizes yet</p>
              <p className="mx-auto mt-1 max-w-sm text-sm text-muted">
                Add your first prize to start building this wheel. You can set its
                rarity, odds, and color — or pull one from your library below.
              </p>
              <button
                type="button"
                onClick={addPrize}
                className="btn-brand mt-4 rounded-lg px-4 py-2 text-sm font-bold"
              >
                + Add your first prize
              </button>
            </div>
          )}

          <div className="mt-4 space-y-3">
            {wheel.prizes.map((p, index) => {
              const swatch = p.color ?? RARITY_COLORS[p.rarity];
              return (
                <div
                  key={p.id}
                  // #8: only draggable once armed via the grip handle below, so
                  // the text fields stay selectable/editable the rest of the time.
                  draggable={dragArmedIdx === index}
                  onDragStart={() => setDragIdx(index)}
                  onDragOver={(e) => {
                    e.preventDefault();
                    if (dragIdx !== null && dragIdx !== index) setDragOverIdx(index);
                  }}
                  onDragLeave={() => setDragOverIdx((v) => (v === index ? null : v))}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (dragIdx !== null) movePrize(dragIdx, index);
                    setDragIdx(null);
                    setDragOverIdx(null);
                    setDragArmedIdx(null);
                  }}
                  onDragEnd={() => {
                    setDragIdx(null);
                    setDragOverIdx(null);
                    setDragArmedIdx(null);
                  }}
                  className={`card rounded-xl p-3 transition-[box-shadow,opacity,transform] duration-150 ${
                    dragIdx === index ? "scale-[0.99] opacity-50" : ""
                  } ${
                    dragOverIdx === index
                      ? "shadow-[0_0_0_2px_var(--brand)]"
                      : ""
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      // The ONLY drag affordance: arming on pointer-down lets the
                      // native drag start from here, while leaving the prize
                      // inputs non-draggable (text stays selectable). Disarm if
                      // the press is released without a drag.
                      onPointerDown={() => setDragArmedIdx(index)}
                      onPointerUp={() => setDragArmedIdx((v) => (v === index ? null : v))}
                      aria-label="Drag to reorder prize"
                      title="Drag to reorder (or use the ▲ ▼ buttons)"
                      className="shrink-0 cursor-grab touch-none select-none rounded px-1 text-muted transition hover:text-ink active:cursor-grabbing"
                    >
                      ⠿
                    </button>
                    <div className="flex shrink-0 flex-col">
                      <button
                        type="button"
                        onClick={() => movePrize(index, index - 1)}
                        disabled={index === 0}
                        className="grid h-6 min-w-6 place-items-center rounded text-xs leading-none text-muted transition hover:bg-white/5 hover:text-ink disabled:opacity-30"
                        aria-label="Move prize up"
                        title="Move up"
                      >
                        ▲
                      </button>
                      <button
                        type="button"
                        onClick={() => movePrize(index, index + 1)}
                        disabled={index === wheel.prizes.length - 1}
                        className="grid h-6 min-w-6 place-items-center rounded text-xs leading-none text-muted transition hover:bg-white/5 hover:text-ink disabled:opacity-30"
                        aria-label="Move prize down"
                        title="Move down"
                      >
                        ▼
                      </button>
                    </div>
                    <input
                      aria-label="Emoji"
                      className="ff-input w-11 shrink-0 text-center text-base"
                      value={p.emoji ?? ""}
                      onChange={(e) => updatePrize(p.id, { emoji: e.target.value })}
                    />
                    <input
                      aria-label="Prize name"
                      className="ff-input min-w-0 flex-1"
                      value={p.label}
                      onChange={(e) => updatePrize(p.id, { label: e.target.value })}
                    />
                    <button
                      type="button"
                      onClick={() => savePrizeToLibrary(p)}
                      className="shrink-0 rounded-lg px-2 py-2 text-muted transition hover:bg-white/5 hover:text-[var(--brand)]"
                      title="Save this prize to your library"
                      aria-label="Save prize to library"
                    >
                      ★
                    </button>
                    <button
                      type="button"
                      onClick={() => duplicateAt(index)}
                      className="shrink-0 rounded-lg px-2 py-2 text-muted transition hover:bg-white/5 hover:text-ink"
                      title="Duplicate prize"
                      aria-label="Duplicate prize"
                    >
                      ⧉
                    </button>
                    <button
                      type="button"
                      onClick={() => removePrize(p.id)}
                      className="shrink-0 rounded-lg px-2 py-2 text-muted transition hover:bg-white/5 hover:text-red-400"
                      title="Remove prize"
                      aria-label="Remove prize"
                    >
                      ✕
                    </button>
                  </div>

                  <div className="mt-2 flex flex-wrap gap-1">
                    {EMOJI_SUGGESTIONS.map((emo) => (
                      <button
                        key={emo}
                        type="button"
                        onClick={() => updatePrize(p.id, { emoji: emo })}
                        className="rounded-md border border-line px-1.5 py-0.5 text-sm transition hover:bg-white/5"
                        aria-label={`Use emoji ${emo}`}
                        title={`Use ${emo}`}
                      >
                        {emo}
                      </button>
                    ))}
                  </div>
                  <p className="mt-1 text-[11px] text-muted">Tip: type or paste any emoji.</p>

                  <Field label="Cost (your cost)">
                    <input
                      type="number"
                      min={0}
                      step="0.01"
                      placeholder="0.00"
                      className="ff-input tnum w-full text-right"
                      value={p.cost == null ? "" : (p.cost ?? 0) / 100}
                      onChange={(e) =>
                        updatePrize(p.id, {
                          cost:
                            e.target.value === ""
                              ? null
                              : Math.round(Number(e.target.value) * 100),
                        })
                      }
                    />
                  </Field>

                  <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <Field label="Rarity">
                      <select
                        className="ff-input w-full"
                        value={p.rarity}
                        onChange={(e) => changeRarity(p, e.target.value as Rarity)}
                      >
                        {RARITY_ORDER.map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Tickets">
                      <input
                        type="number"
                        min={0}
                        className="ff-input tnum w-full text-right"
                        value={p.weight}
                        onChange={(e) => updatePrize(p.id, { weight: Number(e.target.value) })}
                      />
                    </Field>
                    <Field label="Stock">
                      <input
                        type="number"
                        min={0}
                        placeholder="∞"
                        className="ff-input tnum w-full text-right"
                        value={p.stock ?? ""}
                        onChange={(e) =>
                          updatePrize(p.id, {
                            stock: e.target.value === "" ? null : Number(e.target.value),
                          })
                        }
                      />
                    </Field>
                    <div className="flex min-w-0 flex-col gap-1">
                      <span className="text-xs font-semibold uppercase tracking-wider text-muted">
                        Odds
                      </span>
                      {/* Match .ff-input's box (padding + border) so the % sits on
                          the same baseline as the Rarity/Tickets/Stock inputs. */}
                      <span className="tnum flex items-center justify-end border border-transparent px-[0.7rem] py-[0.5rem] text-[0.9rem] font-mono font-semibold text-[var(--brand)]">
                        {((odds.get(p.id) ?? 0) * 100).toFixed(1)}%
                      </span>
                    </div>
                  </div>

                  <Field label="Color">
                    <div className="flex items-center gap-2">
                      <input
                        type="color"
                        className="h-9 w-12 shrink-0 rounded border border-line bg-transparent"
                        value={swatch}
                        onChange={(e) => updatePrize(p.id, { color: e.target.value })}
                        aria-label="Prize color"
                      />
                      <input
                        className="ff-input min-w-0 flex-1"
                        value={swatch}
                        onChange={(e) => updatePrize(p.id, { color: e.target.value })}
                        aria-label="Prize color hex"
                      />
                      <button
                        type="button"
                        onClick={() => updatePrize(p.id, { color: RARITY_COLORS[p.rarity] })}
                        className="shrink-0 text-xs font-semibold text-muted underline-offset-2 transition hover:text-ink hover:underline"
                      >
                        Reset to rarity color
                      </button>
                    </div>
                  </Field>

                  <Field label="Description (shown on win)">
                    <textarea
                      className="ff-input w-full"
                      rows={2}
                      value={p.description ?? ""}
                      onChange={(e) => updatePrize(p.id, { description: e.target.value })}
                    />
                  </Field>
                </div>
              );
            })}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={addPrize}
              className="rounded-lg border border-line px-4 py-2 text-sm font-semibold text-ink transition hover:bg-white/5"
            >
              + Add prize
            </button>
            {wheel.prizes.length > 0 && (
              <button
                type="button"
                onClick={() => setWheel({ ...wheel, prizes: balanceOdds(wheel.prizes) })}
                className="rounded-lg border border-line px-4 py-2 text-sm font-semibold text-ink transition hover:bg-white/5"
              >
                Balance odds
              </button>
            )}
          </div>
        </div>

        <div className="flex flex-col items-center gap-4 self-start rounded-2xl border border-line bg-surface p-6">
          <p className="text-xs font-medium uppercase tracking-wider text-muted">Live preview</p>
          <Wheel
            prizes={wheel.prizes}
            brandColor={wheel.brandColor ?? "#ec4899"}
            labelColor={wheel.labelColor}
            labelSize={wheel.labelSize}
            result={null}
            size={280}
          />
          <p className="text-center text-xs text-muted">
            Think of <strong>tickets</strong> like a raffle: a prize&rsquo;s chance is its
            tickets ÷ all tickets. The <span className="text-[var(--brand)]">%</span> next to
            each prize is its real odds — it updates live as you add prizes or change tickets.
            Pick a rarity and we fill sensible tickets for you.
          </p>
        </div>
      </div>

      {/* Library lives at the bottom: you build the wheel first, then optionally
          save it as a template or pull reusable prizes/templates in. */}
      <div className="mt-6 rounded-xl border border-line bg-surface">
        <button
          type="button"
          onClick={() => setShowLibrary((v) => !v)}
          aria-expanded={showLibrary}
          className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
        >
          <span className="font-bold text-ink">📚 Prize &amp; wheel library</span>
          <span className="text-sm font-semibold text-muted">
            {showLibrary ? "Hide ▲" : "Save / reuse prizes & templates ▼"}
          </span>
        </button>
        {showLibrary && (
          <div className="border-t border-line px-4 py-4">
            <TemplateLibrary
              onApplyWheelTemplate={applyWheelTemplate}
              onSaveCurrentWheelAsTemplate={saveCurrentWheelAsTemplate}
              onApplyPrizeTemplate={applyPrizeTemplate}
              onSaveCurrentPrizesToLibrary={saveCurrentPrizesToLibrary}
              refreshSignal={librarySignal}
            />
          </div>
        )}
      </div>
    </div>
  );
}
