"use client";

import { useEffect, useRef, useState } from "react";

/**
 * The Continue page's submit button (review A5). The link is single-use, so a
 * second tap while the first is on its way would find it already spent: after
 * the first submit the button disables itself, shows progress and swallows
 * further submits. Without JavaScript it is an ordinary submit button in an
 * ordinary form (nothing here is needed for the POST). No script ever submits
 * the form: a mail scanner's sandbox must not be able to spend the link.
 */
export default function ContinueButton({ label, className }: { label: string; className?: string }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [sent, setSent] = useState(false);

  useEffect(() => {
    const form = ref.current?.form;
    if (!form) return;
    const onSubmit = (e: Event) => {
      if (form.dataset.sent === "1") {
        e.preventDefault();
        return;
      }
      form.dataset.sent = "1";
      setSent(true);
    };
    // Back from the next page can restore this one as it was left (bfcache):
    // make the button usable again; the server copes with a spent link.
    const onShow = (e: PageTransitionEvent) => {
      if (!e.persisted) return;
      delete form.dataset.sent;
      setSent(false);
    };
    form.addEventListener("submit", onSubmit);
    window.addEventListener("pageshow", onShow);
    // Marks the form once the guard is live (the journeys wait for it).
    form.dataset.enhanced = "1";
    return () => {
      delete form.dataset.enhanced;
      form.removeEventListener("submit", onSubmit);
      window.removeEventListener("pageshow", onShow);
    };
  }, []);

  return (
    <>
      <button ref={ref} type="submit" disabled={sent} aria-busy={sent || undefined} data-testid="auth-continue-button" className={className}>
        {sent ? "Checking your link…" : `${label} →`}
      </button>
      <span role="status" className="sr-only">
        {sent ? "Checking your link. This takes a moment." : ""}
      </span>
    </>
  );
}
