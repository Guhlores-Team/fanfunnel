"use client";

import { useEffect, useState } from "react";

// WC-29: whether this site can send push at all (the server has its key
// pair). Without it, "Get these on your phone" and "Get alerts on this
// device" lead to a card that can only say "not available", so the prompts
// are not shown. One request per page load, shared by every caller.

let pending: Promise<boolean> | null = null;

function readPushAvailable(): Promise<boolean> {
  pending ??= fetch("/api/push/config", { cache: "no-store" })
    .then((res) => (res.ok ? res.json() : null))
    .then((cfg: { available?: unknown; publicKey?: unknown } | null) => !!cfg?.available && typeof cfg.publicKey === "string")
    .catch(() => {
      pending = null; // a failed read is asked again by the next caller
      return false;
    });
  return pending;
}

/** null while unknown; true only when the server answered that push is configured. */
export function usePushAvailable(): boolean | null {
  const [available, setAvailable] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    void readPushAvailable().then((value) => {
      if (live) setAvailable(value);
    });
    return () => {
      live = false;
    };
  }, []);
  return available;
}
