"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Dispatch, ReactNode, SetStateAction } from "react";
import GamePreview from "./GamePreview";
import GameSettingsEditor from "./GameSettingsEditor";
import { gameSaveFeatureAllowed, editableGamePayload, gameDraftError, gameRefusalMessage, type CreatorGameWheel } from "./gameEditor";
import { useGameFeatures } from "./useGameFeatures";
import { useCreatorDraft } from "./CreatorDrafts";
import { prizeOdds } from "@/lib/games/wheel/engine";
import { showsStock } from "@/lib/games/wheel/publicView";
import {
  RARITY_COLORS,
  RARITY_LABEL,
  RARITY_ORDER,
  type Prize,
  type Rarity,
  type WheelConfig,
} from "@/lib/games/wheel/types";
import type { PrizeTemplate } from "@/lib/data/types";
import { useToast } from "@/components/ui/Toast";
import { OddsBar } from "@/components/dashboard/OddsBar";
import WheelSwitcher from "@/components/dashboard/WheelSwitcher";
import TemplateLibrary from "@/components/dashboard/TemplateLibrary";
import { wheelSaveErrorMessage } from "@/components/dashboard/wheelSaveErrors";
import DiscardChangesDialog from "@/components/dashboard/DiscardChangesDialog";
import PrizeDeliveryEditor from "@/components/dashboard/PrizeDeliveryEditor";
import { applyPrizeDelivery } from "@/components/dashboard/prizeDeliveryState";
import type { PrizeDeliveryView } from "@/lib/rewards/config";
import {
  EMOJI_SUGGESTIONS,
  balanceOdds,
  duplicatePrize,
  newPrize,
  reorder,
  RARITY_DEFAULT_WEIGHT,
} from "@/components/dashboard/editorHelpers";
import {
  MAX_PRIZE_LABEL,
  MIN_WHEEL_PRIZES,
  colorFromInput,
  normalizeHex,
  validateWheelDraft,
  ZERO_TICKETS_NOTE,
  type ValidationIssue,
} from "@/lib/games/wheel/validate";

// 24×24 stroke paths (Command Center prototype line icons).
const P = {
  plus: "M12 5v14M5 12h14",
  grip: "M9 6h.01M9 12h.01M9 18h.01M15 6h.01M15 12h.01M15 18h.01",
  star: "M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 17l-5.2 2.6 1-5.8L3.5 9.7l5.9-.9Z",
  copy: "M8 8h12v12H8zM16 8V4H4v12h4",
  x: "M18 6 6 18M6 6l12 12",
  gift: "M20 12v10H4V12M2 7h20v5H2zM12 22V7M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7ZM12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7Z",
  book: "M4 19.5A2.5 2.5 0 0 1 6.5 17H20M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z",
  chevron: "m6 9 6 6 6-6",
  up: "m18 15-6-6-6 6",
  down: "m6 9 6 6 6-6",
  check: "M20 6 9 17l-5-5",
};

function Glyph({
  d,
  size = 16,
  strokeWidth = 1.8,
  className = "",
}: {
  d: string;
  size?: number;
  strokeWidth?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={`shrink-0 ${className}`}
    >
      <path d={d} />
    </svg>
  );
}

const raised = "border border-[var(--hair)] [background:var(--s1)] shadow-[var(--lift)]";
const cap = "text-[11px] font-semibold uppercase tracking-[0.05em] text-muted";
const capSm = "text-[10px] font-semibold uppercase tracking-[0.05em] text-muted";
const iconBtn =
  "grid h-[34px] w-[34px] shrink-0 place-items-center rounded-[9px] text-muted transition-colors hover:bg-[color-mix(in_oklab,var(--color-ink)_6%,transparent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]";
const secondaryBtn =
  "inline-flex min-h-[38px] items-center gap-1.5 rounded-[10px] border border-[var(--hair)] px-4 text-[13.5px] font-semibold text-ink transition-colors hover:bg-[color-mix(in_oklab,var(--color-ink)_5%,transparent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]";
// Native color input drawn as a plain swatch (the hex field next to it is the
// typed source of truth; a half-typed hex never reaches the picker).
const swatchInput =
  "h-9 w-[46px] shrink-0 cursor-pointer rounded-lg border border-[var(--hair)] bg-transparent p-0 [&::-webkit-color-swatch-wrapper]:p-0.5 [&::-webkit-color-swatch]:rounded-[6px] [&::-webkit-color-swatch]:border-0";

// DOM ids for validated fields and their error text, derived from the
// validation issue key ("brandColor", "prize:<id>:weight", ...).
function fieldId(key: string): string {
  return "wf-" + key.replace(/[^A-Za-z0-9_-]/g, "-");
}
function errId(key: string): string {
  return fieldId(key) + "-err";
}
const MIN_PRIZES_NOTE_ID = "wf-min-prizes-note";
const SAVE_SUMMARY_ID = "wf-save-summary";

function FieldError({ id, message }: { id: string; message?: string | null }) {
  if (!message) return null;
  return (
    <p id={id} className="mt-1 text-[12px] leading-snug text-[#fca5a5]">
      {message}
    </p>
  );
}

