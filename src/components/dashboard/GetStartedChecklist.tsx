"use client";

import { FIRST_STEPS_TOTAL, buildFirstSteps, firstStepsAllDone, type FirstStepSignals } from "./firstSteps";

/**
 * "Your first steps": the first-run checklist that lives inside Today (RD-5).
 * Five steps — account, wheel, fan link, share, first fulfilment — each with a
 * CTA into the section where it happens; the three steps the prior checklist
 * tracked keep their exact signals (see firstSteps.ts). Self-hides once every
 * step is done, or when the creator dismisses it.
 *
 * Dismissal is controlled by the parent and persisted to the creator's account
 * (so it follows them across devices and can be re-opened from the sidebar's
 * "Get started" button), rather than living in this browser's localStorage.
 */
export default function GetStartedChecklist({
  signals,
  dismissed,
  onDismiss,
  onGoTo,
}: {
  signals: FirstStepSignals;
  dismissed: boolean;
  onDismiss: () => void;
  onGoTo: (tab: string) => void;
}) {
  if (dismissed || firstStepsAllDone(signals)) return null;
  const steps = buildFirstSteps(signals);
  const doneCount = steps.filter((s) => s.done).length;

  return (
    <section aria-labelledby="first-steps" data-testid="first-steps" className="relative">
      <div className="mb-3.5 flex items-baseline justify-between gap-3">
        <h2 id="first-steps" className="flex items-center gap-[9px] text-base font-bold tracking-[-0.01em] text-ink">
          <span aria-hidden="true" className="h-4 w-[3px] rounded-sm bg-[var(--brand)]" />
          Your first steps
        </h2>
        <span className="tnum text-xs text-muted" aria-live="polite">
          {doneCount} of {FIRST_STEPS_TOTAL} done
        </span>
      </div>

      <ol className="flex flex-col gap-2.5">
        {steps.map((s) => (
          <li
            key={s.key}
            // Phones: the CTA drops under the text (aligned past the ring) so
            // titles don't wrap around a wide button.
            className="lift-in flex flex-wrap items-center gap-3.5 rounded-[14px] border border-[var(--hair)] px-4 py-3.5 shadow-[var(--lift)] [background:var(--s1)] sm:flex-nowrap sm:px-[18px]"
          >
            <span
              aria-hidden="true"
              className={`grid h-6 w-6 shrink-0 place-items-center rounded-full border-2 ${
                s.done ? "border-[var(--brand)] bg-[var(--brand)] text-[var(--brand-ink)]" : "border-[#2a2533] bg-transparent"
              }`}
            >
              {s.done && (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3.2} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 6 9 17l-5-5" />
                </svg>
              )}
            </span>
            <div className="min-w-0 flex-1">
              <p className={`text-[14px] font-semibold ${s.done ? "text-[#8b8494]" : "text-ink"}`}>
                {s.title}
                <span className="sr-only">{s.done ? " (done)" : " (to do)"}</span>
              </p>
              <p className="mt-0.5 text-[12.5px] text-[#8b8494] text-pretty">{s.body}</p>
            </div>
            {!s.done && s.cta && (
              <button
                type="button"
                onClick={() => onGoTo(s.cta!.go)}
                className="btn-brand min-h-[34px] shrink-0 rounded-[9px] px-3.5 text-[12.5px] font-bold max-sm:ml-[38px] max-sm:basis-[calc(100%-38px)]"
              >
                {s.cta.label}
              </button>
            )}
          </li>
        ))}
      </ol>

      <button
        type="button"
        onClick={onDismiss}
        className="-mx-1 mt-2.5 px-1 py-2 text-xs font-semibold text-muted transition-colors hover:text-ink"
      >
        Dismiss — I&rsquo;ll explore on my own
      </button>
    </section>
  );
}
