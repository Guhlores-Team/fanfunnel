"use client";

import { useId, useRef, useState } from "react";
import { formatCents } from "@/lib/format";
import { useToast } from "@/components/ui/Toast";
import { copyToClipboard } from "@/lib/hooks/useClipboard";
import { useFocusTrap } from "@/lib/hooks/useFocusTrap";
import { useSheetDrag } from "@/lib/hooks/useSheetDrag";
import { templateHasLink } from "@/lib/winback/template";
import { WINBACK_CONTACT_COOLDOWN_DAYS, WINBACK_SNOOZE_DAYS } from "@/lib/winback/config";
import { CloseButton, initialsOf } from "./ui";
import { postOutreach, winbackMessage, type WinbackFan, type WinbackTemplate } from "./winbackActions";

const secondaryBtn =
  "inline-flex min-h-11 items-center justify-center rounded-[10px] border border-line px-4 text-[13.5px] font-semibold text-ink transition-colors hover:bg-[color-mix(in_oklab,var(--color-ink)_5%,transparent)] disabled:opacity-50";

/**
 * "Work the queue" (RM-5, D6 b): one quiet fan at a time with their filled
 * message. Copy & next copies it (for the creator to paste into their own
 * DMs), logs the contact and moves on; Skip just moves on; Snooze hides the fan
 * for WINBACK_SNOOZE_DAYS. FanFunnel never sends anything itself.
 *
 * A bottom sheet below `lg`, a right-hand drawer from `lg` (FanDetailDrawer's
 * pattern). The fan list is a snapshot taken when the queue opened.
 */
