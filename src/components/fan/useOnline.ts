"use client";

import { useEffect, useState } from "react";

/** PR-18: whether the page is online (true during server rendering and hydration). */
export function useOnline(): boolean {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const update = () => setOnline(typeof navigator === "undefined" || navigator.onLine !== false);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => { window.removeEventListener("online", update); window.removeEventListener("offline", update); };
  }, []);
  return online;
}

/** The offline note's copy (also used by the static test). */
export const OFFLINE_NOTE = "You're offline. Your wins and codes stay saved on this page; playing picks up again when you're back online.";
