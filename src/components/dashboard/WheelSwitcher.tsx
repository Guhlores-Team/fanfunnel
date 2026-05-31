"use client";

import { useCallback, useEffect, useState } from "react";
import type { WheelSummary } from "@/lib/data/types";
import { useToast } from "@/components/ui/Toast";

/**
 * Header control for the wheel editor. Self-fetches the creator's wheels and
 * offers per-wheel management (edit, set active, duplicate, archive) plus an
 * inline schedule editor for the currently-selected wheel. Owns its own list
 * state and refetches after every mutation so the surrounding editor only has
 * to react to `onChanged`.
 *
 * Props:
 *   currentWheelId  the wheel the editor is presently editing (highlighted)
 *   onEdit(id)      open a wheel in the editor
 *   onChanged?()    fired after any mutation that may affect editor state
 */
export default function WheelSwitcher({
  currentWheelId,
  onEdit,
  onChanged,
}: {
  currentWheelId: string | null;
  onEdit: (id: string) => void;
  onChanged?: () => void;
}) {
  const toast = useToast();
  const [wheels, setWheels] = useState<WheelSummary[] | null>(null);
  const [busy, setBusy] = useState(false);
  // Two-step archive confirm, keyed by wheel id (mirrors the delete-fan pattern).
  const [confirmArchive, setConfirmArchive] = useState<string | null>(null);
  // Local edits to the selected wheel's schedule inputs.
  const [from, setFrom] = useState("");
  const [until, setUntil] = useState("");

  const load = useCallback(async () => {
    const res = await fetch("/api/wheels", { cache: "no-store" });
    if (res.ok) {
      const data = (await res.json()) as { wheels?: WheelSummary[] };
      setWheels(data.wheels ?? []);
    } else {
      setWheels([]);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount
    load();
  }, [load]);

  // Sync the schedule inputs whenever the selected wheel (or list) changes.
  const selected = wheels?.find((w) => w.id === currentWheelId) ?? null;
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- mirror selection into editable inputs
    setFrom(toLocalInput(selected?.activeFrom ?? null));
    setUntil(toLocalInput(selected?.activeUntil ?? null));
  }, [selected?.id, selected?.activeFrom, selected?.activeUntil]);

  async function createWheel() {
    setBusy(true);
    try {
      const res = await fetch("/api/wheels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = (await res.json()) as { wheel?: { id: string }; error?: string };
      if (!res.ok || !data.wheel) {
        toast("Couldn't create wheel. Try again.", { tone: "error" });
        return;
      }
      toast("Wheel created", { tone: "success" });
      await load();
      onEdit(data.wheel.id);
      onChanged?.();
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
        toast("Couldn't update wheel. Try again.", { tone: "error" });
        return false;
      }
      toast(okMsg, { tone: "success" });
      await load();
      onChanged?.();
      return true;
    } finally {
      setBusy(false);
    }
  }

  async function setActive(id: string) {
    await patchWheel(id, { isActive: true }, "Wheel set active");
  }

  async function duplicate(id: string) {
    setBusy(true);
    try {
      const res = await fetch(`/api/wheels/${id}/duplicate`, { method: "POST" });
      const data = (await res.json()) as { wheel?: { id: string }; error?: string };
      if (!res.ok) {
        toast("Couldn't duplicate wheel. Try again.", { tone: "error" });
        return;
      }
      toast("Wheel duplicated", { tone: "success" });
      await load();
      if (data.wheel?.id) onEdit(data.wheel.id);
      onChanged?.();
    } finally {
      setBusy(false);
    }
  }

  async function archive(id: string) {
    setBusy(true);
    try {
      const res = await fetch(`/api/wheels/${id}`, { method: "DELETE" });
      if (!res.ok) {
        toast("Couldn't archive wheel. Try again.", { tone: "error" });
        return;
      }
      toast("Wheel archived", { tone: "success" });
      setConfirmArchive(null);
      await load();
      onChanged?.();
    } finally {
      setBusy(false);
    }
  }

  async function saveSchedule() {
    if (!selected) return;
    await patchWheel(
      selected.id,
      {
        activeFrom: from ? new Date(from).toISOString() : null,
        activeUntil: until ? new Date(until).toISOString() : null,
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

  return (
    <section className="card rounded-xl p-4" aria-label="Wheel switcher">
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-bold text-ink">Wheels</h3>
        <button
          type="button"
          onClick={createWheel}
          disabled={busy}
          className="btn-brand rounded-lg px-3 py-1.5 text-sm font-bold disabled:opacity-50"
        >
          ＋ New wheel
        </button>
      </div>

      {wheels === null ? (
        <div className="mt-4 space-y-2">
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="skeleton h-16 rounded-lg" />
          ))}
        </div>
      ) : wheels.length === 0 ? (
        <p className="mt-4 text-sm text-muted">No wheels yet. Create one to get started.</p>
      ) : (
        <ul className="mt-4 space-y-2">
          {wheels.map((w) => {
            const current = w.id === currentWheelId;
            return (
              <li
                key={w.id}
                className={`rounded-lg border bg-base/40 p-3 ${
                  current ? "border-[var(--brand)]" : "border-line"
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="min-w-0 truncate font-semibold text-ink">{w.title}</span>
                      {w.isActive && (
                        <span className="shrink-0 rounded-full bg-[var(--brand)] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">
                          Active
                        </span>
                      )}
                      {w.archivedAt && (
                        <span className="shrink-0 rounded-full border border-line px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted">
                          Archived
                        </span>
                      )}
                    </div>
                    <p className="tnum mt-0.5 text-xs text-muted">
                      {w.prizeCount} {w.prizeCount === 1 ? "prize" : "prizes"} ·{" "}
                      {scheduleHint(w.activeFrom, w.activeUntil)}
                    </p>
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => onEdit(w.id)}
                    className="rounded-lg border border-line px-2.5 py-1 text-xs font-semibold text-ink transition hover:bg-white/5"
                  >
                    Edit
                  </button>
                  {!w.isActive && (
                    <button
                      type="button"
                      onClick={() => setActive(w.id)}
                      disabled={busy}
                      className="rounded-lg border border-line px-2.5 py-1 text-xs font-semibold text-ink transition hover:bg-white/5 disabled:opacity-50"
                    >
                      Set active
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => duplicate(w.id)}
                    disabled={busy}
                    className="rounded-lg border border-line px-2.5 py-1 text-xs font-semibold text-ink transition hover:bg-white/5 disabled:opacity-50"
                  >
                    Duplicate
                  </button>
                  {confirmArchive === w.id ? (
                    <>
                      <button
                        type="button"
                        onClick={() => archive(w.id)}
                        disabled={busy}
                        className="rounded-lg border border-[#ef4444] px-2.5 py-1 text-xs font-semibold text-[#ef4444] transition hover:bg-[#ef4444]/10 disabled:opacity-50"
                      >
                        Confirm archive
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmArchive(null)}
                        className="rounded-lg border border-line px-2.5 py-1 text-xs font-semibold text-muted transition hover:text-ink"
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmArchive(w.id)}
                      className="rounded-lg border border-line px-2.5 py-1 text-xs font-semibold text-muted transition hover:text-ink"
                    >
                      Archive
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {/* Schedule editor for the selected wheel. */}
      {selected && (
        <div className="mt-4 rounded-lg border border-line bg-base/40 p-3">
          <div className="flex items-center justify-between gap-2">
            <h4 className="text-sm font-semibold text-ink">Schedule</h4>
            <span className="min-w-0 truncate text-xs text-muted">{selected.title}</span>
          </div>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="flex min-w-0 flex-col gap-1">
              <span className="text-xs font-semibold uppercase tracking-wider text-muted">
                Active from
              </span>
              <input
                type="datetime-local"
                className="ff-input"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                aria-label="Active from"
              />
            </label>
            <label className="flex min-w-0 flex-col gap-1">
              <span className="text-xs font-semibold uppercase tracking-wider text-muted">
                Active until
              </span>
              <input
                type="datetime-local"
                className="ff-input"
                value={until}
                onChange={(e) => setUntil(e.target.value)}
                aria-label="Active until"
              />
            </label>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={saveSchedule}
              disabled={busy}
              className="btn-brand rounded-lg px-3 py-1.5 text-xs font-bold disabled:opacity-50"
            >
              Save schedule
            </button>
            <button
              type="button"
              onClick={clearSchedule}
              disabled={busy || (!from && !until)}
              className="rounded-lg border border-line px-3 py-1.5 text-xs font-semibold text-ink transition hover:bg-white/5 disabled:opacity-50"
            >
              Always on
            </button>
          </div>
        </div>
      )}
    </section>
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
function scheduleHint(activeFrom: string | null, activeUntil: string | null): string {
  if (!activeFrom && !activeUntil) return "Always on";
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
