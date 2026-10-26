"use client";

import { useCallback, useEffect, useId, useState } from "react";
import type { ReactNode } from "react";
import { FEATURES } from "@/lib/features";
import { MIN_PASSWORD_LENGTH } from "@/lib/api/password";
import { useToast } from "@/components/ui/Toast";
import type { AdminAccount, AdminOverview, AppRole } from "@/lib/data/types";
import Modal from "@/components/ui/Modal";
import { deleteErrorMessage, inviteErrorMessage } from "./adminErrors";

interface PendingApp {
  id: string;
  profileId: string;
  email: string | null;
  displayName: string | null;
  socials: string | null;
  audienceSize: string | null;
  note: string | null;
  status: "pending" | "approved" | "rejected";
  createdAt: string;
}

// 24×24 stroke paths (Command Center prototype line icons).
const P = {
  shield: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10ZM9.5 12l2 2 3.5-4",
  lock: "M7 11V7a5 5 0 0 1 10 0v4M5 11h14v10H5zM12 15v2",
  plus: "M12 5v14M5 12h14",
  chevron: "m6 9 6 6 6-6",
  users: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM22 21v-2a4 4 0 0 0-3-3.87",
  wheel: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM12 12.5a.5.5 0 1 0 0-1 .5.5 0 0 0 0 1Z",
  target: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z",
  gift: "M20 8v13H4V8M2 4h20v4H2zM12 4v17M12 4S10.5 1 8.3 1.6 6 4 6.5 4.6 9 5 12 4Z",
  inbox: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10Z",
  check: "M20 6 9 17l-5-5",
  x: "M18 6 6 18M6 6l12 12",
  trash: "M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v6M14 11v6",
  alert: "M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z",
};

function Glyph({ d, size = 18, className = "" }: { d: string; size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={`shrink-0 ${className}`}
    >
      <path d={d} />
    </svg>
  );
}

const raised = "border border-[var(--hair)] [background:var(--s1)] shadow-[var(--lift)]";
const recessed = "border border-[var(--hair)] [background:var(--s2)]";
const btnGhost =
  "inline-flex min-h-8 items-center gap-1.5 rounded-lg border border-line px-[11px] text-xs font-semibold text-muted transition-colors hover:border-[color-mix(in_oklab,var(--color-ink)_25%,var(--color-line))] hover:text-ink disabled:cursor-not-allowed disabled:opacity-50";
const btnDanger =
  "inline-flex min-h-8 items-center gap-1.5 rounded-lg border border-[#ef4444]/50 px-[11px] text-xs font-semibold text-[#f87171] transition-colors hover:bg-[#ef4444]/10 disabled:cursor-not-allowed disabled:opacity-50";
const pill = "inline-flex shrink-0 items-center rounded-full px-2.5 py-[3px] text-[11px] font-bold";

function initialsOf(name: string, email: string) {
  const src = name.trim() || email;
  return (
    src
      .replace(/^@/, "")
      .split(/[\s._@-]+/)
      .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ""))
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase())
      .join("") || "?"
  );
}

function SectionTitle({ id, children, extra }: { id: string; children: ReactNode; extra?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#1f1b27] px-4 py-3.5 sm:px-[18px] sm:py-4">
      <h2 id={id} className="flex items-center gap-[9px] text-[15px] font-bold tracking-[-0.01em] text-ink">
        <span aria-hidden="true" className="h-4 w-[3px] rounded-sm bg-[var(--brand)]" />
        {children}
      </h2>
      {extra}
    </div>
  );
}

/**
 * The "Account › Admin" section of the dashboard shell. The shell renders it
 * only when the server resolved the viewer as an active admin (`is_admin()` via
 * checkAdmin in dashboard/page.tsx); every /api/admin route re-checks with
 * requireAdminRoute, so a 401/403 here still shows "Admins only".
 */
