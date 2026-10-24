"use client";

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

interface LinkPauseValue {
  paused: boolean;
  markPaused: () => void;
}

const LinkPauseContext = createContext<LinkPauseValue>({ paused: false, markPaused: () => {} });

/**
 * Shares the "this link was just paused" fact between the SafetyMenu (footer)
 * and SpinClient (wheel), which are siblings on the server-rendered fan page —
 * so a successful pause disables SPIN at once, with no reload.
 */
export function LinkPauseProvider({ children }: { children: ReactNode }) {
  const [paused, setPaused] = useState(false);
  const value = useMemo(() => ({ paused, markPaused: () => setPaused(true) }), [paused]);
  return <LinkPauseContext.Provider value={value}>{children}</LinkPauseContext.Provider>;
}

export const useLinkPause = () => useContext(LinkPauseContext);
