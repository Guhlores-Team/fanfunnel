"use client";

import { useCallback, useEffect, useState } from "react";
import type { CampaignPack } from "@/lib/data/types";
import { formatCents } from "@/lib/format";
import { useToast } from "@/components/ui/Toast";
import { EmptyState, Field } from "./ui";

/**
 * Manage spin-pack presets for a campaign. Self-fetches the packs scoped to the
 * given campaign (or the creator's global packs when none is selected), and
 * supports add / edit / delete with optimistic-free refetch after each write.
 *
 * Props:
 *   campaignId  campaign to scope packs to, or null for global presets
 */
export default function PackEditor({ campaignId }: { campaignId: string | null }) {
  const toast = useToast();
  const [packs, setPacks] = useState<CampaignPack[] | null>(null);
  const [busy, setBusy] = useState(false);

  // New-pack form state.
  const [label, setLabel] = useState("");
  const [spins, setSpins] = useState("");
  const [amount, setAmount] = useState("");
  const [bonus, setBonus] = useState("");

  const load = useCallback(async () => {
    const qs = campaignId ? `?campaignId=${encodeURIComponent(campaignId)}` : "";
    const res = await fetch(`/api/campaign-packs${qs}`, { cache: "no-store" });
    if (res.ok) {
      const data = (await res.json()) as { packs?: CampaignPack[] };
      setPacks(data.packs ?? []);
    } else {
      setPacks([]);
    }
  }, [campaignId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- refetch when the scoped campaign changes
    setPacks(null);
    load();
  }, [load]);

  async function addPack() {
    const trimmed = label.trim();
    const nSpins = Number(spins);
    const nAmount = Math.round(Number(amount) * 100);
    const nBonus = bonus ? Number(bonus) : 0;
    if (!trimmed || !Number.isFinite(nSpins) || nSpins <= 0 || !Number.isFinite(nAmount)) {
      toast("Enter a label, spins, and amount.", { tone: "error" });
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/campaign-packs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          campaignId,
          label: trimmed,
          spins: nSpins,
          amountCents: nAmount,
          bonusSpins: Number.isFinite(nBonus) ? nBonus : 0,
        }),
      });
      if (!res.ok) {
        toast("Couldn't create pack. Try again.", { tone: "error" });
        return;
      }
      toast("Pack added", { tone: "success" });
      setLabel("");
      setSpins("");
      setAmount("");
      setBonus("");
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function updatePack(id: string, patch: Partial<CampaignPack>) {
    setBusy(true);
    try {
      const res = await fetch(`/api/campaign-packs/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        toast("Couldn't update pack. Try again.", { tone: "error" });
        return false;
      }
      toast("Pack updated", { tone: "success" });
      await load();
      return true;
    } finally {
      setBusy(false);
    }
  }

  async function deletePack(id: string) {
    setBusy(true);
    try {
      const res = await fetch(`/api/campaign-packs/${id}`, { method: "DELETE" });
      if (!res.ok) {
        toast("Couldn't delete pack. Try again.", { tone: "error" });
        return;
      }
      toast("Pack deleted", { tone: "success" });
      await load();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card rounded-xl p-5" aria-label="Spin pack presets">
      <h3 className="font-bold text-ink">Spin packs</h3>
      <p className="mt-1 text-sm text-muted">
        Presets for the grant and top-up flow. Each pack bundles a number of
        spins at a price, with optional bonus spins.
      </p>

      {/* Add form */}
      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Field label="Label">
          <input
            className="ff-input"
            placeholder="Starter"
            maxLength={60}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </Field>
        <Field label="Spins">
          <input
            className="ff-input tnum"
            type="number"
            min={1}
            inputMode="numeric"
            placeholder="10"
            value={spins}
            onChange={(e) => setSpins(e.target.value)}
          />
        </Field>
        <Field label="Amount ($)">
          <input
            className="ff-input tnum"
            type="number"
            min={0}
            step="0.01"
            inputMode="decimal"
            placeholder="5.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </Field>
        <Field label="Bonus spins">
          <input
            className="ff-input tnum"
            type="number"
            min={0}
            inputMode="numeric"
            placeholder="0"
            value={bonus}
            onChange={(e) => setBonus(e.target.value)}
          />
        </Field>
      </div>
      <button
        type="button"
        onClick={addPack}
        disabled={busy}
        className="btn-brand mt-3 rounded-lg px-4 py-2 text-sm font-bold disabled:opacity-50"
      >
        Add pack
      </button>

      {/* List */}
      <div className="mt-5">
        {packs === null ? (
          <div className="space-y-2">
            {Array.from({ length: 2 }).map((_, i) => (
              <div key={i} className="skeleton h-14 rounded-lg" />
            ))}
          </div>
        ) : packs.length === 0 ? (
          <EmptyState
            title="No packs yet"
            body="Add a pack above to offer a one-tap spin bundle when granting or topping up fans."
          />
        ) : (
          <ul className="space-y-2">
            {packs.map((p) => (
              <PackRow
                key={p.id}
                pack={p}
                busy={busy}
                onSave={(patch) => updatePack(p.id, patch)}
                onDelete={() => deletePack(p.id)}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function PackRow({
  pack,
  busy,
  onSave,
  onDelete,
}: {
  pack: CampaignPack;
  busy: boolean;
  onSave: (patch: Partial<CampaignPack>) => Promise<boolean>;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [label, setLabel] = useState(pack.label);
  const [spins, setSpins] = useState(String(pack.spins));
  const [amount, setAmount] = useState((pack.amountCents / 100).toFixed(2));
  const [bonus, setBonus] = useState(String(pack.bonusSpins));

  function reset() {
    setLabel(pack.label);
    setSpins(String(pack.spins));
    setAmount((pack.amountCents / 100).toFixed(2));
    setBonus(String(pack.bonusSpins));
  }

  async function save() {
    const nSpins = Number(spins);
    const nAmount = Math.round(Number(amount) * 100);
    const nBonus = bonus ? Number(bonus) : 0;
    if (!label.trim() || !Number.isFinite(nSpins) || nSpins <= 0 || !Number.isFinite(nAmount)) {
      return;
    }
    const ok = await onSave({
      label: label.trim(),
      spins: nSpins,
      amountCents: nAmount,
      bonusSpins: Number.isFinite(nBonus) ? nBonus : 0,
    });
    if (ok) setEditing(false);
  }

  if (editing) {
    return (
      <li className="rounded-lg border border-line bg-base/40 p-3">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <input
            className="ff-input"
            value={label}
            maxLength={60}
            onChange={(e) => setLabel(e.target.value)}
            aria-label="Pack label"
          />
          <input
            className="ff-input tnum"
            type="number"
            min={1}
            value={spins}
            onChange={(e) => setSpins(e.target.value)}
            aria-label="Pack spins"
          />
          <input
            className="ff-input tnum"
            type="number"
            min={0}
            step="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            aria-label="Pack amount in dollars"
          />
          <input
            className="ff-input tnum"
            type="number"
            min={0}
            value={bonus}
            onChange={(e) => setBonus(e.target.value)}
            aria-label="Pack bonus spins"
          />
        </div>
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            onClick={save}
            disabled={busy}
            className="btn-brand rounded-lg px-3 py-1.5 text-xs font-bold disabled:opacity-50"
          >
            Save
          </button>
          <button
            type="button"
            onClick={() => {
              reset();
              setEditing(false);
            }}
            className="rounded-lg border border-line px-3 py-1.5 text-xs font-semibold text-muted transition hover:text-ink"
          >
            Cancel
          </button>
        </div>
      </li>
    );
  }

  return (
    <li className="flex items-center gap-3 rounded-lg border border-line bg-base/40 px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <span className="truncate font-semibold text-ink">{pack.label}</span>
        <p className="tnum mt-0.5 text-xs text-muted">
          {pack.spins} spins · {formatCents(pack.amountCents)}
          {pack.bonusSpins > 0 ? ` · +${pack.bonusSpins} bonus` : ""}
        </p>
      </div>
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="shrink-0 rounded-lg border border-line px-2.5 py-1 text-xs font-semibold text-ink transition hover:bg-white/5"
      >
        Edit
      </button>
      {confirmDelete ? (
        <>
          <button
            type="button"
            onClick={onDelete}
            disabled={busy}
            className="shrink-0 rounded-lg border border-[#ef4444] px-2.5 py-1 text-xs font-semibold text-[#ef4444] transition hover:bg-[#ef4444]/10 disabled:opacity-50"
          >
            Confirm
          </button>
          <button
            type="button"
            onClick={() => setConfirmDelete(false)}
            className="shrink-0 rounded-lg border border-line px-2.5 py-1 text-xs font-semibold text-muted transition hover:text-ink"
          >
            Cancel
          </button>
        </>
      ) : (
        <button
          type="button"
          onClick={() => setConfirmDelete(true)}
          className="shrink-0 rounded-lg border border-line px-2.5 py-1 text-xs font-semibold text-muted transition hover:text-ink"
        >
          Delete
        </button>
      )}
    </li>
  );
}
