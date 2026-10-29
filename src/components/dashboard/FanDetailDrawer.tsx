"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { RARITY_COLORS, RARITY_LABEL } from "@/lib/games/wheel/types";
import type { CampaignPack, DmTemplate, FanAccountSummary, FanDetail } from "@/lib/data/types";
import { formatCents, timeAgo } from "@/lib/format";
import { copyToClipboard, useClipboard } from "@/lib/hooks/useClipboard";
import { useOrigin } from "@/lib/hooks/useOrigin";
import { useFocusTrap } from "@/lib/hooks/useFocusTrap";
import { useSheetDrag } from "@/lib/hooks/useSheetDrag";
import { CloseButton, Field, TagEditor, initialsOf } from "./ui";
import PackPresets from "@/components/dashboard/PackPresets";
import { useToast } from "@/components/ui/Toast";
import { GLOW_WINDOW_DAYS } from "@/lib/glow/config";
import { copyLinkToken, noLinkMessage } from "./fansHelpers";
import { useFetch } from "@/lib/hooks/useFetch";
import { fillTemplate } from "@/lib/winback/template";
import FocusPackPanel from "./FocusPackPanel";
import { useCreatorDraft, useCreatorLeave } from "./CreatorDrafts";
import CreatorRequestRecovery from "./CreatorRequestRecovery";
import GrantRow from "./GrantEditRow";
import { CampaignGameSelect, FOLLOW_LIVE, GameName } from "./GameChoice";
import { KIND_SHORT, kindOf, linkGame, liveExplanation, type ChoiceGame } from "./gameAssignment";

// Code-split the qrcode-pulling QrButton so the dashboard bundle doesn't carry it.
const QrButton = dynamic(() => import("@/components/dashboard/QrButton"), { ssr: false });

type Campaign = { id: string; name: string; pinnedWheelId?: string | null };
type Wheel = ChoiceGame;
export type TopUpFn = (
  fanId: string,
  addSpins: number,
  amountDollars?: number,
  campaignId?: string,
  packId?: string | null,
  wheelId?: string,
  packUnits?: number,
) => void | Promise<void>;

const well = "rounded-[10px] border border-[var(--hair)] [background:var(--s2)]";
const actionBtn =
  "inline-flex min-h-10 items-center justify-center gap-1.5 rounded-[10px] border border-line px-[13px] text-[13.5px] font-semibold text-ink transition-colors hover:bg-[color-mix(in_oklab,var(--color-ink)_5%,transparent)]";
const smallBtn =
  "inline-flex min-h-7 shrink-0 items-center rounded-[7px] border border-line px-[11px] text-[11.5px] font-semibold text-ink transition-colors hover:bg-[color-mix(in_oklab,var(--color-ink)_5%,transparent)]";

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="mb-2.5 text-[13px] font-bold text-ink">{children}</h3>;
}

/**
 * Fan detail: a right-hand drawer from `lg`, a bottom sheet below it. Carries
 * every per-fan power tool (top-up, QR, Copy DM, per-wheel links, delete) so
 * the list rows stay lean.
 */
