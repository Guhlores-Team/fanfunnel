"use client";

import { useState } from "react";

// Preset tags offered as one-tap toggles in the tag editor.
const PRESET_TAGS = ["VIP", "whale", "new"] as const;

/**
 * An inline tag editor: small removable chips, preset toggles, and a free-text
 * add. Calls `onChange` with the next tag array; the caller persists + refreshes.
 * `compact` trims spacing for the dense AccountCard layout.
 */
function TagEditor({
  tags,
  onChange,
  disabled,
  compact,
}: {
  tags: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  const [draft, setDraft] = useState("");

  function commit(next: string[]) {
    // De-dupe (case-insensitive) and drop empties, preserving order.
    const seen = new Set<string>();
    const cleaned: string[] = [];
    for (const t of next) {
      const v = t.trim();
      if (!v) continue;
      const key = v.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      cleaned.push(v);
    }
    onChange(cleaned);
  }

  function toggle(tag: string) {
    const has = tags.some((t) => t.toLowerCase() === tag.toLowerCase());
    commit(has ? tags.filter((t) => t.toLowerCase() !== tag.toLowerCase()) : [...tags, tag]);
  }

  function addDraft() {
    const v = draft.trim();
    if (!v) return;
    commit([...tags, v]);
    setDraft("");
  }

  return (
    <div className={compact ? "space-y-2" : "space-y-2.5"}>
      {tags.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {tags.map((t) => (
            <span
              key={t}
              className="inline-flex items-center gap-1 rounded-full border border-[var(--brand)]/40 bg-[color-mix(in_oklab,var(--brand)_12%,transparent)] px-2 py-0.5 text-xs font-semibold text-ink"
            >
              {t}
              <button
                type="button"
                disabled={disabled}
                onClick={() => commit(tags.filter((x) => x !== t))}
                aria-label={`Remove tag ${t}`}
                className="text-muted transition hover:text-ink disabled:opacity-50"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        {PRESET_TAGS.map((preset) => {
          const active = tags.some((t) => t.toLowerCase() === preset.toLowerCase());
          return (
            <button
              key={preset}
              type="button"
              disabled={disabled}
              onClick={() => toggle(preset)}
              aria-pressed={active}
              className={`rounded-full px-2.5 py-0.5 text-xs font-semibold transition disabled:opacity-50 ${
                active
                  ? "bg-[var(--brand)] text-white"
                  : "border border-line text-muted hover:text-ink"
              }`}
            >
              {preset}
            </button>
          );
        })}
        <span className="inline-flex items-center gap-1">
          <input
            className="ff-input w-28 py-1 text-xs"
            placeholder="Add tag"
            value={draft}
            disabled={disabled}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addDraft();
              }
            }}
            aria-label="Add a custom tag"
          />
          <button
            type="button"
            disabled={disabled || !draft.trim()}
            onClick={addDraft}
            className="rounded-lg border border-line px-2 py-1 text-xs font-semibold text-ink transition hover:bg-white/5 disabled:opacity-50"
          >
            Add
          </button>
        </span>
      </div>
    </div>
  );
}

function Field({
  label,
  children,
  full,
}: {
  label: string;
  children: React.ReactNode;
  full?: boolean;
}) {
  return (
    <label className={`flex min-w-0 flex-col gap-1 ${full ? "sm:col-span-2" : ""}`}>
      <span className="text-xs font-semibold uppercase tracking-wider text-muted">{label}</span>
      {children}
    </label>
  );
}

function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="rounded-xl border border-dashed border-line p-8 text-center">
      <p className="font-semibold text-ink">{title}</p>
      <p className="mx-auto mt-1 max-w-sm text-sm text-muted">{body}</p>
      {action && (
        <button onClick={action.onClick} className="btn-brand mt-4 rounded-lg px-4 py-2 text-sm font-bold">
          {action.label}
        </button>
      )}
    </div>
  );
}

export { EmptyState, Field, TagEditor };
