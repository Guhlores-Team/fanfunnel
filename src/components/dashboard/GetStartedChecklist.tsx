"use client";

interface Step {
  key: string;
  label: string;
  hint: string;
  done: boolean;
  cta: string;
  go: string; // tab to open
}

/**
 * First-run activation checklist. Guides a brand-new creator through the three
 * steps that actually matter — build a wheel, grant a fan spins, send the link —
 * and self-hides once all are done (or the creator dismisses it). Each step
 * deep-links to the tab where it happens.
 *
 * Dismissal is controlled by the parent and persisted to the creator's account
 * (so it follows them across devices and can be re-opened from the header),
 * rather than being kept in this browser's localStorage.
 */
export default function GetStartedChecklist({
  wheelSaved,
  fans,
  spins,
  dismissed,
  onDismiss,
  onGoTo,
}: {
  wheelSaved: boolean;
  fans: number;
  spins: number;
  dismissed: boolean;
  onDismiss: () => void;
  onGoTo: (tab: string) => void;
}) {
  const steps: Step[] = [
    {
      key: "wheel",
      label: "Build your prize wheel",
      hint: "Set your prizes, odds, and brand colour. We started you with a sample.",
      done: wheelSaved,
      cta: "Edit wheel",
      go: "editor",
    },
    {
      key: "fan",
      label: "Add a fan & grant spins",
      hint: "Record a fan (and the spins they paid for) to mint their personal link.",
      done: fans > 0,
      cta: "Add a fan",
      go: "fans",
    },
    {
      key: "share",
      label: "Send them their spin link",
      hint: "Copy the fan's /spin link and drop it in a DM. When they spin, you're live.",
      done: spins > 0,
      cta: "Get the link",
      go: "fans",
    },
  ];

  const doneCount = steps.filter((s) => s.done).length;
  const allDone = doneCount === steps.length;
  if (dismissed || allDone) return null;

  return (
    <div className="card mt-5 rounded-2xl border-[var(--brand)]/30 p-5">
      <div className="flex items-center justify-between">
        <h2 className="font-bold text-ink">🚀 Get started</h2>
        <span className="text-sm text-muted tnum">{doneCount} of {steps.length}</span>
      </div>
      <p className="mt-1 text-sm text-muted">Three steps to your first spin.</p>

      <ol className="mt-4 space-y-2">
        {steps.map((s) => (
          <li
            key={s.key}
            className="flex items-start gap-3 rounded-xl border border-line p-3"
            style={s.done ? { opacity: 0.6 } : undefined}
          >
            <span
              className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full text-xs font-bold"
              style={{
                background: s.done ? "var(--brand)" : "color-mix(in oklab, var(--brand) 14%, transparent)",
                color: s.done ? "#fff" : "var(--brand)",
              }}
            >
              {s.done ? "✓" : steps.indexOf(s) + 1}
            </span>
            <div className="min-w-0 flex-1">
              <p className={`font-semibold text-ink ${s.done ? "line-through" : ""}`}>{s.label}</p>
              {!s.done && <p className="mt-0.5 text-sm text-muted text-pretty">{s.hint}</p>}
            </div>
            {!s.done && (
              <button
                onClick={() => onGoTo(s.go)}
                className="btn-brand shrink-0 rounded-lg px-3 py-1.5 text-sm font-bold"
              >
                {s.cta}
              </button>
            )}
          </li>
        ))}
      </ol>

      <button
        onClick={onDismiss}
        className="mt-3 text-xs font-semibold text-muted transition hover:text-ink"
      >
        Dismiss — I&rsquo;ll explore on my own
      </button>
    </div>
  );
}
