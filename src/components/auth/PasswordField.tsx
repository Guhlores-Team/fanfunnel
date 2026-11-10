"use client";

import { useId, useState } from "react";

/**
 * A password input with a show/hide toggle (WU-09) and a caps-lock hint, for
 * every password field in the sign-in family. The input keeps the caller's
 * `aria-label`, so the e2e selectors (input[aria-label='Password']) and
 * password managers see exactly what they did before.
 */
export default function PasswordField({
  value,
  onChange,
  label,
  name,
  autoComplete,
  placeholder,
  minLength,
  required = true,
  invalid,
  describedBy,
  className = "",
  autoFocus,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  name: string;
  autoComplete: "current-password" | "new-password";
  placeholder?: string;
  minLength?: number;
  required?: boolean;
  invalid?: boolean;
  describedBy?: string;
  className?: string;
  autoFocus?: boolean;
  disabled?: boolean;
}) {
  const [shown, setShown] = useState(false);
  const [caps, setCaps] = useState(false);
  const id = useId();
  const capsId = `${id}-caps`;
  const described = [describedBy, caps ? capsId : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className={className}>
      <div className="relative">
        <input
          id={id}
          type={shown ? "text" : "password"}
          name={name}
          required={required}
          minLength={minLength}
          autoComplete={autoComplete}
          autoFocus={autoFocus}
          disabled={disabled}
          aria-label={label}
          aria-invalid={invalid ? true : undefined}
          aria-describedby={described}
          className="ff-input w-full pr-16"
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyUp={(e) => setCaps(e.getModifierState?.("CapsLock") ?? false)}
          onBlur={() => setCaps(false)}
        />
        <button
          type="button"
          aria-pressed={shown}
          aria-label={shown ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
          onClick={() => setShown((v) => !v)}
          className="absolute inset-y-0 right-0 my-auto inline-flex min-h-11 items-center px-3 text-xs font-semibold text-white/60 hover:text-white"
        >
          {shown ? "Hide" : "Show"}
        </button>
      </div>
      {caps && (
        <p id={capsId} role="status" className="mt-1 text-xs text-amber-300">
          Caps Lock is on.
        </p>
      )}
    </div>
  );
}
