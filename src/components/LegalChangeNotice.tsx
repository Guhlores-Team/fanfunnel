"use client";

import { useEffect, useState } from "react";
import { LEGAL, activeLegalChangeNotice, formatLegalDate, type LegalChangeNotice as Notice } from "@/lib/legal";

// TS-06: the notice the Terms and Privacy Policy promise before a material
// change. An admin announces the change (Admin › Terms change notice); this
// reads it from GET /api/legal-notice once per page load, however many times
// the component is mounted, and renders nothing unless a later version's
// effective date is still ahead. Then: one short line with the date and links
// to the current text, on every fan-facing page (through LegalLinks) and at
// the top of the dashboard. A notice set in code (LEGAL.upcoming) renders
// straight away, without waiting for the request.

const CHANGED = "ff:legal-notice";
let pending: Promise<Notice | null> | null = null;

function load(): Promise<Notice | null> {
  pending ??= fetch("/api/legal-notice")
    .then((r) => (r.ok ? r.json() : null))
    .then((body: { notice?: Notice | null } | null) => activeLegalChangeNotice(new Date(), body?.notice ?? null) ?? activeLegalChangeNotice())
    .catch(() => activeLegalChangeNotice());
  return pending;
}

/** Forget the loaded notice and tell every mounted copy to read it again (after an admin changes it). */
export function refreshLegalChangeNotice() {
  pending = null;
  if (typeof window !== "undefined") window.dispatchEvent(new Event(CHANGED));
}

export default function LegalChangeNotice({ className = "" }: { className?: string }) {
  const [notice, setNotice] = useState<Notice | null>(() => activeLegalChangeNotice());
  useEffect(() => {
    let live = true;
    const read = () => void load().then((n) => live && setNotice(n));
    read();
    window.addEventListener(CHANGED, read);
    return () => {
      live = false;
      window.removeEventListener(CHANGED, read);
    };
  }, []);
  if (!notice) return null;
  return (
    <p
      role="status"
      data-testid="legal-change-notice"
      className={`rounded-xl border border-line bg-surface px-3 py-2 text-center text-[12px] leading-relaxed text-muted ${className}`}
    >
      <strong className="text-ink">Our Terms and Privacy Policy change on {formatLegalDate(notice.effectiveDate)}.</strong>{" "}
      {notice.summary ? `${notice.summary} ` : ""}The current text is at{" "}
      <a href="/terms" className="underline underline-offset-4 hover:text-ink">
        /terms
      </a>{" "}
      and{" "}
      <a href="/privacy" className="underline underline-offset-4 hover:text-ink">
        /privacy
      </a>
      ; {LEGAL.operator} will ask you to agree to the new version when it takes effect.
    </p>
  );
}