export default function WinbackQueue({
  fans,
  templates,
  templateId,
  onTemplate,
  origin,
  creator,
  onClose,
}: {
  fans: WinbackFan[];
  templates: WinbackTemplate[];
  templateId: string;
  onTemplate: (id: string) => void;
  origin: string;
  creator: string | null;
  /** `changed`: something was logged, so the card should reload. */
  onClose: (changed: boolean) => void;
}) {
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [tally, setTally] = useState({ copied: 0, snoozed: 0, skipped: 0 });
  const changed = tally.copied + tally.snoozed > 0;
  const toast = useToast();
  const selectId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const close = () => onClose(changed);
  const panelRef = useFocusTrap<HTMLDivElement>({ active: true, onEscape: close, initialFocus: closeRef });
  const sheetDrag = useSheetDrag(panelRef, close);

  const fan = fans[index] ?? null;
  const template = templates.find((t) => t.id === templateId) ?? templates[0];
  const message = fan && template ? winbackMessage(fan, template, origin, creator) : "";
  const savedTemplateId = template && !template.id.startsWith("winback-") ? template.id : null;
  const next = () => setIndex((i) => i + 1);

  async function copyAndNext() {
    if (!fan || busy) return;
    setBusy(true);
    try {
      if (!(await copyToClipboard(message))) {
        toast("Couldn't copy. Nothing was marked.", { tone: "error" });
        return;
      }
      const logged = await postOutreach(fan.fanId, "contacted", savedTemplateId);
      toast(
        logged ? `Copied for ${fan.name} — paste it in your DMs.` : `Copied, but couldn't mark ${fan.name} as contacted.`,
        { tone: logged ? "success" : "error" },
      );
      setTally((t) => ({ ...t, copied: t.copied + 1 }));
      next();
    } finally {
      setBusy(false);
    }
  }

  async function snooze() {
    if (!fan || busy) return;
    setBusy(true);
    try {
      if (await postOutreach(fan.fanId, "snoozed", null)) {
        toast(`${fan.name} snoozed for ${WINBACK_SNOOZE_DAYS} days.`, { tone: "info" });
        setTally((t) => ({ ...t, snoozed: t.snoozed + 1 }));
        next();
      } else {
        toast("Couldn't snooze. Try again.", { tone: "error" });
      }
    } finally {
      setBusy(false);
    }
  }

  function skip() {
    if (!fan || busy) return;
    setTally((t) => ({ ...t, skipped: t.skipped + 1 }));
    next();
  }

  return (
    <div className="fixed inset-0 z-50">
      <div className="fade-in absolute inset-0 bg-black/60" onClick={close} aria-hidden="true" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Win-back queue"
        tabIndex={-1}
        data-testid="winback-queue"
        className="drawer-in absolute inset-x-0 bottom-0 flex max-h-[88dvh] flex-col overflow-y-auto overscroll-contain rounded-t-[28px] border-t border-[#2a2533] bg-surface pb-[env(safe-area-inset-bottom)] shadow-[0_-30px_60px_-20px_rgba(0,0,0,.7)] lg:inset-x-auto lg:right-0 lg:top-0 lg:h-full lg:max-h-none lg:w-full lg:max-w-[444px] lg:rounded-none lg:border-l lg:border-t-0 lg:pb-0 lg:shadow-[-30px_0_70px_-20px_rgba(0,0,0,.75)]"
      >
        <div className="sticky top-0 z-10 border-b border-[#1f1b27] bg-surface px-5 pb-4 pt-2.5 lg:pt-[18px]">
          <div
            {...sheetDrag}
            aria-hidden="true"
            className="-mx-5 -mt-2.5 mb-1 flex cursor-grab touch-none justify-center pb-1.5 pt-2.5 lg:hidden"
          >
            <span className="h-[5px] w-[42px] rounded-full bg-[#3a3442]" />
          </div>
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-[17px] font-bold text-ink">Win-back</h2>
              <p className="tnum mt-0.5 text-xs text-muted" aria-live="polite" data-testid="winback-progress">
                {fan ? `Fan ${index + 1} of ${fans.length}` : "Queue finished"}
              </p>
            </div>
            <CloseButton ref={closeRef} onClick={close} />
          </div>
        </div>

        <div className="flex flex-col gap-4 px-5 py-5">
          {fan ? (
            <>
              <div className="flex items-center gap-3">
                <span
                  aria-hidden="true"
                  className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-[color-mix(in_oklab,var(--brand)_18%,transparent)] text-[15px] font-bold text-ink"
                >
                  {initialsOf(fan.name)}
                </span>
                <div className="min-w-0">
                  <h3 className="truncate text-[15px] font-bold text-ink" data-testid="winback-fan">
                    {fan.name}
                  </h3>
                  <p className="tnum text-xs text-muted text-pretty">
                    {fan.daysSince !== null ? `${fan.daysSince}d quiet` : "Quiet"} · {formatCents(fan.totalSpent)} lifetime
                    {fan.lastWin ? ` · last won ${fan.lastWin}` : ""}
                  </p>
                </div>
              </div>

              <div>
                <label htmlFor={selectId} className="mb-1.5 block text-xs font-semibold text-muted">
                  Message
                </label>
                <select
                  id={selectId}
                  className="ff-input w-full"
                  value={template?.id ?? ""}
                  onChange={(e) => onTemplate(e.target.value)}
                >
                  {templates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.title}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <p className="mb-1.5 text-xs font-semibold text-muted">Preview</p>
                <p
                  data-testid="winback-preview"
                  className="whitespace-pre-wrap break-words rounded-[10px] border border-[var(--hair)] p-3 text-[13.5px] leading-relaxed text-ink [background:var(--s2)]"
                >
                  {message}
                </p>
                {template && !templateHasLink(template.body) && (
                  <p className="mt-1.5 text-xs text-[#fcd34d]">
                    This message has no {"{link}"}, so the fan won&rsquo;t get their spin link.
                  </p>
                )}
                <p className="mt-1.5 text-xs text-muted text-pretty">
                  You paste it into your own DMs. FanFunnel never messages fans for you.
                </p>
              </div>

              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={copyAndNext}
                  disabled={busy}
                  className="btn-brand inline-flex min-h-11 flex-1 items-center justify-center rounded-[10px] px-4 text-[13.5px] font-bold disabled:opacity-50"
                >
                  Copy &amp; next
                </button>
                <button type="button" onClick={skip} disabled={busy} className={secondaryBtn}>
                  Skip
                </button>
                <button type="button" onClick={snooze} disabled={busy} className={secondaryBtn}>
                  Snooze {WINBACK_SNOOZE_DAYS}d
                </button>
              </div>
            </>
          ) : (
            <div className="flex flex-col items-start gap-3" data-testid="winback-done">
              <h3 className="text-[15px] font-bold text-ink">All done</h3>
              <p className="tnum text-sm text-muted">
                {tally.copied} copied · {tally.snoozed} snoozed · {tally.skipped} skipped
              </p>
              <p className="text-xs text-muted text-pretty">
                Contacted fans rest for {WINBACK_CONTACT_COOLDOWN_DAYS} days before they can come up again. You&rsquo;ll
                see who came back on the win-back card.
              </p>
              <button type="button" onClick={close} className={secondaryBtn}>
                Close
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
