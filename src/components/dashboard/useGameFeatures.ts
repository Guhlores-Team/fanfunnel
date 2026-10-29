"use client";

import { useCallback, useEffect, useState } from "react";
import { readGameFeatures, type GameFeatures } from "./gameEditor";

/** Account capabilities come from the authenticated server response only. */
export function useGameFeatures() {
  const [features, setFeatures] = useState<GameFeatures | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const reload = useCallback(async () => {
    try {
      const response = await fetch("/api/account", { cache: "no-store" });
      if (!response.ok) throw new Error();
      const value = readGameFeatures(await response.json());
      if (!value) throw new Error();
      setFeatures(value); setError("");
    } catch {
      setFeatures(null);
      setError("Game permissions couldn't load. Wheel is available; extra game types stay hidden until permissions can be checked.");
    } finally { setLoading(false); }
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- authenticated fetch-on-mount; state lands after the network response
    void reload();
    const onFocus = () => { void reload(); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [reload]);
  return { features, error, loading, reload };
}
