"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PrizeTemplate, WheelTemplate } from "@/lib/data/types";
import { RARITY_COLORS, RARITY_LABEL } from "@/lib/games/wheel/types";
import { useToast } from "@/components/ui/Toast";
import { EmptyState } from "./ui";

const well = "rounded-xl border border-[var(--hair)] p-4 [background:var(--s2)]";
const row =
  "flex items-center gap-3 rounded-[10px] border border-[var(--hair)] bg-[color-mix(in_oklab,var(--color-ink)_3%,transparent)] px-3 py-2.5";
const smallBtn =
  "shrink-0 rounded-[8px] border border-[var(--hair)] px-2.5 py-1 text-xs font-semibold text-ink transition-colors hover:bg-[color-mix(in_oklab,var(--color-ink)_6%,transparent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]";
const mutedBtn =
  "shrink-0 rounded-[8px] border border-[var(--hair)] px-2.5 py-1 text-xs font-semibold text-muted transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]";
const dangerBtn =
  "shrink-0 rounded-[8px] border border-[#ef4444] px-2.5 py-1 text-xs font-semibold text-[#fca5a5] transition-colors hover:bg-[#ef4444]/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] disabled:opacity-50";
const tick = <span aria-hidden="true" className="h-3.5 w-[3px] rounded-sm bg-[var(--brand)]" />;

/**
 * Reusable template + prize library. Self-fetches the creator's saved wheel
 * templates and prize library, and exposes apply / save / delete affordances.
 * Mutations that change the library (delete) refetch the relevant list; "apply"
 * and "save current" actions are delegated to the parent via callbacks since
 * only the editor knows the live wheel/prize state.
 *
 * Props:
 *   onApplyWheelTemplate(templateId)   apply a saved wheel template to the editor
 *   onSaveCurrentWheelAsTemplate(name) save the editor's current wheel as a template
 *   onApplyPrizeTemplate(template)     drop a library prize into the current wheel
 *   onSaveCurrentPrizesToLibrary?()    optional; save the wheel's prizes to the library
 */
