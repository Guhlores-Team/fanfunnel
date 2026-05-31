"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";

type Tone = "info" | "error" | "success";

interface ToastOptions {
  tone?: Tone;
  duration?: number;
  action?: { label: string; onClick: () => void };
}

interface ToastItem {
  id: number;
  message: string;
  tone: Tone;
  action?: { label: string; onClick: () => void };
}

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
      setToasts((prev) => [
        ...prev,
        { id, message, tone, action: opts?.action },
      ]);
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
          paddingBottom: "calc(env(safe-area-inset-bottom) + 1rem)",
        }}
      >
        {toasts.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => dismiss(t.id)}
            className="card reveal pointer-events-auto flex w-full max-w-sm items-center gap-3 rounded-xl px-4 py-3 text-left text-sm text-ink"
            style={{ boxShadow: `0 0 0 1px ${TONE_RING[t.tone]} inset` }}
          >
            <span className="min-w-0 flex-1 break-words">{t.message}</span>
            {t.action ? (
              <span
                role="button"
                tabIndex={0}
                onClick={(e) => {
                  e.stopPropagation();
                  t.action?.onClick();
                  dismiss(t.id);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    e.stopPropagation();
                    t.action?.onClick();
                    dismiss(t.id);
                  }
                }}
                className="shrink-0 rounded-md border border-line px-2 py-1 text-xs font-semibold text-ink transition-opacity hover:opacity-80"
              >
                {t.action.label}
              </span>
            ) : null}
          </button>
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
