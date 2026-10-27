"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RARITY_COLORS } from "@/lib/games/wheel/types";
import type { CampaignPack, DmTemplate, FanAccountSummary } from "@/lib/data/types";
import { useToast } from "@/components/ui/Toast";
import { formatCents } from "@/lib/format";
import { copyToClipboard } from "@/lib/hooks/useClipboard";
import { useOrigin } from "@/lib/hooks/useOrigin";
import { useFocusTrap } from "@/lib/hooks/useFocusTrap";
import { CloseButton, Field, initialsOf } from "./ui";
import { copyLinkToken, fanRowMeta, noLinkMessage, threadFanIds } from "./fansHelpers";
import { TEMPLATE_TOKENS } from "@/lib/winback/template";
import FanDetailDrawer from "@/components/dashboard/FanDetailDrawer";
import PackPresets from "@/components/dashboard/PackPresets";
import ImportFans from "@/components/dashboard/ImportFans";
import { prefersReducedMotion } from "@/lib/sound";
import { isRegular } from "@/lib/glow/glow";
import { REGULAR_MIN_VISITS } from "@/lib/glow/config";

const raised = "border border-[var(--hair)] [background:var(--s1)] shadow-[var(--lift)]";
const ghostBtn =
  "inline-flex min-h-9 items-center justify-center rounded-[9px] border border-line px-[13px] text-[12.5px] font-semibold text-muted transition-colors hover:text-ink";
const FANS_ICON =
  "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM22 21v-2a4 4 0 0 0-3-3.87";
const COPY_ICON = "M9 9h11v11H9zM5 15H4V4h11v1";

