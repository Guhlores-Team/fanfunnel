"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { WheelSummary } from "@/lib/data/types";
import { useToast } from "@/components/ui/Toast";
import { useCreatorDraft, useCreatorLeave } from "./CreatorDrafts";
import NewGameDialog from "./NewGameDialog";
import { canCreateGame, GAME_LABEL, gameRefusalMessage, type GameFeatures } from "./gameEditor";
import type { GameKind } from "@/lib/games/core/gameProof";
import { MIN_WHEEL_PRIZES } from "@/lib/games/wheel/validate";

type GameSummary = WheelSummary & { gameKind?: GameKind; gameReady?: boolean };

/**
 * Header control for the wheel editor. Self-fetches the creator's wheels and
 * draws them as chips (Command Center). "Set active" (the everyday action) sits
 * on every eligible chip; the rare actions (duplicate, archive/restore, delete
 * forever) live in each chip's "Manage" menu. The schedule card for the
 * selected wheel is always shown under the chips, as it was before the
 * redesign. Owns its own list state and refetches after every mutation so the
 * surrounding editor only has to react to `onChanged`.
 *
 * Props:
 *   currentWheelId  the wheel the editor is presently editing (highlighted)
 *   onEdit(id)      open a wheel in the editor; resolves true once it is open
 *   onChanged?()    fired after any mutation that may affect editor state
 */
