"use client";

import { useId, useState } from "react";
import { usePathname } from "next/navigation";
import { FanDataActions } from "./FanDataControls";
import { LeaderboardWithdrawal } from "./FanLeaderboard";

/**
 * Under the 404 of a fan link that doesn't open (paused, blocked, switched off
 * or mistyped): the fan can still withdraw leaderboard consent, download or
 * delete their data with the
 * link's token. The page stays a 404 either way, and the server only answers
 * for a token that really exists, so this reveals nothing about a link.
 */
export default function LinkDataRescue() {
  const pathname = usePathname();
  const encodedToken = /^\/spin\/([^/?#]+)/.exec(pathname ?? "")?.[1] ?? null;
  let token: string | null = null;
  try { if (encodedToken) token = decodeURIComponent(encodedToken); } catch { /* Malformed links have no privacy credential. */ }
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
      <p className="mt-2 text-center text-xs text-muted">You can also remove yourself from the leaderboard here.</p>
      <div id={panelId} hidden={!open} className="mt-3">
        {open && <>
          <FanDataActions key={`data:${token}`} token={token} />
          <div className="mt-4">
            <LeaderboardWithdrawal key={`leaderboard-withdraw:${token}`} token={token} onWithdrawn={() => {}} />
          </div>
        </>}
      </div>
    </div>
  );
}
