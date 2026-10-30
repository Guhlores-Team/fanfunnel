"use client";

import type { HappyHourStatus } from "@/lib/data/types";
import { useNow } from "@/lib/hooks/useNow";

/** A time-boxed "rare odds boosted" banner shown to fans during a happy hour. */
export default function HappyHourBanner({ status }: { status: HappyHourStatus }) {
  if (!status.active || !status.endsAt) return null;
  return <ActiveBanner endsAt={status.endsAt} multiplier={status.multiplier} />;
}

function ActiveBanner({ endsAt, multiplier }: { endsAt: string; multiplier: number }) {
  // The countdown is clock-driven, so the server HTML and the hydration render
  // show a placeholder (`now` is null) and the live value fills in right after.
  // Computing it from Date.now() during render made SSR and client text differ.
  const now = useNow(1000);
  const left = now === null ? null : remaining(endsAt, now);

  if (left !== null && left <= 0) return null;

  return (
    <div
      className="reveal flex w-full items-center justify-between gap-3 rounded-2xl border px-4 py-3"
      style={{
        animationDelay: "0.1s",
        borderColor: "color-mix(in oklab, var(--brand) 55%, transparent)",
        background: "color-mix(in oklab, var(--brand) 14%, transparent)",
      }}
    >
      <div className="flex items-center gap-2.5">
        <span className="text-xl" aria-hidden>
          🔥
        </span>
        <div className="leading-tight">
          <p className="text-sm font-extrabold text-ink">Happy hour</p>
          <p className="text-xs text-muted">
            Rare odds boosted{" "}
            <span className="font-bold text-[var(--brand)]">×{multiplier}</span>
          </p>
        </div>
      </div>
      <span className="tnum rounded-full bg-surface/70 px-3 py-1 text-xs font-bold text-ink">
        {left === null ? "–:––" : fmt(left)}
      </span>
    </div>
  );
}

function remaining(endsAt: string, now: number): number {
  return Math.max(0, new Date(endsAt).getTime() - now);
}

function fmt(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
