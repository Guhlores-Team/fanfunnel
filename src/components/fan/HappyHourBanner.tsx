"use client";

import { useEffect, useState } from "react";
import type { HappyHourStatus } from "@/lib/data/types";

/** A time-boxed "rare odds boosted" banner shown to fans during a happy hour. */
export default function HappyHourBanner({ status }: { status: HappyHourStatus }) {
  const [left, setLeft] = useState(() => remaining(status.endsAt));

  useEffect(() => {
    if (!status.active) return;
    const id = setInterval(() => setLeft(remaining(status.endsAt)), 1000);
    return () => clearInterval(id);
  }, [status.active, status.endsAt]);

  if (!status.active || left <= 0) return null;

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
            <span className="font-bold text-[var(--brand)]">×{status.multiplier}</span>
          </p>
        </div>
      </div>
      <span className="tnum rounded-full bg-surface/70 px-3 py-1 text-xs font-bold text-ink">
        {fmt(left)}
      </span>
    </div>
  );
}

function remaining(endsAt: string | null): number {
  if (!endsAt) return 0;
  return Math.max(0, new Date(endsAt).getTime() - Date.now());
}

function fmt(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
