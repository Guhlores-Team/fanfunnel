"use client";

import type { Ref } from "react";

/**
 * The creator clickwrap: a required "I agree to the Terms of Service and Privacy
 * Policy" checkbox. Used at sign-up, on the access request (/pending) and in the
 * dashboard's re-accept prompt. The links open in a new tab so the form keeps
 * its state. Ticking it records nothing by itself: the caller posts the
 * acceptance to a server route, which stamps the time and the Terms version.
 */
export default function TermsCheckbox({
  checked,
  onChange,
  disabled,
  inputRef,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  inputRef?: Ref<HTMLInputElement>;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-line p-3 text-left text-sm">
      <input
        ref={inputRef}
        type="checkbox"
        required
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        data-testid="terms-checkbox"
        className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--brand)]"
      />
      <span className="text-ink">
        I agree to the{" "}
        <a href="/terms" target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
          Terms of Service
        </a>{" "}
        and{" "}
        <a href="/privacy" target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
          Privacy Policy
        </a>
      </span>
    </label>
  );
}
