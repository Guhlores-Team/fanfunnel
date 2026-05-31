"use client";

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

export { EmptyState, Field };
