"use client";

import { useEffect, useId, useState } from "react";
import QRCode from "qrcode";
import { useToast } from "@/components/ui/Toast";
import { copyToClipboard } from "@/lib/hooks/useClipboard";
import { useFocusTrap } from "@/lib/hooks/useFocusTrap";

const QR_ICON = "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h3v3h-3zM18 18h3v3h-3zM14 21h1M21 14h-1";

/**
 * A compact "QR" button that opens a centered dialog rendering a QR code for the
 * given URL, with Download-PNG and Copy-link actions. The QR data URL is
 * generated lazily (only once the dialog is first opened) and cached.
 */
export default function QrButton({
  url,
  label = "Fan link",
  className = "inline-flex min-h-9 items-center gap-1.5 rounded-[9px] border border-line px-3 text-xs font-semibold text-ink transition-colors hover:bg-[color-mix(in_oklab,var(--color-ink)_5%,transparent)]",
}: {
  url: string;
  label?: string;
  /** Trigger button classes (the drawer's action row passes its own). */
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const panelId = useId();
  const toast = useToast();
  // Shared focus trap: focus in, Tab cycle, focus restored to the trigger on
  // close. Escape is handled in the capture phase below so it closes only this
  // dialog, not a drawer the button sits in (whose trap also listens).
  const dialogRef = useFocusTrap<HTMLDivElement>({ active: open });
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      setOpen(false);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open]);

  // Generate the QR PNG the first time the dialog opens.
  useEffect(() => {
    if (!open || dataUrl || error) return;
    let active = true;
    QRCode.toDataURL(url, { width: 320, margin: 2, errorCorrectionLevel: "M" })
      .then((d) => {
        if (active) setDataUrl(d);
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [open, dataUrl, error, url]);

  async function copyLink() {
    if (await copyToClipboard(url)) {
      toast("Link copied", { tone: "success" });
    } else {
      toast("Couldn't copy link", { tone: "error" });
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={`Show QR code for ${label}`}
        className={className}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
          <path d={QR_ICON} />
        </svg>
        QR
      </button>

      {open && (
        // Always a centered dialog with a dimmed backdrop — anchoring to the
        // button clipped off-screen whenever the row sat near a viewport edge.
        <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
          <div
            className="fade-in absolute inset-0 bg-black/60"
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />
          <div
            ref={dialogRef}
            id={panelId}
            role="dialog"
            aria-modal="true"
            aria-label={`QR code for ${label}`}
            className="lift-in relative w-full max-w-xs rounded-2xl border border-[var(--hair)] p-4 shadow-[var(--lift)] [background:var(--s1)]"
          >
            <p className="mb-3 truncate text-xs text-muted" title={url}>
              {label}
            </p>
            <div className="grid place-items-center rounded-xl bg-white p-3">
              {error ? (
                <p className="py-8 text-center text-xs text-[#4b4554]">
                  Couldn&rsquo;t generate QR code.
                </p>
              ) : dataUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- data URL, not an optimizable asset
                <img
                  src={dataUrl}
                  alt={`QR code linking to ${label}`}
                  width={208}
                  height={208}
                  className="h-52 w-52"
                />
              ) : (
                <div className="skeleton h-52 w-52 rounded" />
              )}
            </div>

            <div className="mt-3 flex items-center gap-2">
              <a
                href={dataUrl ?? "#"}
                download="fan-link-qr.png"
                aria-disabled={!dataUrl}
                onClick={(e) => {
                  if (!dataUrl) e.preventDefault();
                }}
                className={`btn-brand flex min-h-9 flex-1 items-center justify-center rounded-[9px] px-3 text-xs font-bold ${
                  dataUrl ? "" : "pointer-events-none opacity-50"
                }`}
              >
                Download PNG
              </a>
              <button
                type="button"
                onClick={copyLink}
                className="min-h-9 flex-1 rounded-[9px] border border-line px-3 text-xs font-semibold text-ink transition-colors hover:bg-[color-mix(in_oklab,var(--color-ink)_5%,transparent)]"
              >
                Copy link
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
