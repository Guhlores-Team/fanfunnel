"use client";

import { useEffect, useId, useRef, useState } from "react";
import QRCode from "qrcode";
import { useToast } from "@/components/ui/Toast";

/**
 * A compact "QR" button that opens an inline popover rendering a QR code for the
 * given URL, with Download-PNG and Copy-link actions. The QR data URL is
 * generated lazily (only once the popover is first opened) and cached.
 */
export default function QrButton({
  url,
  label = "Fan link",
}: {
  url: string;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const toast = useToast();

  // Generate the QR PNG the first time the popover opens.
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

  // Close on outside click + Escape while open.
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

  async function copyLink() {
    try {
      await navigator.clipboard?.writeText(url);
      toast("Link copied", { tone: "success" });
    } catch {
      toast("Couldn't copy link", { tone: "error" });
    }
  }

  return (
    <div ref={wrapRef} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={`Show QR code for ${label}`}
        className="rounded-lg border border-line px-3 py-1.5 text-xs font-semibold text-ink transition hover:bg-white/5"
      >
        QR
      </button>

      {open && (
        <>
          {/* On phones the popover becomes a centered sheet with a dimmed
              backdrop so it can never clip past the viewport edge. */}
          <div
            className="fixed inset-0 z-30 bg-black/50 sm:hidden"
            onClick={() => setOpen(false)}
            aria-hidden
          />
          <div
            id={panelId}
            role="dialog"
            aria-label={`QR code for ${label}`}
            className="fixed left-1/2 top-1/2 z-40 w-[calc(100vw-2rem)] max-w-xs -translate-x-1/2 -translate-y-1/2 rounded-xl border border-line bg-surface p-4 shadow-2xl sm:absolute sm:left-auto sm:right-0 sm:top-full sm:mt-2 sm:w-60 sm:max-w-[calc(100vw-2rem)] sm:translate-x-0 sm:translate-y-0"
          >
          <p className="mb-3 truncate text-xs text-muted" title={url}>
            {label}
          </p>
          <div className="grid place-items-center rounded-lg bg-white p-3">
            {error ? (
              <p className="py-8 text-center text-xs text-muted">
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
              className={`btn-brand flex-1 rounded-lg px-3 py-1.5 text-center text-xs font-bold ${
                dataUrl ? "" : "pointer-events-none opacity-50"
              }`}
            >
              Download PNG
            </a>
            <button
              type="button"
              onClick={copyLink}
              className="flex-1 rounded-lg border border-line px-3 py-1.5 text-xs font-semibold text-ink transition hover:bg-white/5"
            >
              Copy link
            </button>
          </div>
          </div>
        </>
      )}
    </div>
  );
}
