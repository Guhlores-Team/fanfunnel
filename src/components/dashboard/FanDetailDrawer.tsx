"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { RARITY_COLORS, RARITY_LABEL } from "@/lib/games/wheel/types";
import type { CampaignPack, DmTemplate, FanAccountSummary, FanDetail, Grant } from "@/lib/data/types";
import { formatCents, timeAgo } from "@/lib/format";
import { copyToClipboard, useClipboard } from "@/lib/hooks/useClipboard";
import { useOrigin } from "@/lib/hooks/useOrigin";
import { useFocusTrap } from "@/lib/hooks/useFocusTrap";
import { useSheetDrag } from "@/lib/hooks/useSheetDrag";
import { CloseButton, Field, TagEditor, initialsOf } from "./ui";
import PackPresets from "@/components/dashboard/PackPresets";
import { grantImpact, grantPriceError, grantSaveAmount, parseSpins, perSpinText, revenueChangeText } from "./grantImpact";
import { useToast } from "@/components/ui/Toast";

// Code-split the qrcode-pulling QrButton so the dashboard bundle doesn't carry it.
const QrButton = dynamic(() => import("@/components/dashboard/QrButton"), { ssr: false });

type Campaign = { id: string; name: string };
type Wheel = { id: string; title: string };
export type TopUpFn = (
  fanId: string,
  addSpins: number,
  amountDollars?: number,
  campaignId?: string,
  packId?: string | null,
  wheelId?: string
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
  const closeRef = useRef<HTMLButtonElement>(null);
  const topUpId = useId();
  const toast = useToast();
  const origin = useOrigin();
  // Focus-trap the drawer while a fan is open: focus the close button, cycle Tab
  // within the panel, Escape to close, and restore focus on close.
  const panelRef = useFocusTrap<HTMLDivElement>({
    active: !!fanId,
    onEscape: onClose,
    initialFocus: closeRef,
  });
  // Below `lg` the panel is a bottom sheet: its grabber drags down to dismiss.
  const sheetDrag = useSheetDrag(panelRef, onClose);

  // Refetch the open fan's detail (after a top-up, an inline grant edit, etc.).
  const reload = useCallback(async () => {
    if (!fanId) return;
    const res = await fetch(`/api/fans/${fanId}`, { cache: "no-store" });
    if (res.ok) setDetail(await res.json());
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

  async function handleDelete() {
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

  // The fan's primary spin link (list row first, detail as fallback).
  const primaryToken =
    summary?.primaryToken ?? summary?.links[0]?.token ?? detail?.links[0]?.token ?? null;
  const primaryUrl = primaryToken ? `${origin}/spin/${primaryToken}` : null;

  async function copyLink() {
    if (!primaryUrl) {
      toast("No link yet — top up this fan to mint one.", { tone: "error" });
      return;
    }
    if (await copyToClipboard(primaryUrl)) toast("Spin link copied", { tone: "success" });
    else toast("Couldn't copy link.", { tone: "error" });
  }

  // Fill {link} with the fan's full spin URL and copy the message.
  async function copyDm(template: DmTemplate) {
    if (!primaryUrl) {
      toast("No link to insert yet.", { tone: "error" });
      return;
    }
    const text = template.body.split("{link}").join(primaryUrl);
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
  ];
  const pending = loading || !detail;

  return (
    <div className="fixed inset-0 z-50">
      <div
        className="fade-in absolute inset-0 bg-black/60"
        onClick={onClose}
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
                className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-[color-mix(in_oklab,var(--brand)_18%,transparent)] text-[15px] font-bold text-brand"
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
                </p>
              </div>
            </div>
            <CloseButton ref={closeRef} onClick={onClose} />
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
                    onClick={() => setTopUpOpen((v) => !v)}
                    aria-expanded={topUpOpen}
                    aria-controls={topUpId}
                    className="btn-brand inline-flex min-h-10 basis-full items-center justify-center whitespace-nowrap rounded-[10px] px-[14px] text-[13.5px] font-bold sm:flex-1 sm:basis-0"
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
                  <CopyDmMenu templates={templates} onPick={copyDm} />
                </div>
                {topUpOpen && (
                  <TopUpForm
                    key={fanId}
                    id={topUpId}
                    fanId={fanId}
                    summary={summary}
                    campaigns={campaigns}
                    wheels={wheels}
                    onTopUp={onTopUp}
                    toppingUp={toppingUpFans.has(fanId)}
                    isToppingUp={(id) => toppingUpRef.current.has(id)}
                    onToppingUp={markToppingUp}
                    onDone={async () => {
                      setTopUpOpen(false);
                      await reload();
                    }}
                  />
                )}
              </div>

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
                        fanSpinsRemaining={detail.spinsRemaining}
                        campaigns={campaigns}
                        onSaved={reload}
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
                            {p.wheelTitle}
                          </span>
                          <span className="tnum shrink-0 text-xs font-bold text-brand">
                            {p.spinsRemaining} spins
                          </span>
                        </div>
                        {p.campaignName && (
                          <span className="mt-1 inline-block rounded-full border border-line px-2 py-0.5 text-[10.5px] text-muted">
                            {p.campaignName}
                          </span>
                        )}
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
}) {
  // Which wheel the top-up targets (per-wheel spins). Default to the fan's
  // first existing wheel-pass, else the first wheel.
  const [wheelId, setWheelId] = useState<string>(
    summary?.passes[0]?.wheelId ?? wheels[0]?.id ?? ""
  );
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

  async function submit() {
    // In-flight guard: a double-click, or collapsing and reopening the form
    // mid-request, must not double-grant spins/spend.
    if (isToppingUp(fanId)) return;
    onToppingUp(fanId, true);
    try {
      await onTopUp(
        fanId,
        spins,
        amount ? Number(amount) || undefined : undefined,
        campaignId || undefined,
        packId,
        wheelId || undefined
      );
      setPerSpin("");
      setPackId(null);
      await onDone();
    } finally {
      onToppingUp(fanId, false);
    }
  }

  return (
    <div id={id} className={`lift-in mt-2.5 p-3.5 ${well}`}>
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
        <Field label="Wheel">
          <select
            className="ff-input w-full"
            value={wheelId}
            onChange={(e) => setWheelId(e.target.value)}
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
      {campaignId && (
        <div className="mt-2.5">
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
      <div className="mt-3 flex items-center justify-between gap-3">
        <p className="tnum text-[11.5px] text-muted">
          {amount && Number(amount) > 0 ? `${formatCents(Math.round(Number(amount) * 100))} total` : "Free spins"}
        </p>
        <button
          type="button"
          disabled={toppingUp}
          onClick={submit}
          className="btn-brand min-h-9 rounded-[9px] px-4 text-[13px] font-bold disabled:opacity-50"
        >
          {toppingUp ? "Topping up…" : `Grant ${spins} spin${spins === 1 ? "" : "s"}`}
        </button>
      </div>
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
      if (e.key === "Escape") {
        // Swallow so the drawer's own Escape handler doesn't close the drawer too.
        e.stopImmediatePropagation();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
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
        className={actionBtn}
      >
        Copy DM
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div
          id={menuId}
          role="menu"
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
                  setOpen(false);
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

/** A grant history row that expands into an inline editor (spins / $ / campaign).
 *  Editing spins adjusts the fan's balance server-side; we refetch on save. */
function GrantRow({
  g,
  fanSpinsRemaining,
  campaigns,
  onSaved,
}: {
  g: Grant;
  fanSpinsRemaining: number;
  campaigns: Campaign[];
  onSaved: () => void | Promise<void>;
}) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [spins, setSpins] = useState(String(g.spins));
  const [perSpin, setPerSpin] = useState(perSpinText(g.spins, g.amountCents));
  const [campaignId, setCampaignId] = useState(g.campaignId ?? "");
  const [busy, setBusy] = useState(false);

  // Re-sync the form when the underlying grant changes (e.g. the drawer reloads
  // after another action), unless the user is actively editing this row.
  useEffect(() => {
    if (editing) return;
    /* eslint-disable react-hooks/set-state-in-effect -- mirror persisted grant into the idle form */
    setSpins(String(g.spins));
    setPerSpin(perSpinText(g.spins, g.amountCents));
    setCampaignId(g.campaignId ?? "");
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [g.spins, g.amountCents, g.campaignId, editing]);

  // Plain-language preview of what saving does to the fan's balance (UX-3).
  const impact = grantImpact({ grantSpins: g.spins, spinsInput: spins, fanSpinsRemaining });
  // Recorded revenue only changes when the price or spin count really does.
  const newAmountCents = grantSaveAmount({ grant: g, spinsInput: spins, perSpinInput: perSpin });
  const revenueLine = revenueChangeText(g.amountCents, newAmountCents);
  // Negative, non-finite or over-cap prices would 400 on save.
  const priceError = grantPriceError({ grant: g, spinsInput: spins, perSpinInput: perSpin });
  const canSave = impact.allowed && !priceError;
  const previewId = `grant-impact-${g.id}`;
  const priceErrorId = `grant-price-error-${g.id}`;

  async function save() {
    if (!canSave) return;
    setBusy(true);
    try {
      const nSpins = parseSpins(spins);
      const res = await fetch(`/api/grants/${g.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          spins: nSpins,
          // Omitted when unchanged so the stored amount is never rewritten.
          ...(newAmountCents !== g.amountCents ? { amountCents: newAmountCents } : {}),
          campaignId: campaignId || null,
        }),
      });
      if (res.ok) {
        toast("Grant updated", { tone: "success" });
        setEditing(false);
        await onSaved();
      } else {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        toast(
          body?.error === "insufficient_spins"
            ? "Can't cut below the spins this fan has already used."
            : "Couldn't update grant.",
          { tone: "error" }
        );
      }
    } finally {
      setBusy(false);
    }
  }

  if (!editing) {
    return (
      <li className={`flex items-center gap-2.5 px-[13px] py-[9px] ${well}`}>
        <span className="tnum shrink-0 text-sm font-bold text-ink">+{g.spins}</span>
        <span className="min-w-0 flex-1 truncate text-[13px] text-muted">
          <span className="tnum font-semibold text-ink">{formatCents(g.amountCents)}</span> ·{" "}
          {g.campaignName ?? "No campaign"}
        </span>
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="inline-flex min-h-7 shrink-0 items-center rounded-[7px] border border-line px-[9px] text-[11.5px] font-semibold text-[#8b8494] transition-colors hover:text-ink"
        >
          Edit
        </button>
      </li>
    );
  }

  return (
    <li className="space-y-2 rounded-[10px] border border-[color-mix(in_oklab,var(--brand)_40%,transparent)] px-3 py-3 [background:var(--s2)]">
      <div className="grid grid-cols-2 gap-2">
        <Field label="Spins">
          <input
            type="number"
            min={0}
            value={spins}
            onChange={(e) => setSpins(e.target.value)}
            aria-invalid={!impact.allowed || undefined}
            className="ff-input tnum w-full"
          />
        </Field>
        <Field label="$ / spin">
          <input
            type="number"
            min={0}
            step={0.01}
            value={perSpin}
            onChange={(e) => setPerSpin(e.target.value)}
            placeholder="0.00"
            aria-invalid={!!priceError || undefined}
            aria-errormessage={priceError ? priceErrorId : undefined}
            className="ff-input tnum w-full"
          />
        </Field>
        <div className="col-span-2">
          <Field label="Campaign">
            <select
              value={campaignId}
              onChange={(e) => setCampaignId(e.target.value)}
              className="ff-input w-full"
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
      </div>
      {priceError && (
        <p id={priceErrorId} role="alert" className="text-xs font-semibold text-[#f87171]">
          {priceError}
        </p>
      )}
      {/* Live region only (no aria-describedby on the inputs) so it is read once. */}
      <p
        id={previewId}
        role="status"
        className={`text-xs text-pretty ${impact.allowed ? "text-muted" : "font-semibold text-[#f87171]"}`}
      >
        {impact.message}
        {impact.allowed && !priceError && revenueLine && <> {revenueLine}</>}
      </p>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={save}
          disabled={busy || !canSave}
          className="btn-brand min-h-8 rounded-[9px] px-3 text-xs font-bold disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          onClick={() => setEditing(false)}
          className="min-h-8 rounded-[9px] border border-line px-3 text-xs font-semibold text-muted transition-colors hover:text-ink"
        >
          Cancel
        </button>
      </div>
    </li>
  );
}
