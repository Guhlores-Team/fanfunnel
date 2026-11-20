"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { GlowMilestoneId } from "@/lib/glow/config";
import type { FanGlow } from "@/lib/glow/glow";

/** The fan's own calendar date ("YYYY-MM-DD"); the server clamps it. */
export function localDay(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/**
 * RM-3: record this visit once the page is hydrated AND visible (link-preview
 * bots fetch HTML without running it, and a background tab isn't a visit),
 * then show the glow the server returns. `enabled` false (a paused link) sends
 * nothing and shows no glow. Purely visual: the response carries no spins.
 */
export function useVisitGlow(token: string, initial: FanGlow | null | undefined, enabled: boolean) {
  const [glow, setGlow] = useState<FanGlow | null>(initial ?? null);
  const [milestone, setMilestone] = useState<GlowMilestoneId | null>(null);
  const sent = useRef(false);

  useEffect(() => {
    if (!enabled || sent.current) return;
    const send = () => {
      if (sent.current || document.visibilityState !== "visible") return;
      sent.current = true;
      document.removeEventListener("visibilitychange", send);
      fetch("/api/fan/checkin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, localDate: localDay() }),
      })
        .then(async (res) => {
          if (res.status === 404) {
            setGlow(null);
            return;
          }
          if (!res.ok) return;
          const data = (await res.json()) as { glow?: FanGlow | null; milestone?: GlowMilestoneId | null };
          if (data.glow !== undefined) setGlow(data.glow);
          if (data.milestone) setMilestone(data.milestone);
        })
        .catch(() => {});
    };
    send();
    document.addEventListener("visibilitychange", send);
    return () => document.removeEventListener("visibilitychange", send);
  }, [token, enabled]);

  const dismissMilestone = useCallback(() => setMilestone(null), []);
  return {
    glow: enabled ? glow : null,
    milestone: enabled ? milestone : null,
    dismissMilestone,
  };
}
