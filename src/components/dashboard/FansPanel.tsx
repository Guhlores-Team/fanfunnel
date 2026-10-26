"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { RARITY_COLORS } from "@/lib/games/wheel/types";
import type { CampaignPack, DmTemplate, FanAccountSummary } from "@/lib/data/types";
import { useToast } from "@/components/ui/Toast";
import { formatCents } from "@/lib/format";
import { useClipboard, copyToClipboard } from "@/lib/hooks/useClipboard";
import { useOrigin } from "@/lib/hooks/useOrigin";
import { useFocusTrap } from "@/lib/hooks/useFocusTrap";
import { EmptyState, Field, TagEditor } from "./ui";
import FanDetailDrawer from "@/components/dashboard/FanDetailDrawer";
import PackPresets from "@/components/dashboard/PackPresets";
import ImportFans from "@/components/dashboard/ImportFans";
import { prefersReducedMotion } from "@/lib/sound";

// Code-split the qrcode-pulling QrButton so the dashboard bundle doesn't carry it.
const QrButton = dynamic(() => import("@/components/dashboard/QrButton"), { ssr: false });

// ---------------------------------------------------------------------------
// Fans & links — now loaded from the server so they persist across refreshes.
// ---------------------------------------------------------------------------
export default function FansPanel({
  initialSearch = "",
  focusMintNonce = 0,
}: {
  initialSearch?: string;
  focusMintNonce?: number;
}) {
  const [accounts, setAccounts] = useState<FanAccountSummary[] | null>(null);
  const [name, setName] = useState("");
  const [spins, setSpins] = useState(3);
  // Price the creator types is PER SPIN; it's its own state so typing isn't
  // fought by a derived value. The total is computed from perSpin × spins.
  const [perSpin, setPerSpin] = useState<string>("");
  const amount = perSpin && spins > 0 ? (Number(perSpin) * spins).toFixed(2) : "";
  const [campaignId, setCampaignId] = useState<string>("");
  // Until the creator picks a campaign themselves, new links default to the
  // newest ACTIVE campaign rather than silently landing in "untracked".
  const campaignTouched = useRef(false);
  // The pack a preset filled in, if any. Sent to the server which resolves it
  // authoritatively; cleared on any manual override so we don't mis-attribute.
  const [packId, setPackId] = useState<string | null>(null);
  const [campaigns, setCampaigns] = useState<
    { id: string; name: string; isActive?: boolean }[]
  >([]);
  const [wheels, setWheels] = useState<{ id: string; title: string }[]>([]);
  const [creating, setCreating] = useState(false);
  const [openFanId, setOpenFanId] = useState<string | null>(null);
  const [search, setSearch] = useState(initialSearch);
  const [campaignFilter, setCampaignFilter] = useState<string>("");
  const [tagFilter, setTagFilter] = useState<string>("");
  const [templates, setTemplates] = useState<DmTemplate[]>([]);
  const [managingMessages, setManagingMessages] = useState(false);
  const toast = useToast();
  const origin = useOrigin();

  // Top-bar "New fan link" lands here: focus the mint form's name field.
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focusMintNonce === 0) return;
    nameRef.current?.focus({ preventScroll: true });
    nameRef.current?.scrollIntoView({
      behavior: prefersReducedMotion() ? "auto" : "smooth",
      block: "center",
    });
  }, [focusMintNonce]);

  const load = useCallback(async () => {
    const res = await fetch("/api/fans", { cache: "no-store" });
    if (res.ok) setAccounts((await res.json()).fans ?? []);
    else setAccounts([]);
  }, []);
  const loadCampaigns = useCallback(async () => {
    const res = await fetch("/api/campaigns", { cache: "no-store" });
    if (!res.ok) return;
    const list = ((await res.json()).campaigns ?? []) as {
      id: string;
      name: string;
      isActive?: boolean;
    }[];
    setCampaigns(list);
    // Default the add-fan form to the newest active campaign so links are
    // tracked by default — but never fight a choice the creator already made.
    if (!campaignTouched.current) {
      const def = list.find((c) => c.isActive !== false);
      if (def) setCampaignId((cur) => (cur === "" ? def.id : cur));
    }
  }, []);
  const loadTemplates = useCallback(async () => {
    const res = await fetch("/api/dm-templates", { cache: "no-store" });
    if (res.ok) setTemplates((await res.json()).templates ?? []);
  }, []);
  const loadWheels = useCallback(async () => {
    const res = await fetch("/api/wheels", { cache: "no-store" });
    if (res.ok) {
      const d = (await res.json()) as { wheels?: { id: string; title: string }[] };
      setWheels((d.wheels ?? []).map((w) => ({ id: w.id, title: w.title })));
    }
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount
    load();
    loadCampaigns();
    loadTemplates();
    loadWheels();
  }, [load, loadCampaigns, loadTemplates, loadWheels]);

  // Every distinct tag across loaded accounts, for the tag filter dropdown.
  const allTags = useMemo(() => {
    const set = new Set<string>();
    for (const a of accounts ?? []) for (const t of a.tags) set.add(t);
    return [...set].sort((x, y) => x.localeCompare(y));
  }, [accounts]);

  async function call(body: object) {
    const res = await fetch("/api/passes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok || !data.token) {
      toast(
        data.error === "no_wheel"
          ? "Create and save a wheel first, then generate fan links."
          : "Couldn't create link. Are you signed in?",
        { tone: "error" }
      );
      return null;
    }
    return data as { token: string; fanId: string };
  }

  async function createAccount() {
    setCreating(true);
    try {
      const amountDollars = amount ? Number(amount) : undefined;
      const data = await call({
        name: name.trim(),
        spins,
        campaignId: campaignId || undefined,
        amountDollars: amountDollars || undefined,
        ...(packId ? { packId } : {}),
      });
      if (data) {
        setName("");
        setPerSpin("");
        setPackId(null);
        await load();
      }
    } finally {
      setCreating(false);
    }
  }

  // Top up an existing fan. The data layer tops up the balance without minting a
  // new link, and can tag the grant to a (possibly different) campaign.
  async function topUp(
    fanId: string,
    addSpins: number,
    amountDollars?: number,
    topUpCampaignId?: string,
    packId?: string | null,
    wheelId?: string
  ) {
    const data = await call({
      fanId,
      spins: addSpins,
      amountDollars: amountDollars || undefined,
      campaignId: topUpCampaignId || undefined,
      wheelId: wheelId || undefined,
      ...(packId ? { packId } : {}),
    });
    if (data) await load();
  }

  // Client-side filtering over the loaded accounts. NOTE: once accounts
  // paginate, this must move server-side so search/filter cover all fans.
  const filtered = (accounts ?? []).filter((a) => {
    const q = search.trim().toLowerCase();
    const matchesSearch = !q || a.name.toLowerCase().includes(q);
    const matchesCampaign =
      !campaignFilter || a.campaignNames.includes(campaignFilter);
    const matchesTag = !tagFilter || a.tags.includes(tagFilter);
    return matchesSearch && matchesCampaign && matchesTag;
  });

  return (
    <div className="max-w-2xl">
      <div className="card rounded-xl p-5">
        <h3 className="font-bold text-ink">Create a fan account</h3>
        <p className="mt-1 text-sm text-muted">
          You create the account; the fan never signs up. Balance and win history
          live on the account, so you can mint fresh links anytime.
        </p>
        <div className="mt-4 flex flex-wrap items-start gap-3">
          <Field label="Fan name / handle">
            <input
              ref={nameRef}
              className="ff-input w-44"
              placeholder="@bigfan"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field label="Spins to grant">
            <input
              type="number"
              min={1}
              className="ff-input tnum w-24"
              value={spins}
              onChange={(e) => {
                setSpins(Math.max(1, Number(e.target.value)));
                setPackId(null);
              }}
            />
          </Field>
          <Field label="$ per spin (optional)">
            <input
              type="number"
              min={0}
              step={0.01}
              className="ff-input tnum w-28"
              placeholder="0.00"
              value={perSpin}
              onChange={(e) => {
                setPerSpin(e.target.value);
                setPackId(null);
              }}
            />
            {amount && Number(amount) > 0 && spins > 0 && (
              <p className="mt-1 text-[11px] text-muted">
                {formatCents(Math.round((Number(amount) * 100) / spins))}/spin ·{" "}
                {formatCents(Math.round(Number(amount) * 100))} total
              </p>
            )}
          </Field>
          <Field label="Campaign (optional)">
            <select
              className="ff-input w-44 max-w-full truncate"
              title={campaigns.find((c) => c.id === campaignId)?.name}
              value={campaignId}
              onChange={(e) => {
                campaignTouched.current = true;
                setCampaignId(e.target.value);
                setPackId(null);
              }}
            >
              <option value="">No campaign (untracked)</option>
              {campaigns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          <button
            onClick={createAccount}
            disabled={creating}
            className="btn-brand mt-5 rounded-lg px-5 py-2 text-sm font-bold"
          >
            {creating ? "Creating…" : "Create account"}
          </button>
        </div>
        {campaignId && (
          <div className="mt-3">
            <PackPresets
              campaignId={campaignId}
              onPick={(p: CampaignPack) => {
                setSpins(p.spins);
                setPerSpin(p.spins > 0 ? (p.amountCents / 100 / p.spins).toFixed(2) : "");
                setPackId(p.id);
              }}
            />
          </div>
        )}
      </div>

      <div className="mt-6 flex flex-wrap items-end justify-between gap-3">
        {accounts && accounts.length > 0 ? (
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Search fans">
              <input
                className="ff-input w-56"
                placeholder="Name or handle"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </Field>
            <Field label="Campaign">
              <select
                className="ff-input w-44"
                value={campaignFilter}
                onChange={(e) => setCampaignFilter(e.target.value)}
              >
                <option value="">All campaigns</option>
                {campaigns.map((c) => (
                  <option key={c.id} value={c.name}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Tag">
              <select
                className="ff-input w-40"
                value={tagFilter}
                onChange={(e) => setTagFilter(e.target.value)}
              >
                <option value="">All tags</option>
                {allTags.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        ) : (
          <span />
        )}
        <button
          type="button"
          onClick={() => setManagingMessages(true)}
          className="rounded-lg border border-line px-3 py-1.5 text-xs font-semibold text-muted transition hover:text-ink"
        >
          Manage messages
        </button>
      </div>

      <div className="mt-4">
        <ImportFans campaignId={campaignId || undefined} onImported={load} />
      </div>

      <div className="mt-6 space-y-4">
        {accounts === null && (
          <>
            {Array.from({ length: 2 }).map((_, i) => (
              <div key={i} className="skeleton h-24 rounded-xl" />
            ))}
          </>
        )}
        {accounts?.length === 0 && (
          <EmptyState title="No fans yet" body="Create your first fan account above to mint a link." />
        )}
        {accounts && accounts.length > 0 && filtered.length === 0 && (
          <EmptyState title="No matches" body="No fans match your search or campaign filter." />
        )}
        {filtered.map((acc) => (
          <AccountCard
            key={acc.fanId}
            account={acc}
            origin={origin}
            campaigns={campaigns}
            wheels={wheels}
            templates={templates}
            onTopUp={topUp}
            onOpen={setOpenFanId}
            onDeleted={load}
            refresh={load}
          />
        ))}
      </div>
      <FanDetailDrawer
        fanId={openFanId}
        onClose={() => setOpenFanId(null)}
        onSaved={load}
      />
      {managingMessages && (
        <ManageMessages
          templates={templates}
          onClose={() => setManagingMessages(false)}
          refresh={loadTemplates}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Saved DM templates: list / add / delete. `{link}` is the placeholder swapped
// for a fan's full spin URL when the "Copy DM" control on a card is used.
// ---------------------------------------------------------------------------
function ManageMessages({
  templates,
  onClose,
  refresh,
}: {
  templates: DmTemplate[];
  onClose: () => void;
  refresh: () => void;
}) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);
  const toast = useToast();
  // Focus-trap the dialog: focus in on open, cycle Tab, Escape to close, restore
  // focus on close.
  const dialogRef = useFocusTrap<HTMLDivElement>({ active: true, onEscape: onClose });

  async function add() {
    if (!title.trim() || !body.trim()) return;
    setSaving(true);
    try {
      const res = await fetch("/api/dm-templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: title.trim(), body }),
      });
      if (res.ok) {
        setTitle("");
        setBody("");
        toast("Template saved", { tone: "success" });
        refresh();
      } else {
        toast("Couldn't save template.", { tone: "error" });
      }
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string) {
    const res = await fetch("/api/dm-templates/" + id, { method: "DELETE" });
    if (res.ok) {
      toast("Template deleted", { tone: "info" });
      refresh();
    } else {
      toast("Couldn't delete template.", { tone: "error" });
    }
  }

  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} aria-hidden="true" />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Manage DM templates"
        className="absolute inset-x-0 bottom-0 flex max-h-[85dvh] flex-col overflow-y-auto rounded-t-2xl border border-line bg-surface shadow-2xl sm:inset-x-auto sm:left-1/2 sm:top-1/2 sm:max-h-[80vh] sm:w-full sm:max-w-lg sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl"
      >
        <div className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-line bg-surface px-5 py-4">
          <div>
            <h2 className="text-lg font-bold text-ink">DM templates</h2>
            <p className="mt-0.5 text-xs text-muted">
              Use <code className="rounded bg-base px-1">{"{link}"}</code> where the
              fan&rsquo;s spin link should go.
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 rounded-lg border border-line px-2.5 py-1.5 text-sm font-semibold text-muted transition hover:text-ink"
          >
            ✕
          </button>
        </div>

        <div className="space-y-5 px-5 py-5">
          <div className="space-y-2">
            {templates.length === 0 && (
              <p className="text-sm text-muted">No templates yet. Add one below.</p>
            )}
            {templates.map((t) => (
              <div key={t.id} className="rounded-lg border border-line bg-base/40 p-3">
                <div className="flex items-start justify-between gap-2">
                  <p className="min-w-0 truncate text-sm font-semibold text-ink">
                    {t.title}
                  </p>
                  <button
                    type="button"
                    onClick={() => remove(t.id)}
                    aria-label={`Delete template ${t.title}`}
                    className="shrink-0 rounded-lg px-2 py-0.5 text-xs font-semibold text-muted transition hover:text-red-500"
                  >
                    Delete
                  </button>
                </div>
                <p className="mt-1 whitespace-pre-wrap break-words text-xs text-muted">
                  {t.body}
                </p>
              </div>
            ))}
          </div>

          <div className="space-y-3 border-t border-line pt-4">
            <Field label="Title">
              <input
                className="ff-input w-full"
                placeholder="Spin invite"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </Field>
            <Field label="Message">
              <textarea
                className="ff-input w-full"
                rows={3}
                placeholder="Hey! Here's your spin link: {link}"
                value={body}
                onChange={(e) => setBody(e.target.value)}
              />
            </Field>
            <button
              type="button"
              onClick={add}
              disabled={saving || !title.trim() || !body.trim()}
              className="btn-brand rounded-lg px-4 py-2 text-sm font-bold disabled:opacity-50"
            >
              {saving ? "Saving…" : "Add template"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function AccountCard({
  account,
  origin,
  campaigns,
  wheels,
  templates,
  onTopUp,
  onOpen,
  onDeleted,
  refresh,
}: {
  account: FanAccountSummary;
  origin: string;
  campaigns: { id: string; name: string }[];
  wheels: { id: string; title: string }[];
  templates: DmTemplate[];
  onTopUp: (
    fanId: string,
    addSpins: number,
    amountDollars?: number,
    campaignId?: string,
    packId?: string | null,
    wheelId?: string
  ) => void;
  onOpen: (fanId: string) => void;
  onDeleted: () => void;
  refresh: () => void;
}) {
  // Which wheel the top-up targets (per-wheel spins). Default to the fan's
  // first existing wheel-pass, else the first wheel.
  const [topUpWheelId, setTopUpWheelId] = useState<string>(
    account.passes[0]?.wheelId ?? wheels[0]?.id ?? ""
  );
  const [topUp, setTopUp] = useState(3);
  const [toppingUp, setToppingUp] = useState(false);
  // Per-spin price as its own state (see FansPanel) so typing two digits works.
  const [perSpin, setPerSpin] = useState<string>("");
  const amount = perSpin && topUp > 0 ? (Number(perSpin) * topUp).toFixed(2) : "";
  // Default the top-up to a campaign this fan already belongs to, so revenue
  // doesn't silently fall into "untracked" (a top-up = more spins on a wheel).
  const [campaignId, setCampaignId] = useState<string>(() => {
    const match = campaigns.find((c) => account.campaignNames.includes(c.name));
    return match?.id ?? "";
  });
  // The pack a preset filled in, if any. Sent to the server which resolves it
  // authoritatively; cleared on any manual override so we don't mis-attribute.
  const [packId, setPackId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [savingTags, setSavingTags] = useState(false);
  const toast = useToast();

  // Surface only the primary link by default; the rest are revealed on demand.
  const primaryToken = account.primaryToken ?? account.links[0]?.token ?? null;
  const primaryUrl = primaryToken ? `${origin}/spin/${primaryToken}` : null;

  // Persist a new tag set, then refresh the list so chips/filters stay in sync.
  async function saveTags(next: string[]) {
    setSavingTags(true);
    try {
      const res = await fetch("/api/fans/" + account.fanId, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tags: next }),
      });
      if (res.ok) refresh();
      else toast("Couldn't save tags.", { tone: "error" });
    } catch {
      toast("Couldn't save tags.", { tone: "error" });
    } finally {
      setSavingTags(false);
    }
  }

  // Fill {link} with the fan's full spin URL and copy the message.
  async function copyDm(template: DmTemplate) {
    if (!primaryUrl) {
      toast("No link to insert yet.", { tone: "error" });
      return;
    }
    const text = template.body.split("{link}").join(primaryUrl);
    if (await copyToClipboard(text)) {
      toast("DM copied", { tone: "success" });
    } else {
      toast("Couldn't copy DM.", { tone: "error" });
    }
  }

  async function handleDelete() {
    setDeleting(true);
    try {
      const res = await fetch("/api/fans/" + account.fanId, { method: "DELETE" });
      if (res.ok) {
        toast("Fan deleted", { tone: "success" });
        onDeleted();
      } else {
        toast("Couldn't delete fan. Are you signed in?", { tone: "error" });
        setConfirmDelete(false);
      }
    } catch {
      toast("Couldn't delete fan. Are you signed in?", { tone: "error" });
      setConfirmDelete(false);
    } finally {
      setDeleting(false);
    }
  }


  return (
    <div className="card rounded-xl p-4">
      <div className="flex items-start justify-between gap-2">
        <button
          type="button"
          onClick={() => onOpen(account.fanId)}
          aria-label={"View " + account.name}
          className="min-w-0 flex-1 rounded-lg text-left transition hover:opacity-80"
        >
          <p className="truncate font-bold text-ink">{account.name}</p>
          <p className="text-xs text-muted">
            <span className="tnum font-semibold text-ink">{account.spinsRemaining}</span> spins left
            · {account.grantedTotal} granted · {account.links.length} link
            {account.links.length === 1 ? "" : "s"}
            {account.lastWin && (
              <>
                {" "}
                · last won{" "}
                <span style={{ color: RARITY_COLORS[account.lastWin.rarity] }}>
                  {account.lastWin.label}
                </span>
              </>
            )}
          </p>
        </button>

        {confirmDelete ? (
          <div className="flex shrink-0 items-center gap-1.5 text-xs">
            <button
              type="button"
              onClick={handleDelete}
              disabled={deleting}
              aria-label={"Confirm delete " + account.name}
              className="rounded-full border border-red-500/60 px-3 py-1 font-bold text-red-500 transition hover:bg-red-500/10 disabled:opacity-50"
            >
              {deleting ? "Deleting…" : "Delete?"}
            </button>
            <button
              type="button"
              onClick={() => setConfirmDelete(false)}
              disabled={deleting}
              aria-label="Cancel delete"
              className="rounded-full border border-line px-3 py-1 font-semibold text-muted transition hover:text-ink disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmDelete(true)}
            aria-label={"Delete " + account.name}
            className="shrink-0 rounded-full border border-line px-3 py-1 text-xs font-semibold text-muted transition hover:border-red-500/60 hover:text-red-500"
          >
            Delete
          </button>
        )}
      </div>

      {/* Spend + campaign chips */}
      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
        <span className="text-muted">
          <span className="tnum font-semibold text-ink">{formatCents(account.totalSpent)}</span> spent
        </span>
        {account.campaignNames.map((c) => (
          <span
            key={c}
            className="rounded-full border border-line px-2 py-0.5 font-semibold text-muted"
          >
            {c}
          </span>
        ))}
      </div>

      {/* Tags: chips + quick editor (presets + free-text). */}
      <div className="mt-3">
        <TagEditor tags={account.tags} onChange={saveTags} disabled={savingTags} compact />
      </div>

      {/* Share actions: QR for the primary link + copy a DM from a template. */}
      {primaryUrl && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <QrButton url={primaryUrl} label={`${account.name} spin link`} />
          <CopyDmMenu templates={templates} onPick={copyDm} />
        </div>
      )}

      {/* Top-up row: spins + optional $ + optional campaign tag. Align to the
          top so the "$X total" helper under $/spin doesn't shove Spins down. */}
      <div className="mt-3 flex flex-wrap items-start gap-2">
        <Field label="Spins">
          <input
            type="number"
            min={1}
            className="ff-input tnum w-16 text-right"
            value={topUp}
            onChange={(e) => {
              setTopUp(Math.max(1, Number(e.target.value)));
              setPackId(null);
            }}
          />
        </Field>
        <Field label="$ per spin">
          <input
            type="number"
            min={0}
            step={0.01}
            className="ff-input tnum w-24"
            placeholder="0.00"
            value={perSpin}
            onChange={(e) => {
              setPerSpin(e.target.value);
              setPackId(null);
            }}
          />
          {amount && Number(amount) > 0 && topUp > 0 && (
            <p className="mt-1 text-[11px] text-muted">
              {formatCents(Math.round(Number(amount) * 100))} total
            </p>
          )}
        </Field>
        <Field label="Wheel">
          <select
            className="ff-input w-40"
            value={topUpWheelId}
            onChange={(e) => setTopUpWheelId(e.target.value)}
          >
            {wheels.length === 0 && <option value="">Active wheel</option>}
            {wheels.map((w) => (
              <option key={w.id} value={w.id}>
                {w.title}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Campaign">
          <select
            className="ff-input w-40"
            value={campaignId}
            onChange={(e) => {
              setCampaignId(e.target.value);
              setPackId(null);
            }}
          >
            <option value="">No campaign (untracked)</option>
            {campaigns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <button
          disabled={toppingUp}
          onClick={async () => {
            if (toppingUp) return; // in-flight guard: a double-click must not double-grant spins/spend
            setToppingUp(true);
            try {
              await onTopUp(
                account.fanId,
                topUp,
                amount ? Number(amount) || undefined : undefined,
                campaignId || undefined,
                packId,
                topUpWheelId || undefined
              );
              setPerSpin("");
              setPackId(null);
            } finally {
              setToppingUp(false);
            }
          }}
          className="mt-5 rounded-lg border border-[var(--brand)]/50 px-3 py-1.5 text-xs font-bold text-[var(--brand)] transition hover:bg-[color-mix(in_oklab,var(--brand)_12%,transparent)] disabled:opacity-50"
        >
          {toppingUp ? "Topping up…" : "Top up"}
        </button>
      </div>
      {campaignId && (
        <div className="mt-3">
          <PackPresets
            campaignId={campaignId}
            onPick={(p: CampaignPack) => {
              setTopUp(p.spins);
              setPerSpin(p.spins > 0 ? (p.amountCents / 100 / p.spins).toFixed(2) : "");
              setPackId(p.id);
            }}
          />
        </div>
      )}

      {/* Per-wheel links: each wheel the fan plays has its OWN link + spin
          balance, so a Spooky top-up and a Summer top-up are separate. */}
      {account.passes.length > 0 ? (
        <div className="mt-3 space-y-2">
          {account.passes.map((p) => (
            <div key={p.token} className="rounded-lg border border-line bg-base/40 p-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate text-sm font-semibold text-ink">
                  🎡 {p.wheelTitle}
                </span>
                <span className="tnum shrink-0 text-xs font-bold text-[var(--brand)]">
                  {p.spinsRemaining} spins
                </span>
              </div>
              {p.campaignName && (
                <span className="mt-0.5 inline-block rounded-full bg-white/5 px-2 py-0.5 text-[10px] text-muted">
                  {p.campaignName}
                </span>
              )}
              <div className="mt-2">
                <LinkRow url={`${origin}/spin/${p.token}`} latest={false} />
              </div>
            </div>
          ))}
        </div>
      ) : (
        primaryToken && (
          <div className="mt-3">
            <LinkRow url={`${origin}/spin/${primaryToken}`} latest />
          </div>
        )
      )}
    </div>
  );
}

// A small dropdown of saved DM templates. Picking one fills {link} and copies.
function CopyDmMenu({
  templates,
  onPick,
}: {
  templates: DmTemplate[];
  onPick: (t: DmTemplate) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={wrapRef} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-haspopup="menu"
        className="rounded-lg border border-line px-3 py-1.5 text-xs font-semibold text-ink transition hover:bg-white/5"
      >
        Copy DM
      </button>
      {open && (
        <div
          id={menuId}
          role="menu"
          className="absolute left-0 z-30 mt-2 w-64 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-line bg-surface py-1 shadow-2xl"
        >
          {templates.length === 0 ? (
            <p className="px-3 py-2 text-xs text-muted">
              No templates yet. Add one in &ldquo;Manage messages&rdquo;.
            </p>
          ) : (
            templates.map((t) => (
              <button
                key={t.id}
                type="button"
                role="menuitem"
                onClick={() => {
                  onPick(t);
                  setOpen(false);
                }}
                className="block w-full px-3 py-2 text-left transition hover:bg-white/5"
              >
                <span className="block truncate text-sm font-semibold text-ink">
                  {t.title}
                </span>
                <span className="block truncate text-xs text-muted">{t.body}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function LinkRow({ url, latest }: { url: string; latest: boolean }) {
  const { copy, copied } = useClipboard();
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-base/40 p-2.5">
      <p className="min-w-0 flex-1 truncate text-xs text-muted">
        {url}
        {latest && (
          <span className="ml-2 rounded bg-[color-mix(in_oklab,var(--brand)_20%,transparent)] px-1.5 py-0.5 text-[10px] font-bold text-[var(--brand)]">
            NEWEST
          </span>
        )}
      </p>
      <div className="flex shrink-0 items-center gap-2">
        <button
          onClick={() => void copy(url)}
          className="rounded-lg border border-line px-3 py-1.5 text-xs font-semibold text-ink transition hover:bg-white/5"
        >
          {copied ? "Copied" : "Copy"}
        </button>
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="rounded-lg border border-line px-3 py-1.5 text-xs font-semibold text-ink transition hover:bg-white/5"
        >
          Open
        </a>
      </div>
    </div>
  );
}
