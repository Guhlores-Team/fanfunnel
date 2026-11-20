"use client";

import { useSyncExternalStore, type ReactNode } from "react";
import { parseNotFoundPath, sectionFor, type NotFoundSection } from "@/lib/fan/linkNotFound";

// WA-02: the root not-found page is static (see src/lib/fan/linkNotFound.ts)
// and holds every explanation; the fragment picks one without script, and
// after hydration the path does (for links opened without their fragment).
// The server and first client render agree (no kind), so there is nothing to
// mismatch; the attribute lands right after hydration.
const noSubscribe = () => () => {};
const fromPath = (): NotFoundSection => sectionFor(parseNotFoundPath(window.location.pathname)?.kind ?? null);
const none = () => null;

export default function NotFoundKinds({ children }: { children: ReactNode }) {
  const kind = useSyncExternalStore(noSubscribe, fromPath, none);
  return <div className="nf-kinds" data-kind={kind ?? undefined}>{children}</div>;
}
