"use client";

import { useState } from "react";

/**
 * WU-09: a dashboard password input with a show/hide toggle. Used inside
 * `Field`, so the visible label stays the field's; the input carries the same
 * text as its `aria-label`, and the toggle is named "Show password" so label
 * lookups ("Current password") keep matching the input alone.
 */
export default function PasswordInput({
  label,
  value,
  onChange,
  autoComplete,
  placeholder,
  disabled,
  invalid,
  describedBy,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: "current-password" | "new-password";
  placeholder?: string;
  disabled?: boolean;
  invalid?: boolean;
  describedBy?: string;
}) {
  const [shown, setShown] = useState(false);
  return (
    <span className="relative block">
      <input
        type={shown ? "text" : "password"}
        autoComplete={autoComplete}
        className="ff-input w-full pr-16"
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        aria-label={label}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        onChange={(e) => onChange(e.target.value)}
      />
      <button
        type="button"
        aria-pressed={shown}
        aria-label={shown ? "Hide password" : "Show password"}
        disabled={disabled}
        onClick={(e) => {
          e.preventDefault();
          setShown((v) => !v);
        }}
        className="absolute inset-y-0 right-0 my-auto inline-flex min-h-9 items-center px-3 text-xs font-semibold text-muted hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-ui)] max-sm:min-h-11"
      >
        {shown ? "Hide" : "Show"}
      </button>
    </span>
  );
}