export default function TemplateLibrary({
  onApplyWheelTemplate,
  onSaveCurrentWheelAsTemplate,
  onApplyPrizeTemplate,
  onSaveCurrentPrizesToLibrary,
  refreshSignal,
}: {
  onApplyWheelTemplate: (templateId: string) => void;
  onSaveCurrentWheelAsTemplate: (name: string) => void;
  onApplyPrizeTemplate: (t: PrizeTemplate) => void;
  onSaveCurrentPrizesToLibrary?: () => void | Promise<void>;
  /**
   * #9: bumped by the parent whenever a prize is favorited (★) elsewhere in the
   * editor, so the library list refetches and the new prize appears immediately
   * — no page refresh.
   */
  refreshSignal?: number;
}) {
  const toast = useToast();
  const [wheelTemplates, setWheelTemplates] = useState<WheelTemplate[] | null>(null);
  const [prizes, setPrizes] = useState<PrizeTemplate[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  // Two-step inline delete confirm, keyed by template/prize id.
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const loadWheels = useCallback(async () => {
    const res = await fetch("/api/templates/wheels", { cache: "no-store" });
    if (res.ok) {
      const data = (await res.json()) as { templates?: WheelTemplate[] };
      setWheelTemplates(data.templates ?? []);
    } else {
      setWheelTemplates([]);
    }
  }, []);

  const loadPrizes = useCallback(async () => {
    const res = await fetch("/api/templates/prizes", { cache: "no-store" });
    if (res.ok) {
      // The API returns { templates }; read that (was mistakenly { prizes }, so
      // the library always looked empty even after saving).
      const data = (await res.json()) as { templates?: PrizeTemplate[] };
      setPrizes(data.templates ?? []);
    } else {
      setPrizes([]);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount
    loadWheels();
    loadPrizes();
  }, [loadWheels, loadPrizes]);

  // #9: when the parent signals a library change (e.g. a prize was favorited in
  // the editor), refetch the prize library so it shows up immediately. Skips the
  // initial render so it doesn't duplicate the mount fetch above.
  const didMountRef = useRef(false);
  useEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true;
      return;
    }
    void loadPrizes();
  }, [refreshSignal, loadPrizes]);

  function saveCurrentWheel() {
    const trimmed = name.trim();
    if (!trimmed) return;
    onSaveCurrentWheelAsTemplate(trimmed);
    setName("");
    // The parent owns the POST; refetch shortly so a newly-saved template shows.
    // We optimistically refetch — the parent should have persisted by then.
    void loadWheels();
  }

  async function deleteWheelTemplate(id: string) {
    setBusy(true);
    try {
      const res = await fetch(`/api/templates/wheels/${id}`, { method: "DELETE" });
      if (!res.ok) {
        toast("Couldn't delete template. Try again.", { tone: "error" });
        return;
      }
      toast("Template deleted", { tone: "success" });
      setConfirmDelete(null);
      await loadWheels();
    } finally {
      setBusy(false);
    }
  }

  async function deletePrizeTemplate(id: string) {
    setBusy(true);
    try {
      const res = await fetch(`/api/templates/prizes/${id}`, { method: "DELETE" });
      if (!res.ok) {
        toast("Couldn't delete prize. Try again.", { tone: "error" });
        return;
      }
      toast("Prize removed from library", { tone: "success" });
      setConfirmDelete(null);
      await loadPrizes();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      {/* Wheel templates */}
      <section className={well} aria-label="Game templates">
        <h3 className="flex items-center gap-2 text-[15px] font-bold text-ink">
          {tick}
          Game templates
        </h3>
        <p className="mt-1 text-sm text-muted">
          Reusable game presets — apply one to start a new game, or save the
          game you&rsquo;re editing as a template.
        </p>

        {/* Save current wheel as a template */}
        <div className="mt-4 flex flex-wrap items-end gap-2">
          <label className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-muted">
              Save current game as template
            </span>
            <input
              className="ff-input"
              placeholder="e.g. Summer drop"
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  saveCurrentWheel();
                }
              }}
              aria-label="New game template name"
            />
          </label>
          <button
            type="button"
            onClick={saveCurrentWheel}
            disabled={!name.trim()}
            className="btn-brand min-h-9 rounded-[9px] px-4 text-sm font-bold disabled:opacity-50"
          >
            Save template
          </button>
        </div>

        <div className="mt-5">
          {wheelTemplates === null ? (
            <div className="space-y-2">
              {Array.from({ length: 2 }).map((_, i) => (
                <div key={i} className="skeleton h-14 rounded-[10px]" />
              ))}
            </div>
          ) : wheelTemplates.length === 0 ? (
            <EmptyState
              title="No game templates yet"
              body="Save the game you're editing above to reuse it as a starting point later."
            />
          ) : (
            <ul className="space-y-2">
              {wheelTemplates.map((t) => (
                <li key={t.id} className={row}>
                  <span
                    aria-hidden
                    className="h-3 w-3 shrink-0 rounded-full"
                    style={{ backgroundColor: t.brandColor }}
                  />
                  <div className="min-w-0 flex-1">
                    <span className="block truncate font-semibold text-ink">{t.name}</span>
                    <p className="tnum mt-0.5 text-xs text-muted">
                      {t.prizes.length} {t.prizes.length === 1 ? "prize" : "prizes"}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => onApplyWheelTemplate(t.id)}
                    className={smallBtn}
                  >
                    Apply
                  </button>
                  {confirmDelete === t.id ? (
                    <>
                      <button
                        type="button"
                        onClick={() => deleteWheelTemplate(t.id)}
                        disabled={busy}
                        className={dangerBtn}
                      >
                        Confirm
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmDelete(null)}
                        className={mutedBtn}
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmDelete(t.id)}
                      className={mutedBtn}
                    >
                      Delete
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {/* Prize library */}
      <section className={well} aria-label="Prize library">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="flex items-center gap-2 text-[15px] font-bold text-ink">
            {tick}
            Prize library
          </h3>
          {onSaveCurrentPrizesToLibrary && (
            <button
              type="button"
              onClick={async () => {
                await onSaveCurrentPrizesToLibrary();
                await loadPrizes();
              }}
              className={smallBtn}
            >
              Save current prizes
            </button>
          )}
        </div>
        <p className="mt-1 text-sm text-muted">
          Reusable prizes you can drop into any game.
        </p>

        <div className="mt-5">
          {prizes === null ? (
            <div className="space-y-2">
              {Array.from({ length: 2 }).map((_, i) => (
                <div key={i} className="skeleton h-14 rounded-[10px]" />
              ))}
            </div>
          ) : prizes.length === 0 ? (
            <EmptyState
              title="No saved prizes yet"
              body="Save a prize to the library to reuse it across games without re-entering it."
            />
          ) : (
            <ul className="space-y-2">
              {prizes.map((p) => (
                <li key={p.id} className={row}>
                  <span
                    aria-hidden
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: p.color ?? RARITY_COLORS[p.rarity] }}
                  />
                  <div className="min-w-0 flex-1">
                    <span className="block truncate font-semibold text-ink">
                      {p.emoji ? `${p.emoji} ` : ""}
                      {p.label}
                    </span>
                    <p className="mt-0.5 text-xs text-muted">{RARITY_LABEL[p.rarity]}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => onApplyPrizeTemplate(p)}
                    className={smallBtn}
                  >
                    Add
                  </button>
                  {confirmDelete === p.id ? (
                    <>
                      <button
                        type="button"
                        onClick={() => deletePrizeTemplate(p.id)}
                        disabled={busy}
                        className={dangerBtn}
                      >
                        Confirm
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmDelete(null)}
                        className={mutedBtn}
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmDelete(p.id)}
                      className={mutedBtn}
                    >
                      Delete
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}