export default function AdminClient() {
  const [data, setData] = useState<AdminOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [showInvite, setShowInvite] = useState(false);
  const [apps, setApps] = useState<PendingApp[]>([]);
  // In-flight ids so action buttons disable while their request is pending
  // (no double-submits / racing optimistic updates).
  const [busyApps, setBusyApps] = useState<Set<string>>(new Set());
  const [busyAccounts, setBusyAccounts] = useState<Set<string>>(new Set());
  const toast = useToast();

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/admin", { cache: "no-store" });
      // 401 = session expired while the panel was open; 403 = not an active admin.
      if (res.status === 401 || res.status === 403) {
        setForbidden(true);
        return;
      }
      if (res.ok) setData(await res.json());
      const ar = await fetch("/api/admin/applications", { cache: "no-store" });
      if (ar.ok) setApps((await ar.json()).applications ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function decideApp(profileId: string, decision: "approved" | "rejected") {
    if (busyApps.has(profileId)) return;
    const snapshot = apps;
    setBusyApps((s) => new Set(s).add(profileId));
    setApps((list) => list.filter((a) => a.profileId !== profileId));
    try {
      const res = await fetch("/api/admin/applications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profileId, decision }),
      });
      if (!res.ok) throw new Error();
      refresh();
    } catch {
      // Restore the row on a transient failure so a real pending request can't
      // silently vanish from the admin UI until a full reload.
      setApps(snapshot);
      toast("Couldn't update the request — try again.", { tone: "error" });
    } finally {
      setBusyApps((s) => {
        const next = new Set(s);
        next.delete(profileId);
        return next;
      });
    }
  }

  // Optimistically patch one account in place, then persist; roll back on failure.
  async function patchAccount(
    id: string,
    patch: Partial<Pick<AdminAccount, "role" | "isActive" | "features">>
  ) {
    if (busyAccounts.has(id)) return;
    const snapshot = data;
    setBusyAccounts((s) => new Set(s).add(id));
    setData((d) =>
      d
        ? {
            ...d,
            accounts: d.accounts.map((a) =>
              a.id === id ? { ...a, ...patch, features: { ...a.features, ...(patch.features ?? {}) } } : a
            ),
          }
        : d
    );
    try {
      const res = await fetch("/api/admin/account", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, ...patch }),
      });
      if (!res.ok) throw new Error();
      refresh();
    } catch {
      setData(snapshot);
      toast("Couldn't update the account — try again.", { tone: "error" });
    } finally {
      setBusyAccounts((s) => {
        const next = new Set(s);
        next.delete(id);
        return next;
      });
    }
  }

  // Irreversible hard-delete. The server re-verifies admin, the typed email,
  // self-delete and last-admin guards; we only echo the email it confirmed.
  async function deleteAccount(id: string, email: string) {
    const res = await fetch("/api/admin/account/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, email }),
    });
    if (res.ok) {
      setData((d) =>
        d ? { ...d, accounts: d.accounts.filter((a) => a.id !== id) } : d
      );
      toast("Account permanently deleted", { tone: "success" });
      return true;
    }
    const err = (await res.json().catch(() => null))?.error as string | undefined;
    toast(deleteErrorMessage(err), { tone: "error" });
    return false;
  }

  if (forbidden) {
    return (
      <div className={`mx-auto max-w-md rounded-2xl px-6 py-8 text-center ${raised}`} role="alert">
        <span className="mx-auto grid h-12 w-12 place-items-center rounded-[13px] bg-[#f59e0b]/15 text-[#fcd34d]">
          <Glyph d={P.lock} size={22} />
        </span>
        <h2 className="mt-4 text-xl font-bold tracking-[-0.02em] text-ink">Admins only</h2>
        <p className="mt-2 text-[13.5px] text-muted">
          This area is restricted to active admin accounts. If your session expired, sign in again.
        </p>
      </div>
    );
  }

  const m = data?.metrics;
  const tiles = [
    { label: "Accounts", value: m?.creators ?? 0 },
    { label: "Total fans", value: m?.fans ?? 0 },
    { label: "Total spins", value: m?.spins ?? 0 },
    { label: "Prizes pending", value: m?.pending ?? 0 },
  ];
  const pending = apps.filter((a) => a.status === "pending");
  const accounts = data?.accounts ?? [];

  return (
    <div className="flex flex-col gap-[18px]">
      <p className="flex flex-wrap items-center gap-2 text-[13px] text-muted">
        <span className={`${pill} bg-[#f59e0b]/15 text-[#fcd34d]`}>
          <Glyph d={P.shield} size={11} className="mr-1" />
          cross-account
        </span>
        Everything here spans every creator account. Changes apply immediately.
      </p>

      <div className="flex flex-col gap-[18px]">
        {/* Cross-account stat strip: one framed grid, 1px hairline gutters. */}
        <dl
          aria-label="Cross-account totals"
          className="lift-in grid grid-cols-2 gap-px overflow-hidden rounded-[14px] border border-[#1f1b27] bg-[#1f1b27] sm:grid-cols-4"
        >
          {tiles.map((t) => (
            <div key={t.label} className="bg-base px-[18px] py-4">
              <dd className="tnum m-0 text-[22px] font-bold leading-none tracking-[-0.02em] text-ink">
                {loading ? <span className="text-muted">—</span> : t.value.toLocaleString()}
              </dd>
              <dt className="mt-1.5 text-[11px] uppercase tracking-[0.04em] text-muted">{t.label}</dt>
            </div>
          ))}
        </dl>

        {pending.length > 0 && (
          <section aria-labelledby="admin-requests" className={`lift-in overflow-hidden rounded-2xl ${raised}`}>
            <SectionTitle
              id="admin-requests"
              extra={<span className="tnum text-xs text-muted">{pending.length} waiting</span>}
            >
              Access requests
              <span className="tnum grid h-[19px] min-w-[19px] place-items-center rounded-full bg-[var(--brand)] px-[5px] text-[11px] font-bold text-[var(--brand-ink)]">
                {pending.length}
              </span>
            </SectionTitle>
            <ul className="flex flex-col gap-2.5 p-3 sm:p-4">
              {pending.map((a) => {
                const busy = busyApps.has(a.profileId);
                const name = a.displayName ?? a.email ?? "Creator";
                return (
                  <li
                    key={a.id}
                    className={`flex flex-col gap-3 rounded-[13px] px-4 py-3.5 sm:flex-row sm:items-start sm:justify-between ${recessed}`}
                  >
                    <div className="flex min-w-0 flex-1 items-start gap-3">
                      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[color-mix(in_oklab,var(--brand)_16%,transparent)] text-xs font-bold text-brand">
                        {initialsOf(a.displayName ?? "", a.email ?? "")}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[14px] font-semibold text-ink">{name}</p>
                        {a.email && <p className="truncate text-[12.5px] text-muted">{a.email}</p>}
                        {a.audienceSize && (
                          <p className="mt-1 text-xs text-muted">Audience: {a.audienceSize}</p>
                        )}
                        {a.socials && (
                          <p className="mt-1 break-words text-xs text-muted">Links: {a.socials}</p>
                        )}
                        {a.note && <p className="mt-1 text-xs text-[#8b8494]">“{a.note}”</p>}
                      </div>
                    </div>
                    <div className="flex shrink-0 gap-2 pl-12 sm:pl-0">
                      <button
                        type="button"
                        onClick={() => decideApp(a.profileId, "approved")}
                        disabled={busy}
                        className="btn-brand inline-flex min-h-8 items-center gap-1.5 rounded-lg px-3 text-xs font-bold"
                      >
                        <Glyph d={P.check} size={14} />
                        Approve
                      </button>
                      <button
                        type="button"
                        onClick={() => decideApp(a.profileId, "rejected")}
                        disabled={busy}
                        className={btnGhost}
                      >
                        <Glyph d={P.x} size={14} />
                        Reject
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        <section aria-labelledby="admin-accounts" className={`lift-in overflow-hidden rounded-2xl ${raised}`}>
          <SectionTitle
            id="admin-accounts"
            extra={
              <span className="flex items-center gap-3">
                {!loading && (
                  <span className="tnum text-xs text-muted">{accounts.length} total</span>
                )}
                <button
                  type="button"
                  onClick={() => setShowInvite(true)}
                  className="btn-brand inline-flex min-h-9 items-center gap-1.5 rounded-[9px] px-3.5 text-[13px] font-bold"
                >
                  <Glyph d={P.plus} size={15} />
                  New account
                </button>
              </span>
            }
          >
            Creator accounts
          </SectionTitle>
          {loading ? (
            <div className="flex flex-col gap-px" aria-busy="true" aria-label="Loading accounts">
              {[0, 1, 2].map((i) => (
                <div key={i} className="skeleton h-[66px] border-b border-[#1f1b27] last:border-b-0" />
              ))}
            </div>
          ) : accounts.length === 0 ? (
            <p className="px-[18px] py-8 text-center text-[13.5px] text-muted">No creator accounts yet.</p>
          ) : (
            <ul>
              {accounts.map((a) => (
                <AccountRow
                  key={a.id}
                  account={a}
                  onPatch={patchAccount}
                  onDelete={deleteAccount}
                  busy={busyAccounts.has(a.id)}
                />
              ))}
            </ul>
          )}
        </section>
      </div>

      {showInvite && (
        <InviteModal
          onClose={() => setShowInvite(false)}
          onCreated={() => {
            setShowInvite(false);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function AccountRow({
  account,
  onPatch,
  onDelete,
  busy,
}: {
  account: AdminAccount;
  onPatch: (
    id: string,
    patch: Partial<Pick<AdminAccount, "role" | "isActive" | "features">>
  ) => void;
  onDelete: (id: string, email: string) => Promise<boolean>;
  busy: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [typedEmail, setTypedEmail] = useState("");
  const [deleting, setDeleting] = useState(false);
  const detailsId = useId();
  const deleteId = useId();

  const emailMatches =
    typedEmail.trim().toLowerCase() === account.email.trim().toLowerCase() &&
    account.email.length > 0;

  async function runDelete() {
    setDeleting(true);
    try {
      const ok = await onDelete(account.id, typedEmail.trim());
      if (ok) {
        // Row unmounts on success; reset for safety if it lingers.
        setConfirmingDelete(false);
        setTypedEmail("");
      }
    } finally {
      setDeleting(false);
    }
  }

  const stats: [string, string, string, number][] = [
    [P.wheel, "wheel", "wheels", account.wheels],
    [P.users, "fan", "fans", account.fans],
    [P.target, "spin", "spins", account.spins],
    [P.gift, "pending", "pending", account.pending],
  ];

  return (
    <li
      className={`border-b border-[#1f1b27] last:border-b-0 ${
        account.isActive ? "" : "bg-[color-mix(in_oklab,#ef4444_4%,transparent)]"
      }`}
    >
      <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2.5 px-4 py-3.5 sm:px-[18px]">
        <span className="grid h-[38px] w-[38px] shrink-0 place-items-center rounded-full bg-[color-mix(in_oklab,var(--brand)_16%,transparent)] text-[13px] font-bold text-brand">
          {initialsOf(account.displayName, account.email)}
        </span>
        <div className="min-w-0 flex-1 basis-40">
          <p className="flex min-w-0 items-center gap-2 text-[14px] font-semibold text-ink">
            <span className="truncate">{account.displayName}</span>
            {account.role === "admin" && (
              <span className={`${pill} bg-[#f59e0b]/15 text-[#fcd34d]`}>
                <Glyph d={P.shield} size={11} className="mr-1" />
                ADMIN
              </span>
            )}
          </p>
          <p className="tnum mt-0.5 truncate text-[12.5px] text-muted" title={account.email}>
            {account.email}
          </p>
          {/* Per-account counts at a glance (they were always visible before). */}
          <p className="mt-1 flex flex-wrap gap-x-3.5 gap-y-1">
            {stats.map(([d, one, many, value]) => (
              <span key={many} className="tnum inline-flex items-center gap-1 text-xs text-muted">
                <Glyph d={d} size={13} className="text-[#8b8494]" />
                <span className="font-semibold text-ink">{value.toLocaleString()}</span>{" "}
                {value === 1 ? one : many}
              </span>
            ))}
          </p>
        </div>
        <span
          className={`${pill} ${
            account.isActive
              ? "bg-[#10b981]/15 text-[#6ee7b7]"
              : "bg-[color-mix(in_oklab,var(--color-ink)_8%,transparent)] text-muted"
          }`}
        >
          {account.isActive ? "Active" : "Suspended"}
        </span>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => onPatch(account.id, { isActive: !account.isActive })}
            disabled={busy}
            className={account.isActive ? btnGhost : `${btnGhost} border-[#10b981]/40 text-[#6ee7b7]`}
          >
            {account.isActive ? "Suspend" : "Reactivate"}
          </button>
          <button
            type="button"
            onClick={() => {
              setConfirmingDelete(true);
              setOpen(true);
            }}
            disabled={busy || deleting}
            aria-label={`Delete ${account.displayName}`}
            aria-controls={deleteId}
            aria-expanded={confirmingDelete}
            className={btnDanger}
          >
            Delete
          </button>
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            aria-controls={detailsId}
            aria-label={`${open ? "Hide" : "Show"} role and features for ${account.displayName}`}
            className="grid h-8 w-8 place-items-center rounded-lg border border-line text-muted transition-colors hover:text-ink"
          >
            <Glyph d={P.chevron} size={16} className={`transition-transform ${open ? "rotate-180" : ""}`} />
          </button>
        </div>
      </div>

      {/* Row disclosure (not drawn in the design): the privileged, rarely-changed
          controls — role and feature flags — plus the delete confirm. */}
      <div id={detailsId} hidden={!open} className="px-4 pb-4 sm:px-[18px]">
        <div className={`flex flex-col gap-4 rounded-[13px] p-4 ${recessed}`}>
          <div className="flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-end">
            <label className="flex flex-col gap-1.5 sm:shrink-0">
              <span className="text-[10px] font-semibold uppercase tracking-[0.05em] text-muted">Role</span>
              <select
                className="ff-input min-w-32 text-xs disabled:opacity-50"
                value={account.role}
                disabled={busy}
                onChange={(e) => onPatch(account.id, { role: e.target.value as AppRole })}
              >
                <option value="creator">Creator</option>
                <option value="admin">Admin</option>
              </select>
            </label>

            <fieldset className="flex min-w-0 flex-1 flex-col gap-1.5">
              <legend className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.05em] text-muted">
                Features
              </legend>
              <div className="flex flex-wrap gap-2">
                {FEATURES.map((f) => {
                  const on = f.base || account.features[f.key];
                  return (
                    <button
                      key={f.key}
                      type="button"
                      role="switch"
                      aria-checked={on}
                      disabled={f.base || busy}
                      onClick={() =>
                        onPatch(account.id, {
                          features: { [f.key]: !account.features[f.key] },
                        })
                      }
                      title={
                        f.base
                          ? "Base feature — always on"
                          : f.comingSoon
                            ? "Coming soon — grant early access"
                            : ""
                      }
                      className={`inline-flex min-h-8 items-center gap-1.5 rounded-full px-3 text-xs font-semibold transition-colors ${
                        on
                          ? "bg-[color-mix(in_oklab,var(--brand)_18%,transparent)] text-ink ring-1 ring-[color-mix(in_oklab,var(--brand)_40%,transparent)]"
                          : "bg-[color-mix(in_oklab,var(--color-ink)_6%,transparent)] text-muted hover:text-ink"
                      } ${f.base ? "cursor-default" : "disabled:opacity-50"}`}
                    >
                      {on && <Glyph d={P.check} size={13} className="text-brand" />}
                      {f.label}
                      {f.comingSoon && !on ? " (soon)" : ""}
                    </button>
                  );
                })}
              </div>
            </fieldset>
          </div>

          {/* Danger zone — irreversible hard-delete, kept distinct from Suspend.
              The design shows one click; the typed-email confirm stays. */}
          <div
            id={deleteId}
            hidden={!confirmingDelete}
            className="rounded-[11px] border border-[#ef4444]/35 bg-[#ef4444]/10 p-3.5"
          >
            <div className="flex items-start gap-2.5">
              <Glyph d={P.alert} size={18} className="mt-px text-[#fca5a5]" />
              <p className="text-xs leading-relaxed text-[#fecaca]">
                This permanently deletes <strong className="text-ink">{account.displayName}</strong> and all
                of their wheels, fans, spins, grants, campaigns and messages. This{" "}
                <strong className="text-ink">cannot be undone</strong>. Type{" "}
                <strong className="break-all text-ink">{account.email}</strong> to confirm:
              </p>
            </div>
            <input
              value={typedEmail}
              onChange={(e) => setTypedEmail(e.target.value)}
              placeholder={account.email}
              autoComplete="off"
              aria-label={`Type ${account.email} to confirm deletion`}
              className="ff-input mt-3 w-full text-xs"
            />
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={runDelete}
                disabled={!emailMatches || deleting}
                className="inline-flex min-h-8 w-full items-center justify-center gap-1.5 rounded-lg bg-[#ef4444] px-3 text-xs font-bold text-white transition-colors hover:bg-[#f87171] disabled:cursor-not-allowed disabled:opacity-40 sm:w-auto"
              >
                <Glyph d={P.trash} size={14} />
                {deleting ? "Deleting…" : "Permanently delete this account"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirmingDelete(false);
                  setTypedEmail("");
                }}
                disabled={deleting}
                className={btnGhost}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      </div>
    </li>
  );
}

function InviteModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, displayName }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok) onCreated();
      else setError(inviteErrorMessage(data?.error));
    } catch {
      setError(inviteErrorMessage(undefined));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      onClose={onClose}
      labelledBy={titleId}
      className={`w-full max-w-sm rounded-2xl p-6 text-ink ${raised}`}
    >
      <form onSubmit={submit}>
        <h2 id={titleId} className="flex items-center gap-[9px] text-lg font-bold tracking-[-0.01em]">
          <span aria-hidden="true" className="h-4 w-[3px] rounded-sm bg-[var(--brand)]" />
          New account
        </h2>
        <p className="mt-1 text-[13.5px] text-muted">
          You set their login. Share the credentials with the creator.
        </p>
        <div className="mt-4 flex flex-col gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-[0.05em] text-muted">Display name</span>
            <input
              className="ff-input w-full"
              placeholder="Display name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-[0.05em] text-muted">Email</span>
            <input
              type="email"
              required
              className="ff-input w-full"
              placeholder="creator@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-[0.05em] text-muted">
              Temporary password
            </span>
            <input
              type="password"
              autoComplete="new-password"
              required
              minLength={MIN_PASSWORD_LENGTH}
              className="ff-input w-full"
              placeholder={`${MIN_PASSWORD_LENGTH}+ chars, a letter and a number`}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
        </div>
        {error && (
          <p role="alert" className="mt-3 flex items-start gap-2 text-[13px] text-[#fcd34d]">
            <Glyph d={P.alert} size={16} className="mt-px" />
            {error}
          </p>
        )}
        <div className="mt-5 flex gap-2">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded-[10px] border border-line py-2.5 text-sm font-semibold text-muted transition-colors hover:text-ink"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy}
            className="btn-brand flex-1 rounded-[10px] py-2.5 text-sm font-bold"
          >
            {busy ? "Creating…" : "Create account"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
