"use client";

import { useId, useState } from "react";
import { useClipboard } from "@/lib/hooks/useClipboard";
import type { DeliveredReward } from "@/lib/rewards/config";
import { parseDeliveredReward } from "./instantReward";

/** A winner's private value. Nothing here is persisted or shared automatically. */
export default function InstantReward({ reward }: { reward: DeliveredReward }) {
  const titleId = useId();
  const { copy, copied } = useClipboard();
  const [copyFailed, setCopyFailed] = useState(false);
  const safe = parseDeliveredReward(reward);
  if (!safe) return <RewardUnavailable />;

  const copyValue = async () => {
    setCopyFailed(!(await copy(safe.value)));
  };

  return (
    <section
      aria-labelledby={titleId}
      data-testid="instant-reward"
      className="mt-5 min-w-0 max-w-full rounded-2xl border border-line bg-surface/70 p-4 text-left"
    >
      <h3 id={titleId} className="text-sm font-bold text-ink">Your reward</h3>
      {safe.kind === "link" ? (
        <>
          <p className="mt-1 break-all text-xs text-muted">{new URL(safe.value).hostname}</p>
          <a
            href={safe.value}
            target="_blank"
            rel="noopener noreferrer"
            referrerPolicy="no-referrer"
            className="mt-3 inline-flex min-h-11 items-center justify-center rounded-xl border border-line px-4 py-2 text-sm font-semibold text-ink hover:bg-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand)]"
            data-testid="reward-open"
          >
            Open reward <span className="ml-1" aria-hidden="true">↗</span>
          </a>
          <p className="mt-2 text-xs text-muted">Opens an external website in a new tab.</p>
        </>
      ) : (
        <>
          <p className="mt-3 max-w-full select-all whitespace-pre-wrap break-words text-base font-semibold text-ink [overflow-wrap:anywhere]" data-testid="reward-value">
            {safe.value}
          </p>
          <button
            type="button"
            onClick={copyValue}
            data-testid="reward-copy"
            className="mt-3 inline-flex min-h-11 items-center justify-center rounded-xl border border-line px-4 py-2 text-sm font-semibold text-ink hover:bg-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand)]"
          >
            {copied ? "Copied!" : safe.kind === "code" ? "Copy code" : "Copy reward"}
          </button>
          <p className="mt-2 text-xs text-muted" role="status" aria-live="polite">
            {copyFailed ? "Couldn't copy automatically. Select the reward above and copy it." : copied ? "Reward copied to your clipboard." : "Keep this reward private."}
          </p>
        </>
      )}
    </section>
  );
}

export function RewardUnavailable() {
  return (
    <div className="mt-5 rounded-2xl border border-line bg-surface/70 p-4 text-left" role="status">
      <p className="text-sm font-bold text-ink">Your reward</p>
      <p className="mt-1 text-sm text-muted">We couldn&apos;t display your reward. Try View reward in Your wins, or contact your creator.</p>
    </div>
  );
}
