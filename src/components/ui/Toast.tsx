"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import { withSuspendedReason } from "@/lib/onboarding/suspended";

type Tone = "info" | "error" | "success";

interface ToastOptions {
  tone?: Tone;
  duration?: number;
  action?: { label: string; onClick: () => void };
  /** A toast with the same key replaces the earlier one instead of stacking (WC-02). */
  key?: string;
}

interface ToastItem {
  id: number;
  message: string;
  tone: Tone;
  action?: { label: string; onClick: () => void };
  key?: string;
}

/** Never more than this many on screen; the oldest goes first. */
const MAX_VISIBLE = 3;

type ToastFn = (message: string, opts?: ToastOptions) => void;

const ToastContext = createContext<ToastFn | null>(null);

const TONE_RING: Record<Tone, string> = {
  info: "var(--color-line)",
  error: "#ef4444",
  success: "#22c55e",
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(0);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback<ToastFn>(
    (message, opts) => {
      const id = nextId.current++;
      const tone = opts?.tone ?? "info";
      const duration = opts?.duration ?? 3500;
      // C11: a failed action while the account is suspended says why.
      const text = tone === "error" ? withSuspendedReason(message) : message;
      setToasts((prev) => {
        const kept = opts?.key ? prev.filter((t) => t.key !== opts.key) : prev;
        return [...kept, { id, message: text, tone, action: opts?.action, key: opts?.key }].slice(-MAX_VISIBLE);
      });
      if (duration > 0) {
        window.setTimeout(() => dismiss(id), duration);
      }
    },
    [dismiss],
  );

  const value = useMemo(() => toast, [toast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-center gap-2 px-4"
        style={{
          // Above the phone dashboard tab bar when present (globals.css), and
          // above an editor's sticky Save bar while one is open (WC-16).
          paddingBottom: "calc(max(env(safe-area-inset-bottom), var(--ff-bottom-offset, 0px)) + var(--ff-toast-offset, 0px) + 1rem)",
        }}
      >
        {/* RD-21: a toast is a region with sibling buttons, never a button
            inside a button; an error is an alert (assertive). */}
        {toasts.map((t) => (
          <div
            key={t.id}
            data-testid="toast"
            data-tone={t.tone}
            role={t.tone === "error" ? "alert" : undefined}
            className="card lift-in pointer-events-auto flex w-full max-w-sm items-center gap-2 rounded-xl py-1.5 pl-4 pr-1.5 text-left text-sm text-ink"
            style={{ boxShadow: `0 0 0 1px ${TONE_RING[t.tone]} inset` }}
          >
            <span className="min-w-0 flex-1 break-words py-1.5">{t.message}</span>
            {t.action ? (
              <button
                type="button"
                onClick={() => {
                  t.action?.onClick();
                  dismiss(t.id);
                }}
                className="min-h-9 shrink-0 rounded-md border border-line px-2.5 text-xs font-semibold text-ink transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
              >
                {t.action.label}
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss"
              className="grid h-9 w-9 shrink-0 place-items-center rounded-md text-muted hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
            >
              <span aria-hidden="true">×</span>
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastFn {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast must be used within a ToastProvider");
  }
  return ctx;
}