function Lbl({ label, children, small }: { label: string; children: ReactNode; small?: boolean }) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5">
      <span className={small ? capSm : cap}>{label}</span>
      {children}
    </label>
  );
}

// ---------------------------------------------------------------------------
// Wheel editor
// ---------------------------------------------------------------------------
export default function WheelEditor({
  wheel,
  setWheel,
  savedJson,
  setSavedJson,
  editingWheelId,
  setEditingWheelId,
  onWheelMutated,
  onDeliveryDraftChange,
  onDeliveryPendingChange,
}: {
  wheel: WheelConfig;
  setWheel: Dispatch<SetStateAction<WheelConfig>>;
  /** JSON of the last saved/loaded config. Lifted with `wheel` so the dirty
   *  state survives leaving and re-entering the Wheels section. */
  savedJson: string;
  setSavedJson: Dispatch<SetStateAction<string>>;
  editingWheelId: string | null;
  setEditingWheelId: (id: string | null) => void;
  /** Notify the parent (refreshes overview, incl. the wheelBuilt onboarding signal). */
  onWheelMutated: () => void;
  /** Navigation guard: delivery drafts stay out of the wheel JSON. */
  onDeliveryDraftChange?: (dirty: boolean) => void;
  onDeliveryPendingChange?: (pending: boolean) => void;
}) {
  const odds = useMemo(() => prizeOdds(wheel), [wheel]);
  // OddsBar expects percentages (0–100); prizeOdds returns fractions (0–1).
  const oddsPct = useMemo(() => {
    const m = new Map<string, number>();
    for (const [id, f] of odds) m.set(id, f * 100);
    return m;
  }, [odds]);
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const capabilities = useGameFeatures();
  const gameWheel = wheel as CreatorGameWheel;
  const featureBlocked = !gameSaveFeatureAllowed(gameWheel, savedJson, capabilities.features);
  useCreatorDraft("game-editor", "a game save", false, saving);
  const [justSaved, setJustSaved] = useState(false);
  const [showLibrary, setShowLibrary] = useState(false);
  // Per-prize "More" disclosure (emoji picks), keyed by prize id.
  const [moreOpen, setMoreOpen] = useState<Record<string, boolean>>({});
  // #9: bumped after a prize is saved to the library (★) so TemplateLibrary
  // refetches and the favorite shows up immediately — no page refresh.
  const [librarySignal, setLibrarySignal] = useState(0);
  const dirty = JSON.stringify(wheel) !== savedJson;
  const savedGame = useMemo(() => {
    try {
      const value = JSON.parse(savedJson) as CreatorGameWheel;
      return { id: value.id, title: value.title, prizeCount: value.prizes.length, gameKind: value.gameKind, gameReady: value.gameReady };
    } catch { return undefined; }
  }, [savedJson]);
  const [deliveryDrafts, setDeliveryDrafts] = useState<Record<string, boolean>>({});
  const [deliveryRequests, setDeliveryRequests] = useState<Record<string, boolean>>({});
  const hasDeliveryDrafts = Object.values(deliveryDrafts).some(Boolean);
  const deliveryPending = Object.values(deliveryRequests).some(Boolean);
  const savedPrizeIds = useMemo(() => {
    try {
      const saved = JSON.parse(savedJson) as WheelConfig;
      return saved.id === wheel.id ? new Set(saved.prizes.map((p) => p.id)) : new Set<string>();
    } catch { return new Set<string>(); }
  }, [savedJson, wheel.id]);
  const deliveryDirtyChanged = useCallback((id: string, value: boolean) => {
    setDeliveryDrafts((current) => current[id] === value ? current : { ...current, [id]: value });
  }, []);
  const deliveryBusyChanged = useCallback((id: string, value: boolean) => {
    setDeliveryRequests((current) => current[id] === value ? current : { ...current, [id]: value });
  }, []);
  useEffect(() => {
    onDeliveryDraftChange?.(hasDeliveryDrafts);
    return () => onDeliveryDraftChange?.(false);
  }, [hasDeliveryDrafts, onDeliveryDraftChange]);
  useEffect(() => {
    onDeliveryPendingChange?.(deliveryPending);
    return () => onDeliveryPendingChange?.(false);
  }, [deliveryPending, onDeliveryPendingChange]);
  const deliverySaved = useCallback((view: PrizeDeliveryView) => {
    setWheel((current) => applyPrizeDelivery(current, view));
    setSavedJson((current) => {
      try { return JSON.stringify(applyPrizeDelivery(JSON.parse(current) as WheelConfig, view)); }
      catch { return current; }
    });
    onWheelMutated();
  }, [setWheel, setSavedJson, onWheelMutated]);
  // A wheel switch requested while there are unsaved edits waits here for the
  // in-app dialog's answer (the browser's own confirm() is not accessible).
  const [pendingSwitch, setPendingSwitch] = useState<{
    id: string;
    resolve: (discard: boolean) => void;
  } | null>(null);
  // Leaving the page with unsaved edits is guarded by DashboardClient (it owns
  // the saved snapshot), so the guard holds while another section is open.
  const validation = useMemo(() => {
    const base = validateWheelDraft(wheel);
    const gameError = gameDraftError(wheel as CreatorGameWheel);
    return { ...base, issues: [...(gameError ? [{ key: "gameSettings", message: gameError }] : []), ...base.issues] };
  }, [wheel]);
  // Errors show for a field once it has been left (blur) or after a save
  // attempt, so a half-typed hex isn't flagged mid-keystroke.
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [submitted, setSubmitted] = useState(false);
  const touch = (key: string) => setTouched((t) => (t[key] ? t : { ...t, [key]: true }));
  const shown = (key: string) => submitted || touched[key] === true;
  const showErrors = submitted && validation.issues.length > 0;

  // Props for a validated input: stable id, aria-invalid + aria-describedby
  // while its error is showing, and blur marks it touched.
  function fieldProps(key: string, message: string | undefined, onBlur?: () => void) {
    const on = !!message && shown(key);
    return {
      id: fieldId(key),
      "aria-invalid": on ? (true as const) : undefined,
      "aria-describedby": on ? errId(key) : undefined,
      onBlur: () => {
        touch(key);
        onBlur?.();
      },
    };
  }
  function errFor(key: string, message: string | undefined) {
    return message && shown(key) ? message : null;
  }

  function issueTargetId(issue: ValidationIssue): string {
    if (issue.key === "gameSettings") return "wf-game-settings";
    if (issue.key === "prizeCount") {
      return wheel.prizes.length === 0 ? "wf-add-first-prize" : "wf-add-prize";
    }
    return fieldId(issue.key);
  }
  function focusFirstIssue() {
    const first = validation.issues[0];
    if (!first) return;
    // After the render that turns the error states on.
    requestAnimationFrame(() => {
      const el = document.getElementById(issueTargetId(first));
      el?.scrollIntoView({ block: "center", behavior: "smooth" });
      el?.focus({ preventScroll: true });
    });
  }
  function attemptSave() {
    if (deliveryPending || saving || featureBlocked) return;
    if (validation.issues.length > 0) {
      setSubmitted(true);
      focusFirstIssue();
      return;
    }
    void save();
  }

  async function save() {
    setSaving(true);
    setSaveError("");
    setJustSaved(false);
    try {
      const res = await fetch("/api/wheel", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wheel: editableGamePayload(gameWheel) }),
      });
      const data = await res.json();
      if (res.ok && data.wheel) {
        setWheel(data.wheel);
        setSavedJson(JSON.stringify(data.wheel));
        setSubmitted(false);
        setTouched({});
        setEditingWheelId(data.wheel.id);
        setJustSaved(true);
        setTimeout(() => setJustSaved(false), 2000);
        // Refresh the onboarding "wheelBuilt" signal now that this wheel saved.
        onWheelMutated();
      } else {
        const message = gameRefusalMessage(data.error) ?? wheelSaveErrorMessage(data.error);
        setSaveError(message);
        toast(message, { tone: "error" });
      }
    } catch {
      setSaveError("The game save couldn't be confirmed. Your draft is still here; refresh the saved game before relying on the changes.");
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
  async function loadWheel(id: string): Promise<boolean> {
    if (deliveryPending) {
      toast("Wait for delivery to finish saving before changing games.", { tone: "info" });
      return false;
    }
    // Switching wheels replaces the editor state: don't silently drop edits.
    if (dirty || hasDeliveryDrafts) {
      // Re-opening the wheel already in the editor (its chip) must not reload
      // it over the unsaved edits: it is already open.
      if (id === wheel.id) return true;
      const discard = await new Promise<boolean>((resolve) => setPendingSwitch({ id, resolve }));
      if (!discard) return false;
    }
    try {
    const res = await fetch(`/api/wheels/${id}`, { cache: "no-store" });
    if (!res.ok) {
      toast("Couldn't open that game.", { tone: "error" });
      return false;
    }
    const data = (await res.json()) as { wheel?: WheelConfig };
    if (!data.wheel) {
      toast("Couldn't open that game.", { tone: "error" });
      return false;
    }
    setWheel(data.wheel);
    setSavedJson(JSON.stringify(data.wheel));
    setEditingWheelId(data.wheel.id);
    setSubmitted(false);
    setTouched({});
    return true;
    } catch {
      toast("That game couldn't load. Your current draft is still here.", { tone: "error" });
      return false;
    }
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
    if (wheel.prizes.length <= MIN_WHEEL_PRIZES) return;
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

  const canRemove = wheel.prizes.length > MIN_WHEEL_PRIZES;
  // Below the list: the min-prizes error (too few to save) or, at exactly the
  // minimum, why every Remove button is off. Remove buttons point here.
  const prizeCountMsg =
    validation.prizeCount && (wheel.prizes.length > 0 || submitted) ? validation.prizeCount : null;
  const minNote = prizeCountMsg
    ? null
    : wheel.prizes.length === MIN_WHEEL_PRIZES
      ? `Remove is off: a wheel needs at least ${MIN_WHEEL_PRIZES} prizes. Add one first to swap a prize out.`
      : null;

  return (
    <div className="flex flex-col">
      {pendingSwitch && (
        <DiscardChangesDialog
          what="this game"
          onKeep={() => {
            pendingSwitch.resolve(false);
            setPendingSwitch(null);
          }}
          onDiscard={() => {
            pendingSwitch.resolve(true);
            setPendingSwitch(null);
          }}
        />
      )}
      <div className="mb-5">
        <WheelSwitcher
          currentWheelId={editingWheelId}
          onEdit={loadWheel}
          onChanged={onWheelMutated}
          features={capabilities.features}
          savedGame={savedGame}
        />
        {capabilities.error && <p role="alert" className="mt-2 text-xs text-amber-200">{capabilities.error} <button type="button" onClick={() => void capabilities.reload()} className="font-semibold underline">Check permissions again</button></p>}
        {featureBlocked && <p role="status" className="mt-2 text-xs text-amber-200">This game type is not enabled for your account. Existing fan links and edits to their current type keep working. Ask your admin to enable this type before changing to it or creating another.</p>}
      </div>

      {/* Save bar. Top of the editor on desktop; on phones it moves to the end
          of the flow and sticks to the bottom edge so Save is always in reach. */}
      <div
        className={`z-20 flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-3 transition-colors duration-200 max-lg:sticky max-lg:bottom-[calc(var(--ff-bottom-offset,0px)+0.5rem)] max-lg:order-last max-lg:mt-5 lg:mb-5 ${
          dirty
            ? "border-[color-mix(in_oklab,#f59e0b_30%,#1f1b27)] bg-[color-mix(in_oklab,#f59e0b_6%,#16131c)] shadow-[var(--lift)]"
            : raised
        }`}
      >
        <p className="flex items-center gap-2 text-[13.5px]" role="status">
          {dirty || hasDeliveryDrafts ? (
            <>
              <span aria-hidden="true" className="h-2 w-2 rounded-full bg-[#f59e0b]" />
              <span className="text-[#fcd34d]">{!dirty && hasDeliveryDrafts ? "Unsaved delivery changes · save them in the prize card" : "Unsaved changes"}</span>
            </>
          ) : justSaved ? (
            <>
              <Glyph d={P.check} size={14} strokeWidth={2.4} className="text-[#86efac]" />
              <span className="text-[#86efac]">Saved</span>
            </>
          ) : (
            <span className="text-muted">All changes saved</span>
          )}
        </p>
        <button
          onClick={attemptSave}
          disabled={saving || deliveryPending || featureBlocked || !dirty}
          aria-describedby={showErrors ? SAVE_SUMMARY_ID : undefined}
          className="btn-brand min-h-[38px] rounded-[9px] px-5 text-[13.5px] font-bold"
        >
          {saving ? "Saving…" : "Save game"}
        </button>
        <div id={SAVE_SUMMARY_ID} role="alert" className="w-full empty:hidden">
          {saveError && <p className="text-sm text-amber-200">{saveError}</p>}
          {showErrors && (
            <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[13px] text-[#fca5a5]">
              <span>
                {validation.issues.length === 1
                  ? "Can't save yet: 1 thing to fix."
                  : `Can't save yet: ${validation.issues.length} things to fix.`}{" "}
                {validation.issues[0].message}
              </span>
              <button
                type="button"
                onClick={focusFirstIssue}
                className="font-semibold text-ink underline underline-offset-2 hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
              >
                Go to it
              </button>
            </p>
          )}
        </div>
      </div>

      <div className="grid gap-7 lg:grid-cols-[minmax(0,1fr)_340px]">
        {/* Live preview. First in the DOM so it leads on phones (README mobile),
            right column on desktop. */}
        <div
          className={`flex flex-col items-center gap-4 self-start rounded-[18px] p-4 sm:p-6 lg:sticky lg:top-24 lg:order-2 ${raised}`}
        >
          <p className={cap}>Live preview</p>
          <GamePreview wheel={gameWheel} />
          <p className="text-center text-xs text-muted text-pretty">
            A prize&rsquo;s chance is its <strong className="text-ink">tickets ÷ all tickets</strong>.
            The <span className="text-brand">%</span> updates live. Out-of-stock prizes leave the
            pool and the rest renormalize.
          </p>
        </div>

        <div className="min-w-0 lg:order-1">
          <GameSettingsEditor wheel={gameWheel} features={capabilities.features} disabled={saving || deliveryPending} onChange={(patch) => { setSaveError(""); setWheel((current) => ({ ...current, ...patch })); }} />
          <fieldset disabled={saving || featureBlocked} className="min-w-0">
          <legend className="sr-only">Game appearance and prizes</legend>
          <div className="grid gap-3.5 sm:grid-cols-2">
            <Lbl label="Title">
              <input
                className="ff-input w-full"
                data-testid="wheel-title-input"
                value={wheel.title}
                onChange={(e) => setWheel({ ...wheel, title: e.target.value })}
              />
            </Lbl>
            <div className="min-w-0">
              <Lbl label="Brand color">
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    className={swatchInput}
                    value={normalizeHex(wheel.brandColor) ?? "#ec4899"}
                    onChange={(e) => setWheel({ ...wheel, brandColor: e.target.value })}
                    aria-label="Brand color picker"
                  />
                  <input
                    className="ff-input tnum w-full min-w-0 flex-1"
                    value={wheel.brandColor ?? ""}
                    placeholder="#ec4899"
                    spellCheck={false}
                    autoComplete="off"
                    onChange={(e) => setWheel({ ...wheel, brandColor: e.target.value })}
                    aria-label="Brand color hex"
                    {...fieldProps("brandColor", validation.brandColor, () => {
                      const n = normalizeHex(wheel.brandColor);
                      if (n && n !== wheel.brandColor) setWheel({ ...wheel, brandColor: n });
                    })}
                  />
                </div>
              </Lbl>
              <FieldError id={errId("brandColor")} message={errFor("brandColor", validation.brandColor)} />
            </div>
          </div>

          {/* Wheel style: label color (#11), label size and subtitle. Not drawn in
              the design; kept as a compact row under Title/Brand. */}
          <div className="mt-3.5 grid gap-3.5 sm:grid-cols-[1fr_auto_1fr]">
            <div className="min-w-0">
              <Lbl label="Label text color">
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    className={swatchInput}
                    value={normalizeHex(wheel.labelColor) ?? "#ffffff"}
                    onChange={(e) => setWheel({ ...wheel, labelColor: e.target.value })}
                    aria-label="Prize label color"
                  />
                  <input
                    className="ff-input tnum min-w-0 flex-1"
                    value={wheel.labelColor ?? ""}
                    placeholder="Auto"
                    spellCheck={false}
                    autoComplete="off"
                    onChange={(e) =>
                      setWheel({
                        ...wheel,
                        labelColor: colorFromInput(e.target.value),
                      })
                    }
                    aria-label="Prize label color hex"
                    {...fieldProps("labelColor", validation.labelColor, () => {
                      const n = normalizeHex(wheel.labelColor);
                      if (n && n !== wheel.labelColor) setWheel({ ...wheel, labelColor: n });
                    })}
                  />
                  <button
                    type="button"
                    onClick={() => setWheel({ ...wheel, labelColor: undefined })}
                    disabled={wheel.labelColor == null}
                    className="shrink-0 text-[11px] font-semibold text-muted underline-offset-2 transition hover:text-ink hover:underline disabled:opacity-40"
                  >
                    Auto
                  </button>
                </div>
              </Lbl>
              <FieldError id={errId("labelColor")} message={errFor("labelColor", validation.labelColor)} />
            </div>
            <Lbl label="Label size">
              <select
                className="ff-input w-full sm:w-36"
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
                <option value="">Auto (fit)</option>
                <option value="s">Small</option>
                <option value="l">Large</option>
                <option value="xl">Extra large</option>
              </select>
            </Lbl>
            <Lbl label="Subtitle">
              <input
                className="ff-input w-full"
                value={wheel.subtitle ?? ""}
                placeholder="Shown under the title on the fan page"
                onChange={(e) => setWheel({ ...wheel, subtitle: e.target.value })}
              />
            </Lbl>
          </div>

          {/* RM-2: per-wheel "Show stock to fans". Saved with the wheel; off,
              the fan-safe projection sends fans no count at all. */}
          <div className={`mt-3.5 flex items-center justify-between gap-3 rounded-xl p-3 ${raised}`}>
            <span className="min-w-0">
              <span id="wf-show-stock-label" className="block text-[13.5px] font-semibold text-ink">
                Show stock to fans
              </span>
              <span id="wf-show-stock-hint" className="mt-0.5 block text-[12px] leading-snug text-muted text-pretty">
                Limited prizes show how many are left (&ldquo;3 left&rdquo;) on your fan and public
                pages. Off hides the count; a prize that runs out still shows as claimed.
              </span>
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={showsStock(wheel)}
              aria-labelledby="wf-show-stock-label"
              aria-describedby="wf-show-stock-hint"
              data-testid="show-stock-switch"
              onClick={() => setWheel({ ...wheel, showStock: !showsStock(wheel) })}
              className="shrink-0 rounded-full border border-line p-0.5 transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand)]"
            >
              <span
                className={`relative block h-6 w-11 rounded-full transition-colors ${showsStock(wheel) ? "bg-[var(--brand)]" : "bg-line"}`}
              >
                <span
                  className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white transition-transform ${showsStock(wheel) ? "translate-x-5" : "translate-x-0"}`}
                />
              </span>
            </button>
          </div>

          <div className={`mt-5 rounded-xl p-3 ${raised}`}>
            <span className={cap}>Odds</span>
            <div className="mt-2">
              <OddsBar prizes={wheel.prizes} odds={oddsPct} />
            </div>
          </div>

          {/* #7: brand-new wheels start with zero prizes — show a friendly
              empty state + "Add your first prize" instead of a bare list. */}
          {wheel.prizes.length === 0 && (
            <div className="mt-4 flex flex-col items-center gap-2.5 rounded-[14px] border border-dashed border-[var(--hair)] px-6 py-9 text-center">
              <span className="grid h-11 w-11 place-items-center rounded-xl bg-[color-mix(in_oklab,var(--brand)_12%,transparent)] text-brand">
                <Glyph d={P.gift} size={20} strokeWidth={1.6} />
              </span>
              <p className="text-[14.5px] font-bold text-ink">No prizes yet</p>
              <p className="max-w-[300px] text-[13px] text-muted text-pretty">
                Add your first prize to start building the wheel. Set its rarity, tickets and
                odds — or pull one from your library below.
              </p>
              <button
                type="button"
                id="wf-add-first-prize"
                onClick={addPrize}
                aria-describedby={prizeCountMsg ? MIN_PRIZES_NOTE_ID : undefined}
                className="btn-brand mt-1 inline-flex min-h-[38px] items-center gap-1.5 rounded-[10px] px-4 text-[13.5px] font-bold"
              >
                <Glyph d={P.plus} size={15} strokeWidth={2.2} />
                Add your first prize
              </button>
            </div>
          )}

          <div className="mt-4 grid grid-cols-1 gap-2.5 2xl:grid-cols-2">
            {wheel.prizes.map((p, index) => {
              const swatch = p.color ?? RARITY_COLORS[p.rarity];
              const rarityColor = RARITY_COLORS[p.rarity];
              const pct = (odds.get(p.id) ?? 0) * 100;
              const outOfStock = p.stock === 0;
              const more = moreOpen[p.id] ?? false;
              const pe = validation.prizes[p.id] ?? {};
              const k = (f: string) => `prize:${p.id}:${f}`;
              const numberErrors = (["weight", "stock"] as const).filter((f) =>
                errFor(k(f), pe[f]),
              );
              const weightErrOn = !!errFor(k("weight"), pe.weight);
              // A deliberate 0 is allowed; say what it means instead of erroring.
              const zeroNote = p.weight === 0 && !pe.weight;
              const zeroNoteId = fieldId(k("weight")) + "-note";
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
                  className={`relative rounded-[13px] p-3.5 transition-[box-shadow,opacity,transform] duration-150 ${raised} ${
                    dragIdx === index ? "scale-[0.99] opacity-50" : ""
                  } ${
                    dragOverIdx === index
                      ? "shadow-[0_0_0_2px_var(--brand)]"
                      : ""
                  }`}
                >
                  {/* Corner reorder cluster: ▲▼ (keyboard path) + the drag grip. */}
                  <div className="absolute right-2.5 top-2.5 z-[1] flex items-center gap-0.5">
                    <div className="flex flex-col">
                      <button
                        type="button"
                        onClick={() => movePrize(index, index - 1)}
                        disabled={index === 0}
                        className="grid h-[13px] w-5 place-items-center rounded-[4px] text-muted transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] disabled:opacity-30"
                        aria-label="Move prize up"
                        title="Move up"
                      >
                        <Glyph d={P.up} size={12} strokeWidth={2.4} />
                      </button>
                      <button
                        type="button"
                        onClick={() => movePrize(index, index + 1)}
                        disabled={index === wheel.prizes.length - 1}
                        className="grid h-[13px] w-5 place-items-center rounded-[4px] text-muted transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] disabled:opacity-30"
                        aria-label="Move prize down"
                        title="Move down"
                      >
                        <Glyph d={P.down} size={12} strokeWidth={2.4} />
                      </button>
                    </div>
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
                      className="grid h-[26px] w-[26px] cursor-grab touch-none select-none place-items-center rounded-[7px] bg-[color-mix(in_oklab,var(--color-ink)_8%,transparent)] text-muted transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] active:cursor-grabbing"
                    >
                      <Glyph d={P.grip} size={14} />
                    </button>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 pr-[60px]">
                    <div className="flex min-w-[170px] flex-1 items-center gap-2">
                      <input
                        aria-label="Emoji"
                        className="ff-input w-[42px] shrink-0 text-center text-base"
                        value={p.emoji ?? ""}
                        onChange={(e) => updatePrize(p.id, { emoji: e.target.value })}
                      />
                      <input
                        aria-label="Prize name"
                        className="ff-input min-w-0 flex-1"
                        value={p.label}
                        maxLength={MAX_PRIZE_LABEL}
                        onChange={(e) => updatePrize(p.id, { label: e.target.value })}
                        {...fieldProps(k("label"), pe.label)}
                      />
                    </div>
                    <div className="flex items-center gap-0.5">
                      {/* Rarity pill: a real <select> (keyboard + screen readers +
                          e2e selectOption) drawn as the design's tinted pill. The
                          change handler is changeRarity, which re-fills tickets. */}
                      <select
                        className="ff-input ff-pill mr-1.5"
                        value={p.rarity}
                        onChange={(e) => changeRarity(p, e.target.value as Rarity)}
                        aria-label="Rarity"
                        title="Change rarity (re-fills tickets from the rarity default)"
                        style={{
                          backgroundColor: `color-mix(in oklab, ${rarityColor} 16%, transparent)`,
                          color: rarityColor,
                        }}
                      >
                        {RARITY_ORDER.map((r) => (
                          <option key={r} value={r}>
                            {RARITY_LABEL[r]}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        onClick={() => savePrizeToLibrary(p)}
                        className={`${iconBtn} hover:text-brand`}
                        title="Save this prize to your library"
                        aria-label="Save prize to library"
                      >
                        <Glyph d={P.star} strokeWidth={1.6} />
                      </button>
                      <button
                        type="button"
                        onClick={() => duplicateAt(index)}
                        className={`${iconBtn} hover:text-ink`}
                        title="Duplicate prize"
                        aria-label="Duplicate prize"
                      >
                        <Glyph d={P.copy} size={15} strokeWidth={1.7} />
                      </button>
                      <button
                        type="button"
                        onClick={() => removePrize(p.id)}
                        // aria-disabled (not disabled) keeps it focusable and
                        // hoverable, so the reason can be read and seen.
                        aria-disabled={canRemove ? undefined : true}
                        aria-describedby={canRemove ? undefined : MIN_PRIZES_NOTE_ID}
                        className={`${iconBtn} hover:text-[#fca5a5] aria-disabled:cursor-not-allowed aria-disabled:opacity-35 aria-disabled:hover:bg-transparent aria-disabled:hover:text-muted`}
                        title={
                          canRemove
                            ? "Remove prize"
                            : `A wheel needs at least ${MIN_WHEEL_PRIZES} prizes`
                        }
                        aria-label="Remove prize"
                      >
                        <Glyph d={P.x} size={15} strokeWidth={1.9} />
                      </button>
                    </div>
                  </div>
                  <FieldError id={errId(k("label"))} message={errFor(k("label"), pe.label)} />
                  <label className="mt-3 flex items-start gap-2.5 text-xs text-ink">
                    <input type="checkbox" data-testid="prize-boostable" checked={p.boostable === true} onChange={(e) => updatePrize(p.id, { boostable: e.target.checked })} className="mt-0.5 shrink-0 accent-[var(--brand)]" />
                    <span><span className="font-semibold">Boostable</span><span className="mt-0.5 block text-muted">Allow new Focus and Chase packs for this prize. Existing packs keep their promise.{p.stock != null ? " Each Chase pack reserves one unit when granted." : ""}</span></span>
                  </label>

                  <div className="mt-2.5 grid grid-cols-4 gap-2">
                    <Lbl label="Tickets" small>
                      <input
                        type="number"
                        min={0}
                        step={1}
                        inputMode="numeric"
                        className="ff-input tnum w-full text-right"
                        value={p.weight}
                        onChange={(e) => updatePrize(p.id, { weight: Number(e.target.value) })}
                        {...fieldProps(k("weight"), pe.weight)}
                        aria-describedby={
                          [weightErrOn ? errId(k("weight")) : null, zeroNote ? zeroNoteId : null]
                            .filter(Boolean)
                            .join(" ") || undefined
                        }
                      />
                    </Lbl>
                    <Lbl label="Stock" small>
                      <input
                        type="number"
                        min={0}
                        step={1}
                        placeholder="∞"
                        className="ff-input tnum w-full text-right"
                        value={p.stock ?? ""}
                        disabled={p.delivery === "codes"}
                        title={p.delivery === "codes" ? "Stock follows the unused code count. Add codes in Delivery below." : undefined}
                        onChange={(e) =>
                          updatePrize(p.id, {
                            stock: e.target.value === "" ? null : Number(e.target.value),
                          })
                        }
                        {...fieldProps(k("stock"), pe.stock)}
                      />
                    </Lbl>
                    <Lbl label="Cost" small>
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
                        aria-label="Cost (your cost, dollars)"
                      />
                    </Lbl>
                    <div className="flex min-w-0 flex-col gap-1.5">
                      <span className={capSm}>Odds</span>
                      {/* Match .ff-input's box (padding + border) so the % sits on
                          the same baseline as the Tickets/Stock/Cost inputs. */}
                      <span
                        className={`tnum flex items-center justify-end border border-transparent py-[0.5rem] font-mono text-[0.9rem] font-semibold ${
                          outOfStock ? "text-muted" : "text-brand"
                        }`}
                        title={outOfStock ? "Out of stock — leaves the pool until restocked" : undefined}
                      >
                        {pct.toFixed(1)}%
                      </span>
                    </div>
                  </div>
                  {p.delivery === "codes" && <p className="mt-1 text-xs text-muted">Code-list stock is the unused code count. Add codes in Delivery below.</p>}
                  {numberErrors.map((f) => (
                    <FieldError key={f} id={errId(k(f))} message={errFor(k(f), pe[f])} />
                  ))}
                  {zeroNote && (
                    <p id={zeroNoteId} className="mt-1 text-[12px] leading-snug text-[#fcd34d]">
                      {ZERO_TICKETS_NOTE}
                    </p>
                  )}
                  {outOfStock && (
                    <p className="mt-1 text-right text-[11px] text-[#fcd34d]">
                      Out of stock — the other prizes&rsquo; odds renormalize.
                    </p>
                  )}

                  <div className="mt-2.5 flex items-center gap-2.5">
                    <span className={capSm}>Color</span>
                    <input
                      type="color"
                      className="h-7 w-10 shrink-0 cursor-pointer rounded-[7px] border border-[var(--hair)] bg-transparent p-0 [&::-webkit-color-swatch-wrapper]:p-0.5 [&::-webkit-color-swatch]:rounded-[5px] [&::-webkit-color-swatch]:border-0"
                      value={normalizeHex(swatch) ?? rarityColor}
                      onChange={(e) => updatePrize(p.id, { color: e.target.value })}
                      aria-label="Prize color"
                    />
                    <input
                      className="ff-input tnum min-w-0 flex-1"
                      value={swatch}
                      spellCheck={false}
                      autoComplete="off"
                      // Cleared = back to the rarity color (unset), not "".
                      onChange={(e) => updatePrize(p.id, { color: colorFromInput(e.target.value) })}
                      aria-label="Prize color hex"
                      {...fieldProps(k("color"), pe.color, () => {
                        const n = normalizeHex(p.color);
                        if (n && n !== p.color) updatePrize(p.id, { color: n });
                      })}
                    />
                    <button
                      type="button"
                      onClick={() => updatePrize(p.id, { color: RARITY_COLORS[p.rarity] })}
                      className="shrink-0 text-[11px] font-semibold text-muted underline-offset-2 transition hover:text-ink hover:underline"
                    >
                      Reset to rarity
                    </button>
                  </div>
                  <FieldError id={errId(k("color"))} message={errFor(k("color"), pe.color)} />

                  {/* The win message is content fans see, so it stays visible. */}
                  <div className="mt-2.5">
                    <Lbl label="Description (shown on win)" small>
                      <textarea
                        className="ff-input w-full"
                        rows={2}
                        value={p.description ?? ""}
                        onChange={(e) => updatePrize(p.id, { description: e.target.value })}
                      />
                    </Lbl>
                  </div>

                  <PrizeDeliveryEditor
                    prizeId={p.id}
                    prizeLabel={p.label}
                    delivery={p.delivery}
                    canSave={savedPrizeIds.has(p.id) && !dirty}
                    disabled={saving || deliveryPending}
                    onSaved={deliverySaved}
                    onDirtyChange={deliveryDirtyChanged}
                    onBusyChange={deliveryBusyChanged}
                  />

                  {/* "More": the emoji quick-picks (a helper, not content). */}
                  <button
                    type="button"
                    onClick={() => setMoreOpen((m) => ({ ...m, [p.id]: !more }))}
                    aria-expanded={more}
                    className="mt-2.5 inline-flex items-center gap-1 rounded-md text-[11px] font-semibold text-muted transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
                  >
                    <Glyph
                      d={P.chevron}
                      size={12}
                      strokeWidth={2.4}
                      className={`transition-transform ${more ? "rotate-180" : ""}`}
                    />
                    {more ? "Less" : "More"}
                    {!more && <span className="font-medium"> · emoji picks</span>}
                  </button>
                  {more && (
                    <div className="mt-2.5 rounded-[10px] border border-[var(--hair)] p-3 [background:var(--s2)]">
                      <span className={capSm}>Emoji</span>
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {EMOJI_SUGGESTIONS.map((emo) => (
                          <button
                            key={emo}
                            type="button"
                            onClick={() => updatePrize(p.id, { emoji: emo })}
                            className="rounded-md border border-[var(--hair)] px-1.5 py-0.5 text-sm transition-colors hover:bg-[color-mix(in_oklab,var(--color-ink)_6%,transparent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
                            aria-label={`Use emoji ${emo}`}
                            title={`Use ${emo}`}
                          >
                            {emo}
                          </button>
                        ))}
                      </div>
                      <p className="mt-1.5 text-[11px] text-muted">Tip: type or paste any emoji.</p>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {(prizeCountMsg || minNote) && (
            <p
              id={MIN_PRIZES_NOTE_ID}
              className={`mt-3 text-[12.5px] ${prizeCountMsg ? "text-[#fca5a5]" : "text-muted"}`}
            >
              {prizeCountMsg ?? minNote}
            </p>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              id="wf-add-prize"
              onClick={addPrize}
              aria-describedby={prizeCountMsg ? MIN_PRIZES_NOTE_ID : undefined}
              className={secondaryBtn}
            >
              <Glyph d={P.plus} size={15} strokeWidth={2.2} />
              Add prize
            </button>
            {wheel.prizes.length > 0 && (
              <button
                type="button"
                onClick={() => setWheel({ ...wheel, prizes: balanceOdds(wheel.prizes) })}
                className={secondaryBtn}
              >
                Balance odds
              </button>
            )}
          </div>

          {/* Library lives at the bottom: you build the wheel first, then optionally
              save it as a template or pull reusable prizes/templates in. */}
          <div className={`mt-4 rounded-xl ${raised}`}>
            <button
              type="button"
              onClick={() => setShowLibrary((v) => !v)}
              aria-expanded={showLibrary}
              className="flex w-full items-center justify-between gap-3 rounded-xl px-4 py-3.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
            >
              <span className="flex items-center gap-2 text-sm font-semibold text-ink">
                <Glyph d={P.book} size={17} strokeWidth={1.7} className="text-brand" />
                Prize &amp; game library
              </span>
              <span className="flex items-center gap-1.5 text-[13px] font-semibold text-muted">
                <span className="max-sm:hidden">
                  {showLibrary ? "Hide" : "Save / reuse prizes & templates"}
                </span>
                <Glyph
                  d={P.chevron}
                  size={14}
                  strokeWidth={2.2}
                  className={`transition-transform ${showLibrary ? "rotate-180" : ""}`}
                />
              </span>
            </button>
            {showLibrary && (
              <div className="border-t border-[var(--hair)] px-4 py-4">
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
          </fieldset>
        </div>
      </div>
    </div>
  );
}
