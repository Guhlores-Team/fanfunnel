"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { loadJson } from "@/lib/hooks/loadJson";
import LoadFailed from "./LoadFailed";
import { shareOrCopy } from "./shareLink";
import { RARITY_COLORS } from "@/lib/games/wheel/types";
import type { CampaignPack, DmTemplate, FanAccountSummary, WheelSummary } from "@/lib/data/types";
import { useToast } from "@/components/ui/Toast";
import { formatCents } from "@/lib/format";
import { copyToClipboard } from "@/lib/hooks/useClipboard";
import { useOrigin } from "@/lib/hooks/useOrigin";
import { useFocusTrap } from "@/lib/hooks/useFocusTrap";
import { CloseButton, Field, initialsOf } from "./ui";
import { copyLinkToken, fanRowMeta, noLinkMessage, threadFanIds } from "./fansHelpers";
import { fanFromSearch, fanHref, sectionHref } from "./dashboardSection";
import { TEMPLATE_TOKENS } from "@/lib/winback/template";
import FanDetailDrawer from "@/components/dashboard/FanDetailDrawer";
import PackPresets from "@/components/dashboard/PackPresets";
import ImportFans from "@/components/dashboard/ImportFans";
import { prefersReducedMotion } from "@/lib/sound";
import { isRegular } from "@/lib/glow/glow";
import { REGULAR_MIN_VISITS } from "@/lib/glow/config";
import { creatorIntent, creatorIntentComplete, creatorIntentReceipt } from "./creatorIntent";
import { GrantRefusedError, grantRefusalMessage, isDefinitiveRefusal, parseSpinCount } from "./grantErrors";
import { useCreatorDraft, useCreatorLeave } from "./CreatorDrafts";
import CreatorRequestRecovery from "./CreatorRequestRecovery";
import { GameName } from "./GameChoice";
import { linkGame, mintPlaysReason } from "./gameAssignment";

