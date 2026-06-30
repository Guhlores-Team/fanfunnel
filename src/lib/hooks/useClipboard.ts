"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Copy text to the clipboard using the async Clipboard API, falling back to a
 * hidden-textarea + execCommand for non-secure contexts (http / older browsers)
 * where navigator.clipboard is unavailable. Returns whether the copy succeeded.
 *
 * Extracted from DebugConsole's copyText so every "Copy" control shares the one
 * robust implementation instead of each calling `navigator.clipboard?.writeText`
 * (which silently no-ops on insecure origins).
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to legacy path */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

interface UseClipboardOptions {
  /** How long the `copied` flag stays true after a successful copy (ms). */
  resetMs?: number;
}

interface UseClipboardResult {
  /** Copy `text`; returns whether it succeeded. Flips `copied` on success. */
  copy: (text: string) => Promise<boolean>;
  /** True for `resetMs` after a successful copy (for "Copied!" affordances). */
  copied: boolean;
}

/**
 * Clipboard hook with a self-resetting `copied` flag. The reset timer is cleared
 * on unmount so a copy right before the component leaves the tree never sets
 * state on an unmounted component.
 */
export function useClipboard({ resetMs = 1500 }: UseClipboardOptions = {}): UseClipboardResult {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );

  const copy = useCallback(
    async (text: string): Promise<boolean> => {
      const ok = await copyToClipboard(text);
      if (ok) {
        setCopied(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), resetMs);
      }
      return ok;
    },
    [resetMs]
  );

  return { copy, copied };
}
