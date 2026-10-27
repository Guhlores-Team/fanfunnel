"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useToast } from "@/components/ui/Toast";
import { P, Glyph, SectionTitle, raised, recessed, btnGhost, pill } from "./adminUi";

// Admin › Errors: grouped, redacted errors from error monitoring (app_errors).
// Rendered inside the Admin section, which only exists behind the server-side
// is_admin() gate; /api/admin/errors re-checks is_admin() and RLS checks again.

type Env = "production" | "preview" | "development";
type Status = "open" | "resolved";

interface AppError {
  id: string;
  environment: Env;
  source: "client" | "server";
  route: string | null;
  message: string;
  stack: string | null;
  userAgent: string | null;
  count: number;
  firstSeen: string;
  lastSeen: string;
  resolved: boolean;
  resolvedAt: string | null;
}

const ENVS: [Env | "", string][] = [
  ["", "All environments"],
  ["production", "Production"],
  ["preview", "Preview"],
  ["development", "Development"],
];

const ENV_PILL: Record<Env, string> = {
  production: "bg-[#ef4444]/15 text-[#fca5a5]",
  preview: "bg-[#f59e0b]/15 text-[#fcd34d]",
  development: "bg-[color-mix(in_oklab,var(--color-ink)_8%,transparent)] text-muted",
};