// Code-split the qrcode-pulling QrButton so the dashboard bundle doesn't carry it.
// Reserve the button's footprint while the code splits in, so the minted card
// above the list keeps its height and the fresh row's scroll stays put.
const QrButton = dynamic(() => import("@/components/dashboard/QrButton"), {
  ssr: false,
  loading: () => <span aria-hidden="true" className="inline-flex min-h-9 min-w-[4.5rem] rounded-[9px] border border-transparent" />,
});

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
  onOpenGame,
  onOpenCampaigns,
}: {
  initialSearch?: string;
  focusMintNonce?: number;
  /** Drawer "Message": open this fan's thread in the Inbox section. */
  onMessage?: (fanId: string) => void;
  /** "Edit game": open a game in the Games editor. */
  onOpenGame?: (wheelId: string) => void;
  /** Jump to Campaigns (to choose the game a campaign plays). */
  onOpenCampaigns?: () => void;
}) {
  const [accounts, setAccounts] = useState<FanAccountSummary[] | null>(null);
  const [accountsError, setAccountsError] = useState<unknown>(null);
  // C12: the link just minted, shown as a card with Copy / Share / QR.
  const [minted, setMinted] = useState<{ fanId: string; name: string; url: string } | null>(null);
  const mintedRef = useRef<HTMLDivElement>(null);
  const [name, setName] = useState("");
  // Held as text so the field can be cleared; parsed (integer ≥ 1) on submit.
  const [spins, setSpins] = useState("3");
  // Price the creator types is PER SPIN; it's its own state so typing isn't
  // fought by a derived value. The total is computed from perSpin × spins.
  const [perSpin, setPerSpin] = useState<string>("");
  const spinCount = parseSpinCount(spins) ?? 0;
  const amount = perSpin && spinCount > 0 ? (Number(perSpin) * spinCount).toFixed(2) : "";
  const [campaignId, setCampaignId] = useState<string>("");
  // Until the creator picks a campaign themselves, new links default to the
  // newest ACTIVE campaign rather than silently landing in "untracked".
  const campaignTouched = useRef(false);
  // The pack a preset filled in, if any. Sent to the server which resolves it
  // authoritatively; cleared on any manual override so we don't mis-attribute.
  const [packId, setPackId] = useState<string | null>(null);
  const [packUnits, setPackUnits] = useState(1);
  const [campaigns, setCampaigns] = useState<
    { id: string; name: string; isActive?: boolean; pinnedWheelId?: string | null }[]
  >([]);
  const [wheels, setWheels] = useState<WheelSummary[]>([]);
  const [now, setNow] = useState(() => new Date());
  const [creating, setCreating] = useState(false);
  const [newFanUncertain, setNewFanUncertain] = useState(false);
  const creatingRef = useRef(false);
  useCreatorDraft("new-fan", "this new fan link", !!name.trim() || perSpin !== "" || !!packId, creating || newFanUncertain);
  const leave = useCreatorLeave();
  // m5: the open drawer is its own history entry (?section=fans&fan=<id>), so
  // Back (the phone's, above all) closes it instead of leaving the dashboard.
  // A drawer in the URL on mount (a reload, or Back from another section)
  // opens again.
  const [openFanId, setOpenFanId] = useState<string | null>(null);
  useEffect(() => {
    // Read after hydration: the server render has no drawer open.
    const fan = fanFromSearch(window.location.search);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- restore the drawer named in the URL once mounted
    if (fan) setOpenFanId(fan);
  }, []);
  const openFanRef = useRef(openFanId);
  useEffect(() => { openFanRef.current = openFanId; }, [openFanId]);
  // Whether the current history entry is one this panel pushed for the drawer
  // (closing then steps back over it), and a step back to ignore.
  const drawerEntry = useRef(false);
  const ignorePop = useRef(false);
  const openFan = useCallback((id: string) => {
    setOpenFanId(id);
    const href = fanHref(id, window.location.pathname);
    if (drawerEntry.current) window.history.replaceState({ ffFan: id }, "", href);
    else window.history.pushState({ ffFan: id }, "", href);
    drawerEntry.current = true;
  }, []);
  /** `leaving`: another section is opening, which writes its own entry. */
  const closeFan = useCallback((leaving = false) => {
    setOpenFanId(null);
    if (leaving) { drawerEntry.current = false; return; }
    if (drawerEntry.current) {
      drawerEntry.current = false;
      ignorePop.current = true;
      window.history.back();
    } else if (fanFromSearch(window.location.search)) {
      const state = window.history.state as { ffFrom?: unknown } | null;
      if (typeof state?.ffFrom === "string" && state.ffFrom !== "fans") {
        // WC-05: opened from another section (the Fulfilment queue): go back
        // to it. The dashboard's popstate handler switches the section.
        ignorePop.current = true;
        window.history.back();
      } else {
        window.history.replaceState({}, "", sectionHref("fans", window.location.pathname));
      }
    }
  }, []);
  useEffect(() => {
    const onPop = () => {
      if (ignorePop.current) { ignorePop.current = false; return; }
      const fan = fanFromSearch(window.location.search);
      const open = openFanRef.current;
      if (fan === open) return;
      drawerEntry.current = false;
      if (open) {
        // Back with the drawer open: close it through the unsaved-changes guard.
        leave(() => setOpenFanId(fan), { scope: [`fan-focus:${open}`, `fan-topup:${open}`, `fan-edit:${open}`, `fan-message:${open}`], consequence: "Closing discards these selections. It does not undo a grant request already sent." });
      } else if (fan) setOpenFanId(fan);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [leave]);
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

  // A failed load is an error state, never "No fans yet" (C2). Resolves false
  // on failure so a caller can say the list did not refresh.
  const load = useCallback(async (): Promise<boolean> => {
    try {
      const d = await loadJson<{ fans?: FanAccountSummary[] }>("/api/fans");
      setAccounts(d.fans ?? []);
      setAccountsError(null);
      return true;
    } catch (e) {
      setAccountsError(e);
      return false;
    }
  }, []);
  const loadCampaigns = useCallback(async () => {
    const res = await fetch("/api/campaigns", { cache: "no-store" });
    if (!res.ok) return;
    const list = ((await res.json()).campaigns ?? []) as {
      id: string;
      name: string;
      isActive?: boolean;
      pinnedWheelId?: string | null;
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
    // Archived games too, so a campaign still set to one is shown as such in
    // the fan drawer instead of looking like "Follow my live game".
    const res = await fetch("/api/wheels?archived=1", { cache: "no-store" });
    if (res.ok) {
      const d = (await res.json()) as { wheels?: WheelSummary[] };
      setWheels(d.wheels ?? []);
      setNow(new Date());
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
  // Re-check whenever a drawer opens: a fan may have written since, and an old
  // conversation can sit beyond the Inbox's first page (A13), so ask per fan.
  useEffect(() => {
    if (!openFanId) return;
    let live = true;
    void fetch(`/api/messages/inbox?fanId=${encodeURIComponent(openFanId)}`, { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((d: { hasThread?: boolean } | null) => {
        if (!live || typeof d?.hasThread !== "boolean") return;
        setThreadIds((prev) => {
          if (prev.has(openFanId) === d.hasThread) return prev;
          const next = new Set(prev);
          if (d.hasThread) next.add(openFanId);
          else next.delete(openFanId);
          return next;
        });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [openFanId]);

  // Every distinct tag across loaded accounts, for the tag filter dropdown.
  const allTags = useMemo(() => {
    const set = new Set<string>();
    for (const a of accounts ?? []) for (const t of a.tags) set.add(t);
    return [...set].sort((x, y) => x.localeCompare(y));
  }, [accounts]);

  async function call(body: Record<string, unknown>, pin?: string | null) {
    const scope = typeof body.fanId === "string" ? `topup:${body.fanId}` : "new-fan";
    let requestId: string;
    try { requestId = await creatorIntent(scope, body, pin); }
    catch (error) {
      const pending = error instanceof Error && error.message === "intent_pending";
      toast(pending ? "An earlier request still needs checking. Put back its original details and try again before adding different spins." : "This browser couldn't keep a safe copy of the request, so no spins were added. Check that this site may store data (private browsing can block it) and try again.", { tone: "error" });
      // Do not lock changed fields: the creator may need to restore the original
      // request after reloading. The durable helper still refuses a new intent.
      return null;
    }
    let committed = false;
    try {
    const res = await fetch("/api/passes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, requestId }),
    });
    let data: { error?: unknown; token?: string; fanId?: string; requestId?: string } = {};
    let parsed = true;
    try { data = await res.json(); } catch { parsed = false; }
    if (!res.ok && isDefinitiveRefusal(res.status)) {
      // RD-05: a refusal is final. Release the receipt and say why, instead of
      // "couldn't confirm" and a locked form.
      const code = typeof data.error === "string" ? data.error : "refused";
      creatorIntentComplete(scope, requestId);
      const message = grantRefusalMessage(code);
      toast(message, { tone: "error" });
      throw new GrantRefusedError(code, message);
    }
    if (!res.ok || !parsed) {
      toast("We couldn't confirm the spins were added. Keep these details and try the same request again.", { tone: "error" });
      throw new Error("grant_unconfirmed");
    }
    if (!data.token || data.requestId !== requestId) throw new Error("grant_unconfirmed");
    committed = true;
    // The receipt's pin is the first submission's: a retry after a reload may
    // come from a form that now lists the new link as an existing one.
    const receiptPin = creatorIntentReceipt(scope)?.pin ?? null;
    creatorIntentComplete(scope, requestId);
    return { ...(data as { token: string; fanId: string }), pinWheelId: receiptPin };
    } catch (error) {
      if (error instanceof GrantRefusedError) throw error;
      toast(committed ? "The spins were added, but this browser couldn't finish tidying up. Try the same details again to check it safely." : "We couldn't confirm the spins were added. Keep these details and try the same request again to check.", { tone: "error" });
      throw new Error("grant_unconfirmed");
    }
  }

  async function createAccount() {
    if (creatingRef.current) return;
    // WC-01 / RD-05: refuse an empty handle and a non-integer spin count here,
    // before any request or receipt exists.
    const fanName = name.trim();
    if (!fanName && !newFanUncertain) {
      toast(grantRefusalMessage("name_required"), { tone: "error" });
      nameRef.current?.focus();
      return;
    }
    const spinCount = parseSpinCount(spins);
    if (spinCount === null) {
      toast("Spins must be a whole number from 1 to 1,000,000.", { tone: "error" });
      return;
    }
    creatingRef.current = true;
    setCreating(true);
    try {
      const amountDollars = amount ? Number(amount) : undefined;
      const data = await call({
        name: fanName,
        spins: spinCount,
        campaignId: campaignId || undefined,
        amountDollars: amountDollars || undefined,
        ...(packId ? { packId, packUnits } : {}),
      });
      setNewFanUncertain(false);
      if (data) {
        setName("");
        setPerSpin("");
        setPackId(null);
        setMinted({ fanId: data.fanId, name: fanName, url: `${origin}/spin/${data.token}` });
        toast(`Link ready for ${fanName}. Copy it or share it from the link card.`, { tone: "success", key: "mint" });
        // WC-02: on a phone the list grows under the form; bring the card with
        // Copy / Share / QR into view and put focus on it.
        requestAnimationFrame(() => {
          mintedRef.current?.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "center" });
          mintedRef.current?.focus({ preventScroll: true });
        });
        if (!(await load())) toast("The link was created. Refresh the fan list to see it.", { tone: "error" });
      }
    } catch (error) {
      // A refusal (4xx) releases the form; only an unknown outcome locks it.
      setNewFanUncertain(!(error instanceof GrantRefusedError));
    } finally {
      creatingRef.current = false;
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
    wheelId?: string,
    units = 1,
    pinWheelId?: string | null,
  ) {
    const data = await call({
      fanId,
      spins: addSpins,
      amountDollars: amountDollars || undefined,
      campaignId: topUpCampaignId || undefined,
      wheelId: wheelId || undefined,
      ...(packId ? { packId, packUnits: units } : {}),
    }, pinWheelId);
    if (!data) throw new Error("grant_rejected");
    if (!(await load())) toast("Top-up confirmed. Refresh the fan list to see it.", { tone: "error" });
    return { token: data.token, pinWheelId: data.pinWheelId };
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
  const existingFanNames = useMemo(() => (accounts ?? []).map((a) => a.name), [accounts]);
  const mintPlays = useMemo(() => linkGame({ wheelId: "", campaignId: campaignId || null }, campaigns, wheels, now), [campaignId, campaigns, wheels, now]);

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
        {newFanUncertain && <p role="alert" className="mt-3 text-xs text-amber-200">This request is not yet confirmed. Keep these details and use Check this link again before leaving or creating another link.</p>}
        <fieldset disabled={creating || newFanUncertain} className="mt-4 grid grid-cols-1 items-end gap-3 sm:grid-cols-2 lg:grid-cols-[2fr_1fr_1fr_1.5fr_auto]">
          <legend className="sr-only">New fan link details</legend>
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
              step={1}
              inputMode="numeric"
              className="ff-input tnum w-full"
              value={spins}
              onChange={(e) => {
                setSpins(e.target.value);
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
                  {c.isActive === false ? `${c.name} (archived)` : c.name}
                </option>
              ))}
            </select>
          </Field>
        </fieldset>
          <button
            type="button"
            onClick={createAccount}
            disabled={creating}
            className="btn-brand mt-3 min-h-10 rounded-[10px] px-[18px] text-sm font-bold"
          >
            {creating ? "Checking…" : newFanUncertain ? "Check this link again" : "Create"}
          </button>
        {minted && (
          <MintedLinkCard
            ref={mintedRef}
            name={minted.name}
            url={minted.url}
            onDismiss={() => setMinted(null)}
          />
        )}
        {mintPlays && (
          <p data-testid="mint-plays" className="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[12.5px] text-muted text-pretty">
            <span className="font-semibold text-ink">This link will play:</span>
            <GameName game={mintPlays.game} />
            <span>
              {mintPlaysReason(mintPlays)}
            </span>
            {onOpenCampaigns && (
              <button type="button" onClick={onOpenCampaigns} className="font-semibold text-ink underline underline-offset-2">
                Change game via a campaign
              </button>
            )}
          </p>
        )}
        {amount && Number(amount) > 0 && spinCount > 0 && (
          <p className="tnum mt-2 text-[11.5px] text-muted">
            {formatCents(Math.round((Number(amount) * 100) / spinCount))}/spin ·{" "}
            {formatCents(Math.round(Number(amount) * 100))} total
          </p>
        )}
        {campaignId && (
          <fieldset disabled={creating || newFanUncertain} className="mt-3">
            <legend className="sr-only">New fan link presets</legend>
            <PackPresets
              campaignId={campaignId}
              onPick={(p: CampaignPack, units: number) => {
                setSpins(String(p.spins));
                setPerSpin(p.spins > 0 ? (p.amountCents / 100 / p.spins).toFixed(2) : "");
                setPackId(p.id);
                setPackUnits(units);
              }}
            />
          </fieldset>
        )}
        <CreatorRequestRecovery scope="new-fan" kind="pass" refreshKey={creating} disabled={creating} onFound={() => setNewFanUncertain(true)} onBusyChange={setCreating} onResolved={async (outcome) => {
          setNewFanUncertain(false);
          if (outcome === "committed" || outcome === "gone") { setName(""); setPerSpin(""); setPackId(null); }
          await load();
        }} />
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
          campaigns={campaigns}
          existingNames={existingFanNames}
          onImported={load}
          onClose={() => setImporting(false)}
        />
      )}

      {accountsError != null && (
        <LoadFailed error={accountsError} what="your fans" onRetry={load} stale={accounts !== null} testId="fans-load-failed" />
      )}
      {accounts === null && accountsError == null && (
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
              fresh={minted?.fanId === acc.fanId}
              onOpen={() => openFanId && openFanId !== acc.fanId ? leave(() => openFan(acc.fanId), { scope: [`fan-focus:${openFanId}`, `fan-topup:${openFanId}`, `fan-edit:${openFanId}`, `fan-message:${openFanId}`] }) : openFan(acc.fanId)}
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
        now={now}
        onOpenGame={onOpenGame ? (wheelId) => leave(() => { closeFan(true); onOpenGame(wheelId); }) : undefined}
        onOpenCampaigns={onOpenCampaigns ? () => leave(() => { closeFan(true); onOpenCampaigns(); }) : undefined}
        onCampaignsChanged={async () => { await Promise.all([loadCampaigns(), loadWheels()]); }}
        templates={templates}
        onClose={() => closeFan()}
        onSaved={load}
        onTopUp={topUp}
        onDeleted={load}
        hasThread={!!openFanId && threadIds.has(openFanId)}
        onMessage={
          onMessage
            ? (fanId) => {
                // Guard before unmounting the drawer; the Inbox navigation
                // must not erase the very registrations it needs to inspect.
                leave(() => { closeFan(true); onMessage(fanId); });
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

/** C12/C13: the link just minted, with Copy, Share and QR. A /spin link holds
 *  one fan's paid balance, so it is said plainly that it is for that fan only. */
const MintedLinkCard = function MintedLinkCard({ name, url, onDismiss, ref }: {
  name: string;
  url: string;
  onDismiss: () => void;
  ref?: React.Ref<HTMLDivElement>;
}) {
  const toast = useToast();
  const copy = async () => {
    if (await copyToClipboard(url)) toast("Link copied", { tone: "success" });
    else toast("Couldn't copy the link. Select it and copy it by hand.", { tone: "error" });
  };
  const share = async () => {
    const outcome = await shareOrCopy({ title: `Spin link for ${name}`, text: `Your personal link, ${name}:`, url });
    if (outcome === "copied") toast("Sharing isn't available here, so the link was copied instead.", { tone: "success" });
    else if (outcome === "failed") toast("Couldn't share or copy the link. Select it and copy it by hand.", { tone: "error" });
  };
  return (
    <div ref={ref} data-testid="minted-link" role="status" tabIndex={-1} className="mt-3 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] border border-[color-mix(in_oklab,var(--brand)_45%,var(--hair))] p-3.5 [background:color-mix(in_oklab,var(--brand)_7%,transparent)]">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[13.5px] font-bold text-ink">Link ready for {name}</p>
          <p className="mt-0.5 text-[12.5px] text-muted text-pretty">
            This is a personal link for this fan only: it carries their spins. Send it to them directly; don&rsquo;t post it publicly.
          </p>
        </div>
        <CloseButton onClick={onDismiss} />
      </div>
      <input
        readOnly
        aria-label={`Spin link for ${name}`}
        value={url}
        onFocus={(e) => e.currentTarget.select()}
        className="ff-input tnum mt-2.5 w-full text-[12.5px]"
      />
      <div className="mt-2.5 flex flex-wrap gap-2">
        <button type="button" onClick={copy} className={ghostBtn}>Copy</button>
        <button type="button" onClick={share} className={ghostBtn}>Share</button>
        <QrButton url={url} label={`${name} spin link`} className={ghostBtn} />
      </div>
    </div>
  );
};

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
  fresh = false,
}: {
  account: FanAccountSummary;
  onOpen: () => void;
  onCopy: () => void;
  /** Just minted: scrolled into view and outlined once. */
  fresh?: boolean;
}) {
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    // Bring the new row into view, and check again shortly after: the minted
    // card above the list grows after the mint (game line, QR button) and the
    // list re-sorts as it reloads, either of which can undo a one-shot scroll.
    // Centre rather than "nearest" so a little growth above cannot hide it.
    if (!fresh) return;
    const el = ref.current;
    if (!el) return;
    const ensure = () => {
      const r = el.getBoundingClientRect();
      if (r.top < 0 || r.bottom > window.innerHeight) {
        el.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "center" });
      }
    };
    ensure();
    const again = [setTimeout(ensure, 700), setTimeout(ensure, 1600)];
    return () => again.forEach(clearTimeout);
  }, [fresh]);
  return (
    <li
      ref={ref}
      id={`fan-row-${account.fanId}`}
      data-fresh={fresh ? "true" : undefined}
      className={`relative ${fresh ? "ring-2 ring-[var(--brand)] " : ""} flex flex-wrap items-center gap-3 rounded-[13px] px-3.5 py-[13px] transition-[transform,border-color] duration-150 ease-out hover:-translate-y-0.5 hover:border-[color-mix(in_oklab,var(--brand)_45%,var(--hair))] sm:gap-3.5 sm:px-4 ${raised}`}
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
        <span className="text-ink">{account.spinsRemaining}</span> spin{account.spinsRemaining === 1 ? "" : "s"}
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
  // C14: a half-written template is unsaved work; closing asks first.
  useCreatorDraft("dm-templates", "a message template you were writing", !!title.trim() || !!body.trim(), saving);
  const leave = useCreatorLeave();
  const close = () => leave(onClose, { scope: "dm-templates", consequence: "Closing discards the template you were writing." });
  // Focus-trap the dialog: focus in on open, cycle Tab, Escape to close, restore
  // focus on close.
  const dialogRef = useFocusTrap<HTMLDivElement>({ active: true, onEscape: close });

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
      <div className="fade-in absolute inset-0 bg-black/60" onClick={close} aria-hidden="true" />
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
          <CloseButton onClick={close} />
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