export default function WheelSwitcher({
  currentWheelId,
  onEdit,
  onChanged,
  features,
  savedGame,
}: {
  currentWheelId: string | null;
  onEdit: (id: string) => boolean | void | Promise<boolean | void>;
  onChanged?: () => void;
  features: GameFeatures | null;
  savedGame?: { id: string; title: string; prizeCount: number; gameKind?: GameKind; gameReady?: boolean };
}) {
  const toast = useToast();
  const [wheels, setWheels] = useState<GameSummary[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [newError, setNewError] = useState("");
  const [loadError, setLoadError] = useState("");
  const leave = useCreatorLeave();
  // Two-step archive confirm, keyed by wheel id (mirrors the delete-fan pattern).
  const [confirmArchive, setConfirmArchive] = useState<string | null>(null);
  // Two-step permanent-delete confirm, keyed by wheel id.
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  // Local edits to the selected wheel's schedule inputs.
  const [from, setFrom] = useState("");
  const [until, setUntil] = useState("");
  // Which chip's "Manage" menu is open.
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuAnchorRef = useRef<HTMLButtonElement | null>(null);

  const load = useCallback(async () => {
    // Include archived wheels so they're visible (and restorable), not hidden.
    const res = await fetch("/api/wheels?archived=1", { cache: "no-store" });
    if (res.ok) {
      const data = (await res.json()) as { wheels?: GameSummary[] };
      setWheels(data.wheels ?? []);
      setLoadError("");
    } else {
      throw new Error("games_unavailable");
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount
    void load().catch(() => setLoadError("Saved games couldn't load. Check again before creating or changing a game."));
  }, [load]);

  // Sync the schedule inputs whenever the selected wheel (or list) changes.
  // Reflect a confirmed editor save without refetching/replacing a schedule
  // the creator is still typing in this component.
  const visibleWheels = useMemo(() => wheels?.map((game) => game.id === savedGame?.id ? { ...game, title: savedGame.title, prizeCount: savedGame.prizeCount, ...(savedGame.gameKind ? { gameKind: savedGame.gameKind } : {}), ...(typeof savedGame.gameReady === "boolean" ? { gameReady: savedGame.gameReady } : {}) } : game) ?? null, [wheels, savedGame]);
  const selected = visibleWheels?.find((w) => w.id === currentWheelId) ?? null;
  const scheduleDirty = from !== toLocalInput(selected?.activeFrom ?? null) || until !== toLocalInput(selected?.activeUntil ?? null);
  useCreatorDraft("game-management", "this game schedule", scheduleDirty, busy);
  function openGame(id: string) {
    leave(() => { setFrom(toLocalInput(selected?.activeFrom ?? null)); setUntil(toLocalInput(selected?.activeUntil ?? null)); void onEdit(id); }, { scope: "game-management", consequence: "Switching games discards the unsaved schedule. It does not undo a request already sent." });
  }
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- mirror selection into editable inputs
    setFrom(toLocalInput(selected?.activeFrom ?? null));
    setUntil(toLocalInput(selected?.activeUntil ?? null));
  }, [selected?.id, selected?.activeFrom, selected?.activeUntil]);

  // Menu: close on Escape / outside click, and hand focus back to its trigger.
  useEffect(() => {
    if (!menuFor) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (menuRef.current?.contains(t) || menuAnchorRef.current?.contains(t)) return;
      closeMenu(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeMenu(true);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    // Move focus into the menu so keyboard users land on the first action.
    menuRef.current?.querySelector<HTMLElement>("[role='menuitem']")?.focus();
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuFor]);

  function closeMenu(restoreFocus: boolean) {
    setMenuFor(null);
    setConfirmArchive(null);
    setConfirmDelete(null);
    if (restoreFocus) menuAnchorRef.current?.focus();
  }

  function onMenuKey(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>("[role='menuitem']:not(:disabled)") ?? [],
    );
    if (items.length === 0) return;
    e.preventDefault();
    const i = items.indexOf(document.activeElement as HTMLElement);
    const next =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? items.length - 1
          : e.key === "ArrowDown"
            ? (i + 1) % items.length
            : (i - 1 + items.length) % items.length;
    items[next].focus();
  }

  async function createWheel(gameKind: GameKind, name: string) {
    if (busy || !canCreateGame(gameKind, features)) return;
    setBusy(true);
    setNewError("");
    try {
      const res = await fetch("/api/wheels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gameKind, gameConfig: gameKind === "wheel" ? {} : gameKind === "scratch" ? { style: "classic" } : { size: 3, linePrizeId: null }, ...(name.trim() ? { name: name.trim() } : {}) }),
      });
      const data = (await res.json()) as { wheel?: { id: string }; error?: string };
      if (!res.ok || !data.wheel) {
        setNewError(gameRefusalMessage(data.error) ?? "Couldn't confirm game creation. Check the game list before retrying.");
        return;
      }
      toast(gameKind === "bingo" ? "Inactive bingo draft created" : "Game created", { tone: "success" });
      setNewOpen(false);
      await load();
      await onEdit(data.wheel.id);
      onChanged?.();
    } catch {
      setNewError("The result couldn't be confirmed. Close this form and check the game list before creating another.");
      await load().catch(() => {});
    } finally {
      setBusy(false);
    }
  }

  async function patchWheel(id: string, body: Record<string, unknown>, okMsg: string) {
    setBusy(true);
    try {
      const res = await fetch(`/api/wheels/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null) as { error?: string } | null;
        toast(gameRefusalMessage(data?.error) ?? "Couldn't update this game. Your settings are still here.", { tone: "error" });
        return false;
      }
      toast(okMsg, { tone: "success" });
      await load();
      onChanged?.();
      return true;
    } catch {
      toast("The game update couldn't be confirmed. Your settings are still here; check its saved state before retrying.", { tone: "error" });
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function setActive(id: string) {
    await patchWheel(id, { isActive: true }, "Game set active");
  }

  async function restore(id: string) {
    await patchWheel(id, { archived: false }, "Game restored");
  }

  async function duplicate(id: string) {
    setBusy(true);
    try {
      const res = await fetch(`/api/wheels/${id}/duplicate`, { method: "POST" });
      const data = (await res.json()) as { wheel?: { id: string }; error?: string };
      if (!res.ok) {
        toast(gameRefusalMessage(data.error) ?? "Couldn't duplicate this game. Check its enabled feature and try again.", { tone: "error" });
        return;
      }
      toast("Game duplicated", { tone: "success" });
      await load();
      if (data.wheel?.id) await onEdit(data.wheel.id);
      onChanged?.();
    } catch {
      toast("The duplicate couldn't be confirmed. Check the game list before creating another.", { tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  async function archive(id: string) {
    setBusy(true);
    try {
      const res = await fetch(`/api/wheels/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => null) as { error?: string } | null;
        toast(gameRefusalMessage(data?.error) ?? "Couldn't archive this game. Its active progress has been kept.", { tone: "error" });
        return;
      }
      toast("Game archived", { tone: "success" });
      setConfirmArchive(null);
      await load();
      onChanged?.();
    } catch {
      toast("The archive result couldn't be confirmed. The game list can be checked again before retrying.", { tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  async function hardDelete(id: string) {
    setBusy(true);
    try {
      const res = await fetch(`/api/wheels/${id}?hard=1`, { method: "DELETE" });
      if (res.status === 409) {
        const data = await res.json().catch(() => null) as { error?: string } | null;
        toast(gameRefusalMessage(data?.error) ?? "This game has plays — keep its history and active progress. Archive only when the server allows it.", {
          tone: "error",
        });
        setConfirmDelete(null);
        return;
      }
      if (!res.ok) {
        toast("Couldn't delete this game. Try again.", { tone: "error" });
        return;
      }
      toast("Game deleted", { tone: "success" });
      setConfirmDelete(null);
      await load();
      onChanged?.();
    } catch {
      toast("The delete result couldn't be confirmed. Check the game list before retrying.", { tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  async function saveSchedule() {
    if (!selected) return;
    // A partial datetime-local value (e.g. while editing) makes an Invalid Date,
    // and .toISOString() on that throws RangeError — guard before converting.
    const fromDate = from ? new Date(from) : null;
    const untilDate = until ? new Date(until) : null;
    if ((fromDate && isNaN(fromDate.getTime())) || (untilDate && isNaN(untilDate.getTime()))) {
      toast("Enter a complete date and time.", { tone: "error" });
      return;
    }
    await patchWheel(
      selected.id,
      {
        activeFrom: fromDate ? fromDate.toISOString() : null,
        activeUntil: untilDate ? untilDate.toISOString() : null,
      },
      "Schedule updated",
    );
  }

  async function clearSchedule() {
    if (!selected) return;
    setFrom("");
    setUntil("");
    await patchWheel(selected.id, { activeFrom: null, activeUntil: null }, "Set to always on");
  }

  const menuItem =
    "flex w-full items-center gap-2 rounded-[8px] px-2.5 py-2 text-left text-[13px] font-semibold text-ink transition-colors hover:bg-[color-mix(in_oklab,var(--color-ink)_6%,transparent)] focus-visible:bg-[color-mix(in_oklab,var(--color-ink)_6%,transparent)] focus-visible:outline-none disabled:opacity-50";

  return (
    <section aria-label="Game switcher">
      {loadError && <p role="alert" className="mb-2 text-xs text-amber-200">{loadError} <button type="button" className="font-semibold underline" disabled={busy} onClick={() => void load().catch(() => setLoadError("Saved games still couldn't load."))}>Check games again</button></p>}
      {newOpen && <NewGameDialog features={features} busy={busy} error={newError} onClose={() => { setNewOpen(false); setNewError(""); }} onCreate={(kind, name) => leave(() => { setFrom(toLocalInput(selected?.activeFrom ?? null)); setUntil(toLocalInput(selected?.activeUntil ?? null)); void createWheel(kind, name); }, { scope: "game-management", consequence: "Creating a game discards this unsaved schedule. Existing game prize edits are kept until you choose whether to open the new game." })} />}
      <div className="flex flex-wrap items-center gap-2">
        {visibleWheels === null
          ? Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="skeleton h-[34px] w-32 rounded-full" />
            ))
          : visibleWheels.map((w) => {
              const current = w.id === currentWheelId;
              const open = menuFor === w.id;
              const hint = `${w.prizeCount} ${w.prizeCount === 1 ? "prize" : "prizes"} · ${scheduleHint(
                w.activeFrom,
                w.activeUntil,
                w.isActive,
              )}`;
              return (
                <div
                  key={w.id}
                  className={`relative inline-flex min-h-[34px] items-center rounded-full border pl-3.5 pr-1 text-[13px] font-semibold transition-colors duration-150 ${
                    current
                      ? "border-[color-mix(in_oklab,var(--brand)_45%,transparent)] bg-[color-mix(in_oklab,var(--brand)_14%,transparent)] text-ink"
                      : "border-[var(--hair)] text-muted hover:border-[color-mix(in_oklab,var(--brand)_35%,var(--hair))] hover:text-ink"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => openGame(w.id)}
                    disabled={busy}
                    aria-current={current ? "true" : undefined}
                    title={hint}
                    className="flex min-h-[32px] max-w-[220px] items-center gap-2 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
                  >
                    <span
                      aria-hidden="true"
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ backgroundColor: w.brandColor }}
                    />
                    <span className="truncate">{w.title}</span>
                    <span className="sr-only">{`, ${GAME_LABEL[w.gameKind ?? "wheel"]}`}</span>
                    {w.gameReady === false && <span className="shrink-0 rounded-full border border-amber-300/30 px-1.5 py-px text-[9.5px] font-semibold">Draft</span>}
                    {w.isActive && (
                      <span className="shrink-0 rounded-full bg-[var(--brand)] px-1.5 py-px text-[9.5px] font-bold uppercase tracking-wide text-[var(--brand-ink)]">
                        Active
                      </span>
                    )}
                    {w.archivedAt && (
                      <span className="shrink-0 rounded-full border border-[var(--hair)] px-1.5 py-px text-[9.5px] font-semibold uppercase tracking-wide text-muted">
                        Archived
                      </span>
                    )}
                    <span className="sr-only">{`, ${hint}`}</span>
                  </button>
                  {/* The one everyday wheel action stays visible (not in the menu). */}
                  {!w.isActive && !w.archivedAt && w.gameReady !== false && (
                    <button
                      type="button"
                      onClick={() => setActive(w.id)}
                      disabled={busy || w.prizeCount < MIN_WHEEL_PRIZES || !canCreateGame(w.gameKind ?? "wheel", features)}
                      title={w.prizeCount < MIN_WHEEL_PRIZES ? `Save at least ${MIN_WHEEL_PRIZES} prizes before activating this game.` : !canCreateGame(w.gameKind ?? "wheel", features) ? "Ask your admin to enable this game type before activating it." : undefined}
                      aria-label={`Set ${w.title} active`}
                      className="ml-1.5 shrink-0 rounded-full border border-[color-mix(in_oklab,var(--brand)_45%,transparent)] px-2 py-px text-[10.5px] font-bold uppercase tracking-wide text-brand transition-colors hover:bg-[color-mix(in_oklab,var(--brand)_14%,transparent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] disabled:opacity-50"
                    >
                      Set active
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={(e) => {
                      if (open) {
                        closeMenu(false);
                      } else {
                        menuAnchorRef.current = e.currentTarget;
                        setConfirmArchive(null);
                        setConfirmDelete(null);
                        setMenuFor(w.id);
                      }
                    }}
                    aria-haspopup="menu"
                    aria-expanded={open}
                    aria-label={`Manage ${w.title}`}
                    title="Manage game"
                    className="ml-1 grid h-7 w-7 shrink-0 place-items-center rounded-full text-muted transition-colors hover:bg-[color-mix(in_oklab,var(--color-ink)_8%,transparent)] hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
                  >
                    <Icon d="M5 12h.01M12 12h.01M19 12h.01" size={15} />
                  </button>

                  {open && (
                    <div
                      ref={menuRef}
                      role="menu"
                      aria-label={`Manage ${w.title}`}
                      onKeyDown={onMenuKey}
                      className="absolute left-0 top-[calc(100%+6px)] z-30 w-64 rounded-xl border border-[var(--hair)] p-1.5 shadow-[var(--lift)] [background:var(--s1)]"
                    >
                      <div className="px-2.5 pb-2 pt-1.5">
                        <p className="truncate text-[13px] font-bold text-ink">{w.title}</p>
                        <p className="tnum mt-0.5 text-[11.5px] text-muted">{hint}</p>
                      </div>
                      {!current && (
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            openGame(w.id);
                            closeMenu(true);
                          }}
                          className={menuItem}
                        >
                          Edit
                        </button>
                      )}
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          closeMenu(true);
                          leave(() => { setFrom(toLocalInput(selected?.activeFrom ?? null)); setUntil(toLocalInput(selected?.activeUntil ?? null)); void duplicate(w.id); }, { scope: "game-management", consequence: "Opening a duplicate discards the unsaved schedule. Existing game prize edits stay until you choose whether to open it." });
                        }}
                        disabled={busy || !canCreateGame(w.gameKind ?? "wheel", features)}
                        title={!canCreateGame(w.gameKind ?? "wheel", features) ? "Ask your admin to enable this game type before duplicating it." : undefined}
                        className={menuItem}
                      >
                        Duplicate
                      </button>
                      {w.archivedAt ? (
                        <button
                          type="button"
                          role="menuitem"
                          onClick={async () => {
                            closeMenu(true);
                            await restore(w.id);
                          }}
                          disabled={busy}
                          className={`${menuItem} text-brand`}
                        >
                          Restore
                        </button>
                      ) : confirmArchive === w.id ? (
                        <div className="flex gap-1">
                          <button
                            type="button"
                            role="menuitem"
                            onClick={async () => {
                              await archive(w.id);
                              closeMenu(true);
                            }}
                            disabled={busy}
                            className={`${menuItem} text-[#fca5a5]`}
                          >
                            Confirm archive
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => setConfirmArchive(null)}
                            className={`${menuItem} w-auto text-muted`}
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => setConfirmArchive(w.id)}
                          className={menuItem}
                        >
                          Archive
                        </button>
                      )}
                      {confirmDelete === w.id ? (
                        <div className="flex gap-1">
                          <button
                            type="button"
                            role="menuitem"
                            onClick={async () => {
                              await hardDelete(w.id);
                              closeMenu(true);
                            }}
                            disabled={busy}
                            className={`${menuItem} text-[#fca5a5]`}
                          >
                            Delete forever
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => setConfirmDelete(null)}
                            className={`${menuItem} w-auto text-muted`}
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => setConfirmDelete(w.id)}
                          className={`${menuItem} text-muted hover:text-[#fca5a5]`}
                        >
                          Delete…
                        </button>
                      )}
                      <p className="mt-1 border-t border-[var(--hair)] px-2.5 pb-1 pt-2 text-[11px] leading-snug text-muted">
                        One game is <strong>active</strong> at a time, except scheduled or campaign-pinned games.{" "}
                        <strong>Archive</strong> keeps its history (you can Restore). Games with
                        credited plays or owed bingo progress cannot be deleted.
                      </p>
                    </div>
                  )}
                </div>
              );
            })}
        <button
          type="button"
          onClick={() => { setNewError(""); setNewOpen(true); }}
          disabled={busy}
          className="inline-flex min-h-[34px] items-center gap-1.5 rounded-full border border-dashed border-[var(--hair)] px-3.5 text-[13px] font-semibold text-muted transition-colors duration-150 hover:border-[color-mix(in_oklab,var(--brand)_45%,var(--hair))] hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] disabled:opacity-50"
        >
          <Icon d="M12 5v14M5 12h14" size={14} strokeWidth={2.2} />
          New game
        </button>
      </div>
      {wheels !== null && wheels.length === 0 && (
        <p className="mt-2 text-sm text-muted">No games yet. Create one to get started.</p>
      )}

      {/* Schedule for the selected wheel: always visible, so a time-boxed wheel
          is obvious at a glance (prior design). */}
      {selected && (
        <section
          aria-label={`Schedule for ${selected.title}`}
          className="mt-3 rounded-xl border border-[var(--hair)] p-3.5 [background:var(--s2)]"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="flex min-w-0 items-center gap-2 text-sm font-bold text-ink">
              <span aria-hidden="true" className="h-3.5 w-[3px] shrink-0 rounded-sm bg-[var(--brand)]" />
              Schedule
              <span className="min-w-0 truncate text-xs font-medium text-muted">{selected.title}</span>
            </h4>
            <span className="tnum text-xs text-muted">
              {scheduleHint(selected.activeFrom, selected.activeUntil, selected.isActive)}
            </span>
          </div>
          {selected.gameReady === false && <p className="mt-2 text-xs text-amber-200">Finish and save this draft before activating it or setting a schedule.</p>}
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="flex min-w-0 flex-col gap-1.5">
              <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-muted">
                Active from
              </span>
              <input
                type="datetime-local"
                className="ff-input"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                aria-label="Active from"
                disabled={busy || selected.gameReady === false || !canCreateGame(selected.gameKind ?? "wheel", features)}
              />
            </label>
            <label className="flex min-w-0 flex-col gap-1.5">
              <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-muted">
                Active until
              </span>
              <input
                type="datetime-local"
                className="ff-input"
                value={until}
                onChange={(e) => setUntil(e.target.value)}
                aria-label="Active until"
                disabled={busy || selected.gameReady === false || !canCreateGame(selected.gameKind ?? "wheel", features)}
              />
            </label>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={saveSchedule}
              disabled={busy || selected.gameReady === false || !canCreateGame(selected.gameKind ?? "wheel", features)}
              className="btn-brand min-h-9 rounded-[9px] px-3.5 text-xs font-bold disabled:opacity-50"
            >
              Save schedule
            </button>
            <button
              type="button"
              onClick={clearSchedule}
              disabled={busy || selected.gameReady === false || !canCreateGame(selected.gameKind ?? "wheel", features) || (!from && !until)}
              className="min-h-9 rounded-[9px] border border-[var(--hair)] px-3.5 text-xs font-semibold text-ink transition-colors hover:bg-[color-mix(in_oklab,var(--color-ink)_5%,transparent)] disabled:opacity-50"
            >
              Always on
            </button>
          </div>
        </section>
      )}
    </section>
  );
}

function Icon({ d, size = 16, strokeWidth = 1.8 }: { d: string; size?: number; strokeWidth?: number }) {
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
      className="shrink-0"
    >
      <path d={d} />
    </svg>
  );
}

/** Convert an ISO timestamp to a value usable by <input type="datetime-local">. */
function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  // Shift to local time, then trim seconds/zone for the YYYY-MM-DDTHH:mm format.
  const off = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - off).toISOString().slice(0, 16);
}

/** A compact human hint describing a wheel's schedule window. */
function scheduleHint(
  activeFrom: string | null,
  activeUntil: string | null,
  isActive: boolean,
): string {
  // An unscheduled wheel is "Always on" only if it's THE active wheel; otherwise
  // it's simply inactive (exactly one wheel serves fans at a time).
  if (!activeFrom && !activeUntil) return isActive ? "Always on" : "Inactive";
  const fmt = (iso: string) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime())
      ? "—"
      : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  };
  if (activeFrom && activeUntil) return `${fmt(activeFrom)} → ${fmt(activeUntil)}`;
  if (activeFrom) return `From ${fmt(activeFrom)}`;
  return `Until ${fmt(activeUntil as string)}`;
}