function ago(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function fullTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export default function AdminErrors() {
  const [status, setStatus] = useState<Status>("open");
  const [env, setEnv] = useState<Env | "">("");
  const [errors, setErrors] = useState<AppError[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [now, setNow] = useState(() => Date.now());
  const sectionRef = useRef<HTMLElement>(null);
  const statusRef = useRef<HTMLButtonElement>(null);
  const scrolled = useRef(false);
  const envId = useId();
  const toast = useToast();

  const load = useCallback(async () => {
    const qs = new URLSearchParams({ status, ...(env ? { env } : {}) });
    const res = await fetch(`/api/admin/errors?${qs}`, { cache: "no-store" }).catch(() => null);
    const next: AppError[] | null = res?.ok
      ? await res
          .json()
          .then((d: { errors?: AppError[] }) => d.errors ?? [])
          .catch(() => null)
      : null;
    setFailed(next === null);
    setErrors(next ?? []);
    setNow(Date.now());
  }, [status, env]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async fetch; state is only set once the response arrives
    void load();
  }, [load]);

  // The alert e-mail links to /dashboard?section=admin#errors.
  useEffect(() => {
    if (errors === null || scrolled.current) return;
    scrolled.current = true;
    if (window.location.hash === "#errors") sectionRef.current?.scrollIntoView({ block: "start" });
  }, [errors]);

  async function setResolved(item: AppError, resolved: boolean) {
    if (busy.has(item.id)) return;
    const snapshot = errors;
    setBusy((s) => new Set(s).add(item.id));
    // It leaves the current (open/resolved) list either way.
    setErrors((list) => (list ? list.filter((e) => e.id !== item.id) : list));
    try {
      const res = await fetch("/api/admin/errors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: item.id, resolved }),
      });
      if (!res.ok) throw new Error();
      toast(resolved ? "Marked resolved" : "Reopened", { tone: "success" });
      statusRef.current?.focus();
    } catch {
      setErrors(snapshot);
      toast("Couldn't update the error — try again.", { tone: "error" });
    } finally {
      setBusy((s) => {
        const next = new Set(s);
        next.delete(item.id);
        return next;
      });
    }
  }

  const list = errors ?? [];
  return (
    <section
      ref={sectionRef}
      id="errors"
      aria-labelledby="admin-errors"
      className={`lift-in scroll-mt-20 overflow-hidden rounded-2xl ${raised}`}
    >
      <SectionTitle
        id="admin-errors"
        extra={
          <span className="flex items-center gap-3">
            {errors !== null && (
              <span className="tnum text-xs text-muted">
                {list.length} {status === "open" ? "open" : "resolved"}
              </span>
            )}
            <button type="button" onClick={() => void load()} className={btnGhost}>
              <Glyph d={P.refresh} size={14} />
              Refresh
            </button>
          </span>
        }
      >
        Errors
      </SectionTitle>

      <div className="flex flex-wrap items-end gap-3 border-b border-[#1f1b27] px-4 py-3 sm:px-[18px]">
        <div role="group" aria-label="Show" className={`inline-flex rounded-[10px] p-[3px] ${recessed}`}>
          {(["open", "resolved"] as const).map((s) => (
            <button
              key={s}
              ref={s === "open" ? statusRef : undefined}
              type="button"
              aria-pressed={status === s}
              onClick={() => setStatus(s)}
              className={`min-h-8 rounded-[8px] px-3 text-xs font-semibold transition-colors ${
                status === s
                  ? "bg-[color-mix(in_oklab,var(--brand)_18%,transparent)] text-ink ring-1 ring-[color-mix(in_oklab,var(--brand)_40%,transparent)]"
                  : "text-muted hover:text-ink"
              }`}
            >
              {s === "open" ? "Open" : "Resolved"}
            </button>
          ))}
        </div>
        <label htmlFor={envId} className="flex min-w-0 flex-col gap-1.5">
          <span className="text-[10px] font-semibold uppercase tracking-[0.05em] text-muted">Environment</span>
          <select
            id={envId}
            className="ff-input min-w-40 text-xs"
            value={env}
            onChange={(e) => setEnv(e.target.value as Env | "")}
          >
            {ENVS.map(([v, label]) => (
              <option key={v || "all"} value={v}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {errors === null ? (
        <div className="flex flex-col gap-px" aria-busy="true" aria-label="Loading errors">
          {[0, 1].map((i) => (
            <div key={i} className="skeleton h-[72px] border-b border-[#1f1b27] last:border-b-0" />
          ))}
        </div>
      ) : failed ? (
        <p role="alert" className="px-[18px] py-8 text-center text-[13.5px] text-muted">
          Couldn&rsquo;t load errors.{" "}
          <button type="button" onClick={() => void load()} className="font-semibold text-ink underline">
            Try again
          </button>
        </p>
      ) : list.length === 0 ? (
        <p className="px-[18px] py-8 text-center text-[13.5px] text-muted">
          {status === "open" ? "No open errors." : "No resolved errors."}
        </p>
      ) : (
        <ul aria-label={status === "open" ? "Open errors" : "Resolved errors"}>
          {list.map((e) => (
            <ErrorRow
              key={e.id}
              item={e}
              now={now}
              busy={busy.has(e.id)}
              onToggle={() => void setResolved(e, !e.resolved)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function ErrorRow({
  item,
  now,
  busy,
  onToggle,
}: {
  item: AppError;
  now: number;
  busy: boolean;
  onToggle: () => void;
}) {
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const short = item.message.length > 60 ? item.message.slice(0, 59) + "…" : item.message;
  return (
    <li className="border-b border-[#1f1b27] last:border-b-0" data-testid="app-error">
      <div className="flex flex-col gap-2.5 px-4 py-3.5 sm:px-[18px]">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
          <span className={`${pill} ${ENV_PILL[item.environment] ?? ENV_PILL.development}`}>{item.environment}</span>
          <span className={`${pill} bg-[color-mix(in_oklab,var(--color-ink)_8%,transparent)] text-muted`}>
            {item.source === "server" ? "Server" : "Browser"}
          </span>
          <span className="tnum text-xs text-muted">
            <span className="font-semibold text-ink">{item.count.toLocaleString()}</span>{" "}
            {item.count === 1 ? "time" : "times"}
          </span>
          <span className="tnum text-xs text-muted">
            · last{" "}
            <time dateTime={item.lastSeen} title={fullTime(item.lastSeen)}>
              {ago(item.lastSeen, now)}
            </time>
          </span>
        </p>
        <p className="break-words text-[14px] font-semibold leading-snug text-ink">{item.message}</p>
        {item.route && <p className="break-all font-mono text-xs text-muted">{item.route}</p>}
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            aria-controls={detailsId}
            className={btnGhost}
          >
            <Glyph d={P.chevron} size={14} className={`transition-transform ${open ? "rotate-180" : ""}`} />
            Details
          </button>
          <button
            type="button"
            onClick={onToggle}
            disabled={busy}
            aria-label={`${item.resolved ? "Reopen" : "Resolve"}: ${short}`}
            className={
              item.resolved ? btnGhost : `${btnGhost} border-[#10b981]/40 text-[#6ee7b7] hover:text-[#a7f3d0]`
            }
          >
            <Glyph d={item.resolved ? P.undo : P.check} size={14} />
            {item.resolved ? "Reopen" : "Resolve"}
          </button>
        </div>
      </div>
      <div id={detailsId} hidden={!open} className="px-4 pb-4 sm:px-[18px]">
        <div className={`flex flex-col gap-3 rounded-[13px] p-4 ${recessed}`}>
          <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-xs sm:grid-cols-2">
            <div>
              <dt className="text-[10px] font-semibold uppercase tracking-[0.05em] text-muted">First seen</dt>
              <dd className="tnum mt-0.5 text-ink">{fullTime(item.firstSeen)}</dd>
            </div>
            <div>
              <dt className="text-[10px] font-semibold uppercase tracking-[0.05em] text-muted">Last seen</dt>
              <dd className="tnum mt-0.5 text-ink">{fullTime(item.lastSeen)}</dd>
            </div>
            {item.userAgent && (
              <div className="sm:col-span-2">
                <dt className="text-[10px] font-semibold uppercase tracking-[0.05em] text-muted">Browser</dt>
                <dd className="mt-0.5 break-words text-ink">{item.userAgent}</dd>
              </div>
            )}
          </dl>
          {item.stack ? (
            <pre
              tabIndex={0}
              aria-label="Stack trace (redacted)"
              className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-base/60 p-3 font-mono text-[11px] leading-relaxed text-muted"
            >
              {item.stack}
            </pre>
          ) : (
            <p className="text-xs text-muted">No stack trace was captured.</p>
          )}
        </div>
      </div>
    </li>
  );
}
