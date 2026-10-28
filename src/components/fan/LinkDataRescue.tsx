"use client";

import { useId, useState } from "react";
import { usePathname } from "next/navigation";
import { FanDataActions } from "./FanDataControls";

/**
 * Under the 404 of a fan link that doesn't open (paused, blocked, switched off
 * or mistyped): the fan can still download or delete their data with the
 * link's token. The page stays a 404 either way, and the server only answers
 * for a token that really exists, so this reveals nothing about a link.
 */
export default function LinkDataRescue() {
  const pathname = usePathname();
  const token = /^\/spin\/([^/?#]+)/.exec(pathname ?? "")?.[1] ?? null;
  const [open, setOpen] = useState(false);
  const panelId = useId();
  if (!token) return null;
  return (
    <div className="mt-5 border-t border-line pt-4 text-left">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
        className="w-full text-center text-xs text-muted underline-offset-4 hover:text-ink hover:underline"
      >
        Was this your link? Download or delete your data
      </button>
      <div id={panelId} hidden={!open} className="mt-3">
        {open && <FanDataActions token={decodeURIComponent(token)} />}
      </div>
    </div>
  );
}