export default function FanDetailDrawer({
  fanId,
  summary,
  campaigns,
  wheels,
  templates,
  onClose,
  onSaved,
  onTopUp,
  onDeleted,
  hasThread = false,
  onMessage,
  now,
  onOpenGame,
  onOpenCampaigns,
  onCampaignsChanged,
}: {
  fanId: string | null;
  /** The list row for this fan (per-wheel passes, campaign names), if loaded. */
  summary: FanAccountSummary | null;
  campaigns: Campaign[];
  wheels: Wheel[];
  templates: DmTemplate[];
  onClose: () => void;
  onSaved?: () => void;
  onTopUp: TopUpFn;
  onDeleted: () => void;
  /** Whether this fan already has an inbox thread to open. */
  hasThread?: boolean;
  /** "Message": jump to this fan's thread in the Inbox section. */
  onMessage?: (fanId: string) => void;
  /** When the games list was read (what "plays now" is computed against). */
  now?: Date;
  onOpenGame?: (wheelId: string) => void;
  onOpenCampaigns?: () => void;
  /** A campaign's game was changed from here: reload campaigns + games. */
  onCampaignsChanged?: () => void | Promise<void>;
}) {
  const [detail, setDetail] = useState<FanDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [notes, setNotes] = useState("");
  const [savingNotes, setSavingNotes] = useState(false);
  const [savingTags, setSavingTags] = useState(false);
  const [blocking, setBlocking] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [topUpOpen, setTopUpOpen] = useState(false);
  const [focusPreset, setFocusPreset] = useState<{ id: string | null; nonce: number }>({ id: null, nonce: 0 });
  const leave = useCreatorLeave();
  const closeDrawer = useCallback(() => leave(onClose, { scope: [`fan-focus:${fanId}`, `fan-topup:${fanId}`, `fan-edit:${fanId}`], consequence: "Closing discards these selections. It does not undo a grant request already sent." }), [leave, onClose, fanId]);
  // Fans with a top-up request in flight. Held here, not in TopUpForm, because
  // the form unmounts when it is collapsed, the fan changes or the drawer closes;
  // its local state would reset and let a second grant through mid-request.
  const [toppingUpFans, setToppingUpFans] = useState<ReadonlySet<string>>(() => new Set());
  const toppingUpRef = useRef<Set<string>>(new Set());
  const markToppingUp = useCallback((id: string, busy: boolean) => {
    if (busy) toppingUpRef.current.add(id);
    else toppingUpRef.current.delete(id);
    setToppingUpFans(new Set(toppingUpRef.current));
  }, []);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  useCreatorDraft(`fan-edit:${fanId}`, "fan notes or grant edits", !!fanId && !!detail && (notes.trim() ? notes : null) !== (detail.notes ?? null), savingNotes || savingTags || blocking || deleting);
  const closeRef = useRef<HTMLButtonElement>(null);
  const topUpId = useId();
  const breakNoteId = useId();
  const toast = useToast();
  const origin = useOrigin();
  // Focus-trap the drawer while a fan is open: focus the close button, cycle Tab
  // within the panel, Escape to close, and restore focus on close.
  const panelRef = useFocusTrap<HTMLDivElement>({
    active: !!fanId,
    onEscape: closeDrawer,
    initialFocus: closeRef,
  });
  // Below `lg` the panel is a bottom sheet: its grabber drags down to dismiss.
  const sheetDrag = useSheetDrag(panelRef, closeDrawer);
  // The creator's display name, for a DM template's {creator}.
  const { data: account } = useFetch<{ displayName: string | null }>(fanId ? "/api/account" : null, {
    refreshOnVisible: false,
  });

  // Refetch the open fan's detail (after a top-up, an inline grant edit, etc.).
  const reload = useCallback(async () => {
    if (!fanId) return;
    const res = await fetch(`/api/fans/${fanId}`, { cache: "no-store" });
    if (!res.ok) throw new Error("fan_refresh_failed");
    const next = await res.json() as FanDetail;
    setDetail(next);
    return next;
  }, [fanId]);

  // Fetch the fan detail whenever the open fan changes. `blocked` is seeded from
  // the detail and reset here, so Block AND Unblock render the right state.
  useEffect(() => {
    if (!fanId) return;
    let active = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset + refetch when the open fan (`fanId`) changes
    setLoading(true);
    setDetail(null);
    setNotFound(false);
    setNotes("");
    setBlocked(false);
    setTopUpOpen(false);
    setFocusPreset({ id: null, nonce: 0 });
    setConfirmDelete(false);
    (async () => {
      try {
        const res = await fetch(`/api/fans/${fanId}`, { cache: "no-store" });
        if (!active) return;
        if (res.ok) {
          const data: FanDetail = await res.json();
          setDetail(data);
          setNotes(data.notes ?? "");
          setBlocked(!!data.blocked);
        } else setNotFound(true);
      } catch {
        if (active) setNotFound(true);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [fanId]);

  // Persist a metadata patch (notes and/or tags) for the open fan.
  async function patchMeta(
    patch: { notes?: string | null; tags?: string[] }
  ): Promise<boolean> {
    if (!fanId) return false;
    const res = await fetch(`/api/fans/${fanId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    return res.ok;
  }

  // Save notes on blur, but only when they've actually changed.
  async function saveNotes() {
    if (!detail) return;
    const next = notes.trim() ? notes : null;
    if ((detail.notes ?? null) === (next ?? null)) return;
    setSavingNotes(true);
    try {
      if (await patchMeta({ notes: next })) {
        setDetail((d) => (d ? { ...d, notes: next } : d));
        toast("Notes saved", { tone: "success" });
        onSaved?.();
      } else {
        toast("Couldn't save notes.", { tone: "error" });
      }
    } finally {
      setSavingNotes(false);
    }
  }

  async function saveTags(tags: string[]) {
    if (!detail) return;
    setSavingTags(true);
    try {
      if (await patchMeta({ tags })) {
        setDetail((d) => (d ? { ...d, tags } : d));
        onSaved?.();
      } else {
        toast("Couldn't save tags.", { tone: "error" });
      }
    } finally {
      setSavingTags(false);
    }
  }

  async function toggleBlock() {
    if (!fanId) return;
    const next = !blocked;
    setBlocking(true);
    try {
      const res = await fetch(`/api/fans/${fanId}/block`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ blocked: next }),
      });
      if (res.ok) {
        setBlocked(next);
        toast(next ? "Fan blocked — their link is disabled." : "Fan unblocked.", {
          tone: "success",
        });
        onSaved?.();
      } else {
        toast("Couldn't update block status.", { tone: "error" });
      }
    } finally {
      setBlocking(false);
    }
  }

  function handleDelete() {
    leave(() => void deleteConfirmedFan(), { scope: [`fan-focus:${fanId}`, `fan-topup:${fanId}`, `fan-edit:${fanId}`], consequence: "Deleting discards these selections and removes this fan. It does not undo a grant request already sent." });
  }
  async function deleteConfirmedFan() {
    if (!fanId) return;
    setDeleting(true);
    try {
      const res = await fetch("/api/fans/" + fanId, { method: "DELETE" });
      if (res.ok) {
        toast("Fan deleted", { tone: "success" });
        onDeleted();
        onClose();
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

  // The fan's primary spin link (list row first, detail as fallback): labels
  // the "newest" link in the list below.
  const primaryToken =
    summary?.primaryToken ?? summary?.links[0]?.token ?? detail?.links[0]?.token ?? null;
  // What Copy link / Copy DM hand out: the same pick as the Fans row (never a
  // paused or inactive link, none for a blocked fan). The drawer's own block
  // state wins once loaded, so a block made here applies before the list reloads.
  const linkFan = summary ? { ...summary, blocked: detail ? blocked : summary.blocked } : null;
  const shareToken = linkFan ? copyLinkToken(linkFan) : null;
  const primaryUrl = shareToken ? `${origin}/spin/${shareToken}` : null;

  async function copyLink() {
    if (!primaryUrl) {
      toast(linkFan ? noLinkMessage(linkFan) : "No link yet — top up this fan to mint one.", { tone: "error" });
      return;
    }
    if (await copyToClipboard(primaryUrl)) toast("Spin link copied", { tone: "success" });
    else toast("Couldn't copy link.", { tone: "error" });
  }

  // Fill the template's tokens ({name}, {link}, {lastWin}, {days}, {creator})
  // for this fan and copy the message.
  async function copyDm(template: DmTemplate) {
    if (!primaryUrl) {
      toast(linkFan ? noLinkMessage(linkFan) : "No link to insert yet.", { tone: "error" });
      return;
    }
    const lastWinAt = summary?.lastWin?.at ?? detail?.lastActive ?? null;
    const text = fillTemplate(template.body, {
      name: detail?.name ?? summary?.name ?? null,
      link: primaryUrl,
      lastWin: summary?.lastWin?.label ?? null,
      days: lastWinAt ? Math.max(0, Math.floor((Date.now() - Date.parse(lastWinAt)) / 86_400_000)) : null,
      creator: account?.displayName?.trim() || null,
    });
    if (await copyToClipboard(text)) toast("DM copied", { tone: "success" });
    else toast("Couldn't copy DM.", { tone: "error" });
  }

  if (!fanId) return null;

  const name = detail?.name ?? summary?.name ?? "";
  const totalWins = detail?.winsByRarity.reduce((sum, w) => sum + w.count, 0) ?? 0;
  const stats: { label: string; value: string }[] = [
    { label: "Spins left", value: String(detail?.spinsRemaining ?? 0) },
    { label: "Granted", value: String(detail?.grantedTotal ?? 0) },
    { label: "Total spins", value: String(detail?.totalSpins ?? 0) },
    { label: "Total spent", value: formatCents(detail?.totalSpent ?? 0) },
    {
      label: "Last active",
      value: detail?.lastActive ? timeAgo(detail.lastActive) : "—",
    },
    // RM-3: opening the link counts; a spin never does.
    { label: `Days visited (last ${GLOW_WINDOW_DAYS})`, value: `${detail?.visits7 ?? 0} of ${GLOW_WINDOW_DAYS}` },
  ];
  const pending = loading || !detail;
  // RM-6: the fan chose a break. The creator sees only that (never the fan's
  // reminder or counts), and the "keep going" tools are off until it ends
  // (F6 engagement gate). The server already drops a break that has ended.
  const breakUntil = detail?.breakUntil ?? null;
  const breakEnd = breakUntil
    ? new Date(breakUntil).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    : null;

  return (
    <div className="fixed inset-0 z-50">
      <div
        className="fade-in absolute inset-0 bg-black/60"
        onClick={closeDrawer}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Fan details"
        tabIndex={-1}
        className="drawer-in absolute inset-x-0 bottom-0 flex max-h-[88dvh] flex-col overflow-y-auto overscroll-contain rounded-t-[28px] pb-[env(safe-area-inset-bottom)] lg:pb-0 border-t border-[#2a2533] bg-surface shadow-[0_-30px_60px_-20px_rgba(0,0,0,.7)] lg:inset-x-auto lg:right-0 lg:top-0 lg:h-full lg:max-h-none lg:w-full lg:max-w-[444px] lg:rounded-none lg:border-l lg:border-t-0 lg:shadow-[-30px_0_70px_-20px_rgba(0,0,0,.75)]"
      >
        <div className="sticky top-0 z-10 border-b border-[#1f1b27] bg-surface px-5 pb-4 pt-2.5 lg:pt-[18px]">
          {/* Sheet grabber (hidden once the panel is a side drawer): drag down to
              dismiss. Pointer only — Esc and Close stay the keyboard way out. */}
          <div
            {...sheetDrag}
            aria-hidden="true"
            className="-mx-5 -mt-2.5 mb-1 flex cursor-grab touch-none justify-center pb-1.5 pt-2.5 lg:hidden"
          >
            <span className="h-[5px] w-[42px] rounded-full bg-[#3a3442]" />
          </div>
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <span
                aria-hidden="true"
                className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-[color-mix(in_oklab,var(--brand)_18%,transparent)] text-[15px] font-bold text-ink"
              >
                {name ? initialsOf(name) : ""}
              </span>
              <div className="min-w-0">
                {pending && !name ? (
                  <div className="skeleton h-6 w-40 rounded" />
                ) : (
                  <h2 className="truncate text-[17px] font-bold text-ink">{name}</h2>
                )}
                <p className="mt-0.5 text-xs text-muted">
                  Fan details
                  {blocked && (
                    <span className="ml-2 rounded-full bg-[#ef4444]/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.03em] text-[#fca5a5]">
                      Blocked
                    </span>
                  )}
                  {breakEnd && (
                    <span
                      data-testid="fan-on-break"
                      className="ml-2 inline-block rounded-full border border-line px-2 py-0.5 text-[10px] font-semibold text-ink"
                    >
                      On a break until {breakEnd}
                    </span>
                  )}
                </p>
              </div>
            </div>
            <CloseButton ref={closeRef} onClick={closeDrawer} />
          </div>
        </div>

        <div className="px-5 py-5">
          {notFound ? (
            <p className="text-sm text-muted">Fan not found.</p>
          ) : (
            <div className="flex flex-col gap-[22px]">
              {/* Stat grid */}
              <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-[#1f1b27] bg-[#1f1b27]">
                {stats.map((s) => (
                  <div key={s.label} className="bg-base px-[15px] py-[13px]">
                    <dd className="tnum text-[19px] font-bold leading-tight text-ink">
                      {pending ? (
                        <span className="skeleton inline-block h-5 w-10 rounded align-middle" />
                      ) : (
                        s.value
                      )}
                    </dd>
                    <dt className="mt-0.5 text-[10px] font-medium uppercase tracking-[0.04em] text-muted">
                      {s.label}
                    </dt>
                  </div>
                ))}
              </dl>

              {/* Action row: top-up form toggle, copy link, Message, QR, Copy DM. */}
              <div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => topUpOpen ? leave(() => setTopUpOpen(false), { scope: `fan-topup:${fanId}`, consequence: "Closing discards this top-up selection. It does not undo a grant request already sent." }) : setTopUpOpen(true)}
                    aria-expanded={topUpOpen}
                    aria-controls={topUpId}
                    disabled={!!breakEnd || blocked}
                    aria-describedby={breakEnd ? breakNoteId : undefined}
                    className="btn-brand inline-flex min-h-10 basis-full items-center justify-center whitespace-nowrap rounded-[10px] px-[14px] text-[13.5px] font-bold disabled:cursor-not-allowed disabled:opacity-50 sm:flex-1 sm:basis-0"
                  >
                    Top up spins
                  </button>
                  <button type="button" onClick={copyLink} className={actionBtn}>
                    Copy link
                  </button>
                  {onMessage && (
                    // Threads start on the fan's side (chat is spin-gated), so
                    // without one there is nothing to open: say so instead of
                    // landing on an empty inbox.
                    <button
                      type="button"
                      onClick={() => {
                        if (hasThread) onMessage(fanId);
                        else
                          toast("No conversation yet — fans can message you after their first spin.", {
                            tone: "info",
                          });
                      }}
                      aria-disabled={hasThread ? undefined : true}
                      title={hasThread ? "Open this fan's thread in the Inbox" : "No conversation yet"}
                      className={`${actionBtn} aria-disabled:opacity-60`}
                    >
                      Message
                    </button>
                  )}
                  {primaryUrl && <QrButton url={primaryUrl} label={`${name} spin link`} className={actionBtn} />}
                  <CopyDmMenu
                    templates={templates}
                    onPick={copyDm}
                    disabled={!!breakEnd}
                    describedBy={breakEnd ? breakNoteId : undefined}
                  />
                </div>
                {breakEnd && (
                  <p id={breakNoteId} className="mt-2 text-[12px] text-muted">
                    Paused by the fan: they&rsquo;re taking a break until {breakEnd}. Top-up and Copy DM are off until then.
                  </p>
                )}
                {topUpOpen && (
                  <TopUpForm
                    key={fanId}
                    id={topUpId}
                    fanId={fanId}
                    summary={summary}
                    campaigns={campaigns}
                    wheels={wheels}
                    onTopUp={onTopUp}
                    engagementBlocked={!!breakEnd || blocked}
                    toppingUp={toppingUpFans.has(fanId)}
                    isToppingUp={(id) => toppingUpRef.current.has(id)}
                    onToppingUp={markToppingUp}
                    onModifierPick={(pack) => leave(() => {
                      setTopUpOpen(false);
                      setFocusPreset((current) => ({ id: pack.id, nonce: current.nonce + 1 }));
                    }, { scope: [`fan-focus:${fanId}`, `fan-topup:${fanId}`], consequence: "Changing pack flows discards these selections. No request already sent is undone." })}
                    onDone={async () => {
                      setTopUpOpen(false);
                      await reload();
                    }}
                  />
                )}
              </div>

              {!pending && <FocusPackPanel key={`${fanId}:${focusPreset.nonce}`} fanId={fanId} initialPackId={focusPreset.id} refreshKey={`${blocked}:${detail?.spinsRemaining}:${detail?.breakUntil}`} onChanged={async () => { await reload(); onSaved?.(); }} />}

              {/* Tags */}
              <section>
                <SectionTitle>Tags</SectionTitle>
                {pending ? (
                  <div className="skeleton h-8 w-full rounded" />
                ) : (
                  <TagEditor tags={detail.tags} onChange={saveTags} disabled={savingTags} />
                )}
              </section>

              {/* Notes */}
              <section>
                <SectionTitle>Notes</SectionTitle>
                {pending ? (
                  <div className="skeleton h-20 w-full rounded" />
                ) : (
                  <>
                    <textarea
                      className="ff-input w-full text-[13.5px]"
                      rows={3}
                      placeholder="Private notes about this fan…"
                      value={notes}
                      disabled={savingNotes}
                      onChange={(e) => setNotes(e.target.value)}
                      onBlur={saveNotes}
                      aria-label="Fan notes"
                    />
                    <p className="mt-1.5 text-[11px] text-[#8b8494]">
                      {savingNotes ? "Saving…" : "Saved when you click away."}
                    </p>
                  </>
                )}
              </section>

              {/* Wins by rarity */}
              <section>
                <SectionTitle>Wins by rarity</SectionTitle>
                {pending ? (
                  <div className="skeleton h-3 w-full rounded" />
                ) : totalWins === 0 ? (
                  <p className="text-[13px] text-[#8b8494]">No wins yet.</p>
                ) : (
                  <>
                    <div className="flex h-3 overflow-hidden rounded-full">
                      {detail.winsByRarity
                        .filter((w) => w.count > 0)
                        .map((w) => (
                          <div
                            key={w.rarity}
                            style={{
                              width: `${(w.count / totalWins) * 100}%`,
                              backgroundColor: RARITY_COLORS[w.rarity],
                            }}
                            title={`${RARITY_LABEL[w.rarity]}: ${w.count}`}
                          />
                        ))}
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-2">
                      {detail.winsByRarity
                        .filter((w) => w.count > 0)
                        .map((w) => (
                          <div key={w.rarity} className="flex items-center gap-2 text-[13px]">
                            <span
                              className="h-[9px] w-[9px] shrink-0 rounded-full"
                              style={{ backgroundColor: RARITY_COLORS[w.rarity] }}
                            />
                            <span className="text-muted">{RARITY_LABEL[w.rarity]}</span>
                            <span className="tnum ml-auto font-semibold text-ink">{w.count}</span>
                          </div>
                        ))}
                    </div>
                  </>
                )}
              </section>

              {/* By campaign */}
              <section>
                <SectionTitle>By campaign</SectionTitle>
                {pending ? (
                  <div className="skeleton h-10 w-full rounded" />
                ) : detail.byCampaign.length === 0 ? (
                  <p className="text-[13px] text-[#8b8494]">No campaign activity yet.</p>
                ) : (
                  <ul className="flex flex-col gap-2">
                    {detail.byCampaign.map((c) => (
                      <li key={c.campaignId} className={`px-[13px] py-[11px] ${well}`}>
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="min-w-0 truncate text-[13.5px] font-semibold text-ink">
                            {c.name}
                          </span>
                          <span className="tnum shrink-0 text-[13px] font-semibold text-ink">
                            {formatCents(c.spentCents)}
                          </span>
                        </div>
                        <p className="tnum mt-[3px] text-xs text-muted">
                          {c.spinsBought} bought · {c.spinsPlayed} played
                        </p>
                        {c.prizes.length > 0 && (
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {c.prizes.map((p, i) => (
                              <span
                                key={`${p.label}-${i}`}
                                className="inline-flex items-center gap-1.5 rounded-full border border-line px-[9px] py-0.5 text-[11.5px] text-ink"
                              >
                                <span
                                  className="h-[7px] w-[7px] shrink-0 rounded-full"
                                  style={{ backgroundColor: RARITY_COLORS[p.rarity] }}
                                />
                                <span className="truncate">{p.label}</span>
                                <span className="tnum text-muted">×{p.count}</span>
                              </span>
                            ))}
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {/* Grant history */}
              <section>
                <SectionTitle>Grant history</SectionTitle>
                {pending ? (
                  <div className="skeleton h-10 w-full rounded" />
                ) : detail.grants.length === 0 ? (
                  <p className="text-[13px] text-[#8b8494]">No grants yet.</p>
                ) : (
                  <ul className="flex flex-col gap-1.5">
                    {detail.grants.map((g) => (
                      <GrantRow
                        key={g.id}
                        g={g}
                        draftScope={`fan-edit:${fanId}`}
                        fanSpinsRemaining={detail.spinsRemaining}
                        campaigns={campaigns}
                        onSaved={async () => { const next = await reload(); return next?.grants.find((current) => current.id === g.id) ?? null; }}
                      />
                    ))}
                  </ul>
                )}
              </section>

              {/* Pending prizes */}
              <section>
                <SectionTitle>Pending prizes</SectionTitle>
                {pending ? (
                  <div className="skeleton h-10 w-full rounded" />
                ) : detail.pendingPrizes.length === 0 ? (
                  <p className="text-[13px] text-[#8b8494]">None pending.</p>
                ) : (
                  <ul className="flex flex-col gap-1.5">
                    {detail.pendingPrizes.map((p, i) => (
                      <li
                        key={`${p.label}-${p.at}-${i}`}
                        className={`flex items-center gap-2.5 px-[13px] py-[9px] ${well}`}
                      >
                        <span
                          className="h-[9px] w-[9px] shrink-0 rounded-full"
                          style={{ backgroundColor: RARITY_COLORS[p.rarity] }}
                        />
                        <span className="min-w-0 flex-1 truncate text-[13.5px] text-ink">
                          {p.emoji ? `${p.emoji} ` : ""}
                          {p.label}
                        </span>
                        <span className="tnum shrink-0 text-xs text-muted">{timeAgo(p.at)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {/* Links: one per wheel the fan plays (own link + own balance), or
                  the plain token list when the row summary isn't loaded. */}
              <section>
                <SectionTitle>Links</SectionTitle>
                {pending ? (
                  <div className="skeleton h-10 w-full rounded" />
                ) : summary && summary.passes.length > 0 ? (
                  <ul className="flex flex-col gap-2">
                    {summary.passes.map((p) => (
                      <li key={p.token} className={`px-[13px] py-[11px] ${well}`}>
                        <div className="flex items-center justify-between gap-2">
                          <span className="min-w-0 truncate text-[13.5px] font-semibold text-ink">
                            {p.campaignName ? `Link in “${p.campaignName}”` : "Link (no campaign)"}
                          </span>
                          <span className="tnum shrink-0 text-xs font-bold text-brand">
                            {p.spinsRemaining} spins
                          </span>
                        </div>
                        <LinkPlays
                          pass={p}
                          campaigns={campaigns}
                          wheels={wheels}
                          now={now ?? new Date()}
                          onOpenGame={onOpenGame}
                          onOpenCampaigns={onOpenCampaigns}
                          onCampaignsChanged={onCampaignsChanged}
                        />
                        <LinkRow url={`${origin}/spin/${p.token}`} newest={false} bare />
                      </li>
                    ))}
                  </ul>
                ) : detail.links.length === 0 ? (
                  <p className="text-[13px] text-[#8b8494]">No links yet.</p>
                ) : (
                  <ul className="flex flex-col gap-1.5">
                    {detail.links.map((l, i) => (
                      <li key={l.token}>
                        <LinkRow
                          url={`${origin}/spin/${l.token}`}
                          newest={primaryToken ? l.token === primaryToken : i === 0}
                        />
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {/* Safety: block (disables every link) and delete (2-step). */}
              <section className="border-t border-[#1f1b27] pt-4">
                <SectionTitle>Safety</SectionTitle>
                <p className="-mt-1 text-xs text-muted">
                  Blocking disables every link this fan has — they can&rsquo;t spin or
                  message until you unblock them.
                </p>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={toggleBlock}
                    disabled={blocking || pending}
                    className={`inline-flex min-h-[34px] items-center rounded-[9px] border px-[13px] text-[12.5px] font-semibold transition-colors disabled:opacity-50 ${
                      blocked
                        ? "border-line text-muted hover:text-ink"
                        : "border-[color-mix(in_oklab,#ef4444_55%,transparent)] text-[#f87171] hover:bg-[#ef4444]/10"
                    }`}
                  >
                    {blocking ? "…" : blocked ? "Unblock fan" : "Block fan"}
                  </button>
                  {confirmDelete ? (
                    <>
                      <button
                        type="button"
                        onClick={handleDelete}
                        disabled={deleting}
                        aria-label={"Confirm delete " + name}
                        className="inline-flex min-h-[34px] items-center rounded-[9px] border border-[#ef4444]/60 px-[13px] text-[12.5px] font-bold text-[#f87171] transition-colors hover:bg-[#ef4444]/10 disabled:opacity-50"
                      >
                        {deleting ? "Deleting…" : "Delete permanently?"}
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmDelete(false)}
                        disabled={deleting}
                        aria-label="Cancel delete"
                        className="inline-flex min-h-[34px] items-center rounded-[9px] border border-line px-[13px] text-[12.5px] font-semibold text-muted transition-colors hover:text-ink disabled:opacity-50"
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmDelete(true)}
                      disabled={pending}
                      aria-label={"Delete " + name}
                      className="inline-flex min-h-[34px] items-center rounded-[9px] border border-line px-[13px] text-[12.5px] font-semibold text-muted transition-colors hover:border-[#ef4444]/60 hover:text-[#f87171] disabled:opacity-50"
                    >
                      Delete fan
                    </button>
                  )}
                </div>
              </section>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Top-up form: spins, $/spin, wheel, campaign (defaults to the fan's own),
 *  presets (×N stacking) and the in-flight guard. Keyed by fan so state resets. */
function TopUpForm({
  id,
  fanId,
  summary,
  campaigns,
  wheels,
  onTopUp,
  toppingUp,
  isToppingUp,
  onToppingUp,
  onDone,
  onModifierPick,
  engagementBlocked,
}: {
  id: string;
  fanId: string;
  summary: FanAccountSummary | null;
  campaigns: Campaign[];
  wheels: Wheel[];
  onTopUp: TopUpFn;
  toppingUp: boolean;
  isToppingUp: (fanId: string) => boolean;
  onToppingUp: (fanId: string, busy: boolean) => void;
  onDone: () => void | Promise<void>;
  onModifierPick: (pack: CampaignPack) => void;
  engagementBlocked: boolean;
}) {
  // Which wheel the top-up targets (per-wheel spins). Default to the fan's
  // first existing wheel-pass, else the first wheel.
  const [wheelId, setWheelId] = useState<string>(
    summary?.passes[0]?.wheelId ?? wheels[0]?.id ?? ""
  );
  // Balances are kept per game a link was made for; a game with no link for
  // this fan yet gets a new one.
  const topUpTargets = wheels
    .filter((w) => !w.archivedAt && w.gameKind !== "bingo")
    .map((w) => {
      const own = summary?.passes.find((p) => p.wheelId === w.id);
      return { id: w.id, label: own ? `${w.title} balance (${own.spinsRemaining} spins)` : `${w.title} balance (new link)` };
    });
  const [spins, setSpins] = useState(3);
  // Per-spin price as its own state so typing two digits works.
  const [perSpin, setPerSpin] = useState<string>("");
  const amount = perSpin && spins > 0 ? (Number(perSpin) * spins).toFixed(2) : "";
  // Default the top-up to a campaign this fan already belongs to, so revenue
  // doesn't silently fall into "untracked" (a top-up = more spins on a wheel).
  const [campaignId, setCampaignId] = useState<string>(() => {
    const names = summary?.campaignNames ?? [];
    return campaigns.find((c) => names.includes(c.name))?.id ?? "";
  });
  // The pack a preset filled in, if any. Sent to the server which resolves it
  // authoritatively; cleared on any manual override so we don't mis-attribute.
  const [packId, setPackId] = useState<string | null>(null);
  const [packUnits, setPackUnits] = useState(1);
  const [error, setError] = useState("");
  const [uncertain, setUncertain] = useState(false);
  useCreatorDraft(`fan-topup:${fanId}`, "this top-up selection", spins !== 3 || perSpin !== "" || !!packId, toppingUp || uncertain);

  async function submit() {
    // In-flight guard: a double-click, or collapsing and reopening the form
    // mid-request, must not double-grant spins/spend.
    if (isToppingUp(fanId) || engagementBlocked) return;
    onToppingUp(fanId, true);
    setError("");
    let confirmed = false;
    try {
      await onTopUp(
        fanId,
        spins,
        amount ? Number(amount) || undefined : undefined,
        campaignId || undefined,
        packId,
        wheelId || undefined,
        packId ? packUnits : undefined,
      );
      confirmed = true;
      setUncertain(false);
      setPerSpin("");
      setPackId(null);
      await onDone();
    } catch (error) {
      const unknown = error instanceof Error && error.message === "grant_unconfirmed";
      setUncertain(unknown);
      setError(confirmed ? "The top-up was confirmed, but the fan's refreshed status couldn't load. Refresh before making another grant." : unknown ? "The top-up couldn't be confirmed. Keep this selection and retry to check the same request." : "No top-up was confirmed. Review the selection and try again.");
    } finally {
      onToppingUp(fanId, false);
    }
  }

  return (
    <div id={id} className={`lift-in mt-2.5 p-3.5 ${well}`}>
      {error && <p role="alert" className="mb-2 text-xs text-amber-200">{error}</p>}
      <fieldset disabled={toppingUp || uncertain || engagementBlocked}>
      <legend className="sr-only">Top up this fan</legend>
      <div className="grid grid-cols-2 gap-2.5">
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
        <Field label="$ per spin">
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
        <Field label="Add spins to">
          <select
            className="ff-input w-full"
            value={wheelId}
            onChange={(e) => setWheelId(e.target.value)}
            aria-describedby={`${id}-target-help`}
          >
            {wheels.length === 0 && <option value="">This fan&apos;s link</option>}
            {topUpTargets.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Campaign">
          <select
            className="ff-input w-full"
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
      </div>
      <p id={`${id}-target-help`} className="mt-2 text-[11.5px] text-muted text-pretty">
        Picks which of this fan&apos;s spin balances gets the spins. It doesn&apos;t choose the game: each link plays its campaign&apos;s game, or your live game.
      </p>
      {campaignId && (
        <div className="mt-2.5">
          <PackPresets
            campaignId={campaignId}
            onModifierPick={onModifierPick}
            onPick={(p: CampaignPack, units: number) => {
              setSpins(p.spins);
              setPerSpin(p.spins > 0 ? (p.amountCents / 100 / p.spins).toFixed(2) : "");
              setPackId(p.id);
              setPackUnits(units);
            }}
          />
        </div>
      )}
      </fieldset>
      <div className="mt-3 flex items-center justify-between gap-3">
        <p className="tnum text-[11.5px] text-muted">
          {amount && Number(amount) > 0 ? `${formatCents(Math.round(Number(amount) * 100))} total` : "Free spins"}
        </p>
        <button
          type="button"
          disabled={toppingUp || engagementBlocked}
          onClick={submit}
          className="btn-brand min-h-9 rounded-[9px] px-4 text-[13px] font-bold disabled:opacity-50"
        >
          {toppingUp ? "Checking…" : uncertain ? "Check this top-up again" : `Grant ${spins} spin${spins === 1 ? "" : "s"}`}
        </button>
      </div>
      <CreatorRequestRecovery scope={`topup:${fanId}`} guardScope={`fan-topup:${fanId}`} kind="pass" refreshKey={toppingUp} disabled={toppingUp} onFound={() => setUncertain(true)} onBusyChange={(busy) => onToppingUp(fanId, busy)} onResolved={async (outcome) => {
        setUncertain(false); setError("");
        if (outcome === "committed" || outcome === "gone") { setPerSpin(""); setPackId(null); await onDone(); }
      }} />
    </div>
  );
}

// A small dropdown of saved DM templates. Picking one fills its tokens and copies.
function CopyDmMenu({
  templates,
  onPick,
  disabled = false,
  describedBy,
}: {
  templates: DmTemplate[];
  onPick: (t: DmTemplate) => void;
  /** RM-6: off while the fan is on a break. */
  disabled?: boolean;
  describedBy?: string;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  // Closing from the keyboard (Esc, or a pick) hands focus back to the trigger;
  // otherwise the focused item unmounts and focus falls out of the drawer.
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) buttonRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // Swallow so the drawer's own Escape handler doesn't close the drawer too.
        e.stopImmediatePropagation();
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    // Land keyboard users on the first template (same as the wheel Manage menu).
    menuRef.current?.querySelector<HTMLElement>("[role='menuitem']")?.focus();
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  // Arrow / Home / End move between templates; Tab leaves and closes the menu.
  function onMenuKey(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Tab") {
      setOpen(false);
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>("[role='menuitem']") ?? []);
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

  return (
    <div ref={wrapRef} className="relative inline-block">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-haspopup="menu"
        disabled={disabled}
        aria-describedby={describedBy}
        className={`${actionBtn} disabled:cursor-not-allowed disabled:opacity-50`}
      >
        Copy DM
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && !disabled && (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label="DM templates"
          onKeyDown={onMenuKey}
          className="lift-in absolute right-0 z-30 mt-2 w-64 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-[var(--hair)] py-1 shadow-[var(--lift)] [background:var(--s1)]"
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
                  close(true);
                }}
                className="block w-full px-3 py-2 text-left transition-colors hover:bg-[color-mix(in_oklab,var(--color-ink)_5%,transparent)]"
              >
                <span className="block truncate text-sm font-semibold text-ink">{t.title}</span>
                <span className="block truncate text-xs text-muted">{t.body}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function LinkRow({ url, newest, bare }: { url: string; newest: boolean; bare?: boolean }) {
  const { copy, copied } = useClipboard();
  return (
    <div
      className={`flex items-center gap-2 ${bare ? "mt-2" : `px-3 py-2 ${well}`}`}
    >
      <p className="min-w-0 flex-1 truncate text-xs text-muted" title={url}>
        {url}
        {newest && (
          <span className="ml-2 rounded bg-[color-mix(in_oklab,var(--brand)_20%,transparent)] px-1.5 py-0.5 text-[10px] font-bold text-brand">
            NEWEST
          </span>
        )}
      </p>
      <button type="button" onClick={() => void copy(url)} className={smallBtn}>
        {copied ? "Copied" : "Copy"}
      </button>
      <a href={url} target="_blank" rel="noreferrer" className={smallBtn}>
        Open
      </a>
    </div>
  );
}

/**
 * What one fan link plays now and why, computed with the server's resolver
 * (never the link's stored game alone), plus the shortcuts to change it.
 * Per-fan game choice doesn't exist yet: a link's game comes from its campaign
 * or from the creator's live game.
 */
function LinkPlays({
  pass,
  campaigns,
  wheels,
  now,
  onOpenGame,
  onOpenCampaigns,
  onCampaignsChanged,
}: {
  pass: { token: string; wheelId: string; campaignId?: string | null; campaignName: string | null };
  campaigns: Campaign[];
  wheels: Wheel[];
  now: Date;
  onOpenGame?: (wheelId: string) => void;
  onOpenCampaigns?: () => void;
  onCampaignsChanged?: () => void | Promise<void>;
}) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const panelId = useId();
  const selectId = useId();
  const helpId = useId();
  const plays = linkGame(pass, campaigns, wheels, now);
  const campaign = plays?.campaign ?? (pass.campaignId ? campaigns.find((c) => c.id === pass.campaignId) ?? null : null);
  const live = liveExplanation(wheels, now);
  const liveTitle = live ? `${live.game.title} · ${KIND_SHORT[kindOf(live.game)]}` : null;

  async function setCampaignGame(value: string) {
    if (!campaign) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/campaigns/${campaign.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pinnedWheelId: value || null }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        toast(data?.error === "game_not_playable" ? "That game can't be chosen: it's archived, a draft, or bingo." : "Couldn't change the campaign's game. Nothing changed; try again.", { tone: "error" });
        return;
      }
      const picked = wheels.find((w) => w.id === value);
      toast(picked ? `“${campaign.name}” now plays ${picked.title}.` : `“${campaign.name}” now follows your live game.`, { tone: "success" });
      await onCampaignsChanged?.();
    } catch {
      toast("The change couldn't be confirmed. Check the campaign before trying again.", { tone: "error" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div data-testid="link-plays" data-plays-game-id={plays?.game.id ?? ""} className="mt-1.5 text-[12.5px] text-muted">
      {plays ? (
        <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-pretty">
          <span className="font-semibold text-ink">This link plays:</span>
          <GameName game={plays.game} />
          <span>
            {plays.via === "campaign" && plays.campaign
              ? `(via campaign “${plays.campaign.name}”)`
              : plays.via === "live"
                ? `(your live game: ${plays.because})`
                : "(the game it was made for)"}
          </span>
        </p>
      ) : (
        <p>No playable game right now. Finish a wheel or scratch game first.</p>
      )}
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {plays && onOpenGame && (
          <button type="button" className={smallBtn} onClick={() => onOpenGame(plays.game.id)} aria-label={`Edit game ${plays.game.title}`}>
            Edit game
          </button>
        )}
        <button type="button" className={smallBtn} aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((v) => !v)}>
          Change game
        </button>
      </div>
      {open && (
        <div id={panelId} className="mt-2 rounded-[8px] border border-[var(--hair)] p-2.5">
          {campaign ? (
            <>
              <label htmlFor={selectId} className="block text-[11.5px] font-semibold text-ink">
                Game for campaign “{campaign.name}”
              </label>
              <CampaignGameSelect
                id={selectId}
                value={campaign.pinnedWheelId ?? FOLLOW_LIVE}
                games={wheels}
                liveTitle={liveTitle}
                disabled={saving}
                describedBy={helpId}
                onChange={(value) => void setCampaignGame(value)}
                className="mt-1 w-full"
              />
              <p id={helpId} className="mt-1.5 text-[11.5px] text-pretty">
                This changes the game for every fan link in “{campaign.name}”, not just this fan.
              </p>
            </>
          ) : (
            <p className="text-[11.5px] text-pretty">
              This link isn&apos;t in a campaign, so it plays your live game. To give fans a specific game, mint them a link in a campaign that plays it, or change your live game on the Games screen.
            </p>
          )}
          {onOpenCampaigns && (
            <button type="button" className={`${smallBtn} mt-2`} onClick={onOpenCampaigns}>
              Open Campaigns
            </button>
          )}
        </div>
      )}
    </div>
  );
}