// ---------------------------------------------------------------------------
// Fans & links — loaded from the server so they persist across refreshes. Rows
// stay lean (open → drawer); every per-fan power tool lives in the drawer.
// ---------------------------------------------------------------------------
export default function FansPanel({
  initialSearch = "",
  focusMintNonce = 0,
  onMessage,
}: {
  initialSearch?: string;
  focusMintNonce?: number;
  /** Drawer "Message": open this fan's thread in the Inbox section. */
  onMessage?: (fanId: string) => void;
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
  // RM-3: "Regulars" = visited on REGULAR_MIN_VISITS+ of the last 7 days.
  const [regularsOnly, setRegularsOnly] = useState(false);
  const [templates, setTemplates] = useState<DmTemplate[]>([]);
  // Fans with an inbox thread, so the drawer can say whether "Message" has
  // somewhere to go (a creator can't start a thread; fans message first).
  const [threadIds, setThreadIds] = useState<Set<string>>(() => new Set());
  const [managingMessages, setManagingMessages] = useState(false);
  const [importing, setImporting] = useState(false);
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
  const loadThreads = useCallback(async () => {
    const res = await fetch("/api/messages/inbox", { cache: "no-store" });
    if (!res.ok) return;
    const d = (await res.json()) as { threads?: { fanId: string }[] };
    setThreadIds(threadFanIds(d.threads ?? []));
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount
    load();
    loadCampaigns();
    loadTemplates();
    loadWheels();
    loadThreads();
  }, [load, loadCampaigns, loadTemplates, loadWheels, loadThreads]);
  // Re-check threads whenever a drawer opens: a fan may have written since.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- refetch on open (state lands after the fetch)
    if (openFanId) void loadThreads();
  }, [openFanId, loadThreads]);

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

  async function copyLink(acc: FanAccountSummary) {
    const token = copyLinkToken(acc);
    if (!token) {
      toast(noLinkMessage(acc), { tone: "error" });
      return;
    }
    if (await copyToClipboard(`${origin}/spin/${token}`)) {
      toast("Spin link copied", { tone: "success" });
    } else {
      toast("Couldn't copy link.", { tone: "error" });
    }
  }

  // Client-side filtering over the loaded accounts. NOTE: once accounts
  // paginate, this must move server-side so search/filter cover all fans.
  const filtered = (accounts ?? []).filter((a) => {
    const q = search.trim().toLowerCase();
    const matchesSearch = !q || a.name.toLowerCase().includes(q);
    const matchesCampaign =
      !campaignFilter || a.campaignNames.includes(campaignFilter);
    const matchesTag = !tagFilter || a.tags.includes(tagFilter);
    const matchesVisits = !regularsOnly || isRegular(a.visits7 ?? 0);
    return matchesSearch && matchesCampaign && matchesTag && matchesVisits;
  });
  const openAccount = accounts?.find((a) => a.fanId === openFanId) ?? null;

  return (
    <div className="flex flex-col gap-[18px]">
      {/* Mint form — the name input must stay the FIRST `input.ff-input` on
          this view (e2e selector) and keeps the top-bar focus target. */}
      <section aria-labelledby="mint-fan-link" className={`lift-in rounded-2xl p-4 sm:p-5 ${raised}`}>
        <h3 id="mint-fan-link" className="flex items-center gap-[9px] text-[15px] font-bold text-ink">
          <span aria-hidden="true" className="h-4 w-[3px] shrink-0 rounded-sm bg-[var(--brand)]" />
          Mint a fan link
        </h3>
        <p className="mt-1 text-[13px] text-muted text-pretty">
          You create the account; the fan never signs up. Balance and win history
          live on the account, so you can mint fresh links anytime.
        </p>
        <div className="mt-4 grid grid-cols-1 items-end gap-3 sm:grid-cols-2 lg:grid-cols-[2fr_1fr_1fr_1.5fr_auto]">
          <Field label="Fan handle">
            <input
              ref={nameRef}
              className="ff-input w-full"
              placeholder="@username"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field label="Spins">
            <input
              type="number"
              min={1}
              className="ff-input tnum w-full"
              value={spins}
              onChange={(e) => {
                setSpins(Math.max(1, Number(e.target.value)));
                setPackId(null);
              }}
            />
          </Field>
          <Field label="$/spin">
            <input
              type="number"
              min={0}
              step={0.01}
              className="ff-input tnum w-full"
              placeholder="0.00"
              value={perSpin}
              onChange={(e) => {
                setPerSpin(e.target.value);
                setPackId(null);
              }}
            />
          </Field>
          {/* Without this select new links silently become "untracked". */}
          <Field label="Campaign">
            <select
              className="ff-input w-full truncate"
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
            type="button"
            onClick={createAccount}
            disabled={creating}
            className="btn-brand min-h-10 rounded-[10px] px-[18px] text-sm font-bold sm:col-span-2 lg:col-span-1"
          >
            {creating ? "Creating…" : "Create"}
          </button>
        </div>
        {amount && Number(amount) > 0 && spins > 0 && (
          <p className="tnum mt-2 text-[11.5px] text-muted">
            {formatCents(Math.round((Number(amount) * 100) / spins))}/spin ·{" "}
            {formatCents(Math.round(Number(amount) * 100))} total
          </p>
        )}
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
      </section>

      {/* List controls: filters (only once there are fans) + bulk tools. */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        {accounts && accounts.length > 0 ? (
          <div className="flex flex-wrap items-end gap-2.5">
            <Field label="Search">
              <input
                className="ff-input w-full sm:w-[190px]"
                placeholder="Name or handle"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </Field>
            <Field label="Campaign">
              <select
                className="ff-input w-full sm:w-40"
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
                className="ff-input w-full sm:w-36"
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
            <Field label="Visits">
              <select
                className="ff-input w-full sm:w-44"
                value={regularsOnly ? "regulars" : ""}
                onChange={(e) => setRegularsOnly(e.target.value === "regulars")}
              >
                <option value="">All fans</option>
                <option value="regulars">Regulars ({REGULAR_MIN_VISITS}+ of last 7 days)</option>
              </select>
            </Field>
          </div>
        ) : (
          <span />
        )}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setImporting((v) => !v)}
            aria-expanded={importing}
            className={ghostBtn}
          >
            Import fans
          </button>
          <button type="button" onClick={() => setManagingMessages(true)} className={ghostBtn}>
            Manage messages
          </button>
        </div>
      </div>

      {importing && (
        <ImportFans
          campaignId={campaignId || undefined}
          onImported={load}
          onClose={() => setImporting(false)}
        />
      )}

      {accounts === null && (
        <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading fans">
          {[0, 1, 2].map((i) => (
            <div key={i} className="skeleton h-[66px] rounded-[13px]" />
          ))}
        </div>
      )}
      {accounts?.length === 0 && (
        <FansEmpty
          title="No fans yet"
          body="Mint your first fan link above — the account and its balance live here."
        />
      )}
      {accounts && accounts.length > 0 && filtered.length === 0 && (
        <FansEmpty
          title="No fans match"
          body="Nothing matches your search or filters. Clear them, or mint a fresh link above."
        />
      )}
      {filtered.length > 0 && (
        <ul className="flex flex-col gap-2">
          {filtered.map((acc) => (
            <FanRow
              key={acc.fanId}
              account={acc}
              onOpen={() => setOpenFanId(acc.fanId)}
              onCopy={() => copyLink(acc)}
            />
          ))}
        </ul>
      )}

      <FanDetailDrawer
        fanId={openFanId}
        summary={openAccount}
        campaigns={campaigns}
        wheels={wheels}
        templates={templates}
        onClose={() => setOpenFanId(null)}
        onSaved={load}
        onTopUp={topUp}
        onDeleted={load}
        hasThread={!!openFanId && threadIds.has(openFanId)}
        onMessage={
          onMessage
            ? (fanId) => {
                setOpenFanId(null);
                onMessage(fanId);
              }
            : undefined
        }
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

function FansEmpty({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex flex-col items-center gap-2.5 rounded-2xl border border-dashed border-[var(--hair)] px-8 py-12 text-center">
      <span className="grid h-12 w-12 place-items-center rounded-[13px] bg-[color-mix(in_oklab,var(--brand)_12%,transparent)] text-brand">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
          <path d={FANS_ICON} />
        </svg>
      </span>
      <p className="text-[15px] font-bold text-ink">{title}</p>
      <p className="max-w-xs text-[13px] text-muted text-pretty">{body}</p>
    </div>
  );
}

/** One fan row: avatar, name + meta (incl. campaign names), read-only tag
 *  pills, balance, copy-link. The name block is a stretched button, so
 *  Enter/Space (and a click anywhere outside the copy button) opens the
 *  drawer, where tags and every other per-fan tool are edited. */
function FanRow({
  account,
  onOpen,
  onCopy,
}: {
  account: FanAccountSummary;
  onOpen: () => void;
  onCopy: () => void;
}) {
  return (
    <li
      className={`relative flex flex-wrap items-center gap-3 rounded-[13px] px-3.5 py-[13px] transition-[transform,border-color] duration-150 ease-out hover:-translate-y-0.5 hover:border-[color-mix(in_oklab,var(--brand)_45%,var(--hair))] sm:gap-3.5 sm:px-4 ${raised}`}
    >
      <span
        aria-hidden="true"
        className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-[color-mix(in_oklab,var(--brand)_16%,transparent)] text-sm font-bold text-ink"
      >
        {initialsOf(account.name)}
      </span>
      <button
        type="button"
        onClick={onOpen}
        aria-label={"View " + account.name}
        className="min-w-0 flex-1 basis-32 rounded-lg text-left after:absolute after:inset-0 after:rounded-[13px] after:content-['']"
      >
        <p className="truncate text-sm font-semibold text-ink">{account.name}</p>
        {/* Wraps on phones so campaign names are never cut off; one line from sm up. */}
        <p className="tnum break-words text-[12.5px] text-muted sm:truncate" title={fanRowMeta(account)}>
          {fanRowMeta(account)}
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
      {/* Read-only pills on every screen size; on phones they wrap under the
          name so the row never clips them. */}
      {account.tags.length > 0 && (
        <span
          className="flex shrink-0 flex-wrap gap-1.5 max-sm:order-last max-sm:basis-full max-sm:pl-[52px]"
          aria-label={"Tags: " + account.tags.join(", ")}
        >
          {account.tags.slice(0, 3).map((t) => (
            <span
              key={t}
              className="rounded-full bg-[color-mix(in_oklab,var(--brand)_14%,transparent)] px-2.5 py-[3px] text-[11.5px] font-semibold text-brand"
            >
              {t}
            </span>
          ))}
          {account.tags.length > 3 && (
            <span className="tnum rounded-full border border-line px-2 py-[3px] text-[11px] font-semibold text-muted">
              +{account.tags.length - 3}
            </span>
          )}
        </span>
      )}
      <span className="tnum shrink-0 text-[13.5px] font-semibold text-muted">
        <span className="text-ink">{account.spinsRemaining}</span> spins
      </span>
      <button
        type="button"
        onClick={onCopy}
        aria-label={"Copy spin link for " + account.name}
        title="Copy spin link"
        className="relative z-10 grid h-[34px] w-[34px] shrink-0 place-items-center rounded-[9px] border border-line text-muted transition-colors hover:text-ink"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
          <path d={COPY_ICON} />
        </svg>
      </button>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Saved DM templates: list / add / delete. `{link}` is swapped for a fan's full
// spin URL (and {name} {lastWin} {days} {creator} for the rest, fillTemplate)
// when the drawer's "Copy DM" or the win-back list uses a template.
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
    <div className="fixed inset-0 z-50 lg:flex lg:items-center lg:justify-center lg:p-4">
      <div className="fade-in absolute inset-0 bg-black/60" onClick={onClose} aria-hidden="true" />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Manage DM templates"
        className="modal-in absolute inset-x-0 bottom-0 flex max-h-[85dvh] flex-col overflow-y-auto rounded-t-[28px] border-t border-[#2a2533] bg-surface shadow-2xl lg:relative lg:inset-auto lg:max-h-[80vh] lg:w-full lg:max-w-lg lg:rounded-2xl lg:border lg:border-[var(--hair)] lg:shadow-[var(--lift)]"
      >
        <div className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-[#1f1b27] bg-surface px-5 py-4">
          <div>
            <h2 className="text-[17px] font-bold text-ink">DM templates</h2>
            <p className="mt-0.5 text-xs text-muted">
              Use <code className="rounded bg-base px-1">{"{link}"}</code> where the
              fan&rsquo;s spin link should go. Also:{" "}
              {TEMPLATE_TOKENS.filter((t) => t !== "{link}").map((t, i) => (
                <span key={t}>
                  {i > 0 && " "}
                  <code className="rounded bg-base px-1">{t}</code>
                </span>
              ))}
              .
            </p>
          </div>
          <CloseButton onClick={onClose} />
        </div>

        <div className="space-y-5 px-5 py-5">
          <div className="space-y-2">
            {templates.length === 0 && (
              <p className="text-sm text-muted">No templates yet. Add one below.</p>
            )}
            {templates.map((t) => (
              <div key={t.id} className="rounded-[10px] border border-[var(--hair)] p-3 [background:var(--s2)]">
                <div className="flex items-start justify-between gap-2">
                  <p className="min-w-0 truncate text-sm font-semibold text-ink">
                    {t.title}
                  </p>
                  <button
                    type="button"
                    onClick={() => remove(t.id)}
                    aria-label={`Delete template ${t.title}`}
                    className="shrink-0 rounded-lg px-2 py-0.5 text-xs font-semibold text-muted transition-colors hover:text-[#f87171]"
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

          <div className="space-y-3 border-t border-[#1f1b27] pt-4">
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
              className="btn-brand min-h-10 rounded-[10px] px-4 text-sm font-bold disabled:opacity-50"
            >
              {saving ? "Saving…" : "Add template"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
