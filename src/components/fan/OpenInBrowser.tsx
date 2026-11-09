"use client";

import { useId, useState } from "react";
import { copyToClipboard } from "@/lib/hooks/useClipboard";
import { androidBrowserIntent, type InAppBrowser } from "./inAppBrowser";

/**
 * FD-5: inside an app's built-in browser the fan can't change site settings,
 * so the way forward is the phone's own browser. One primary action (copy the
 * link), the address itself if copying fails, and on Android a direct
 * "Open in Chrome".
 */
export default function OpenInBrowser({ inApp }: { inApp: InAppBrowser }) {
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  const inputId = useId();
  const href = typeof window === "undefined" ? "" : window.location.href;
  const intent = inApp.android ? androidBrowserIntent(href) : null;
  const copy = async () => setCopied((await copyToClipboard(href)) ? "copied" : "failed");
  return (
    <div data-testid="open-in-browser" className="flex w-full flex-col items-center gap-2 text-center">
      <p className="text-sm font-semibold text-ink text-pretty">
        Open this link in your phone&rsquo;s browser (Safari or Chrome)
      </p>
      <div className="flex flex-wrap justify-center gap-2">
        <button
          type="button"
          onClick={() => void copy()}
          data-testid="open-in-browser-copy"
          className="btn-brand min-h-11 rounded-xl px-5 text-sm font-extrabold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand)]"
        >
          {copied === "copied" ? "Link copied" : "Copy link"}
        </button>
        {intent && (
          <a
            href={intent}
            className="inline-flex min-h-11 items-center rounded-xl border border-line px-4 text-sm font-semibold text-ink"
          >
            Open in Chrome
          </a>
        )}
      </div>
      <p role="status" className="text-xs text-muted text-pretty">
        {copied === "copied" ? "Now paste it into Safari or Chrome." : ""}
      </p>
      {copied === "failed" && (
        <div className="w-full text-left">
          <label htmlFor={inputId} className="block text-xs text-muted">
            Couldn&rsquo;t copy automatically. Copy this link:
          </label>
          <input
            id={inputId}
            readOnly
            value={href}
            onFocus={(e) => e.currentTarget.select()}
            className="ff-input mt-1 w-full font-mono text-xs"
          />
        </div>
      )}
    </div>
  );
}
