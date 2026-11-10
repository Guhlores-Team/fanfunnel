"use client";

import { useCallback, useEffect, useId, useState } from "react";
import { useBuildCommit } from "./buildCommit";
import { ACCOUNT_CLEANUP_PENDING_MESSAGE, deletionResponseState } from "@/lib/privacy/deletionResult";
import { FEATURES } from "@/lib/features";
import { REJECTION_REASONS, type RejectionReason } from "@/lib/onboarding/rejectionReasons";
import { useToast } from "@/components/ui/Toast";
import type { AdminAccount, AdminOverview, AppRole } from "@/lib/data/types";
import Modal from "@/components/ui/Modal";
import { accountErrorMessage, deleteErrorMessage, inviteErrorMessage, mfaResetErrorMessage } from "./adminErrors";
import { P, Glyph, SectionTitle, raised, recessed, btnGhost, btnDanger, pill } from "./adminUi";
import AdminErrors from "./AdminErrors";
import SystemHealthCard from "./SystemHealthCard";
import StuckDeletions from "./StuckDeletions";
import RemoveCreatorPhotosButton from "./RemoveCreatorPhotosButton";
import AdminActivity from "./AdminActivity";
import AdminLookup from "./AdminLookup";
import LoadFailed from "@/components/dashboard/LoadFailed";
import { LoadError, loadFailureKind } from "@/lib/hooks/loadJson";
import AdminReports from "./AdminReports";
import AdminAgencies from "./AdminAgencies";
import { ADMIN_ACCOUNTS_PAGE, filterAccounts, pendingAgeLabel, pendingAgeOverdue, requestAgeLabel, requestOverdue } from "./pendingAge";
import { useNow } from "@/lib/hooks/useNow";

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

/**
 * The "Account › Admin" section of the dashboard shell. The shell renders it
 * only when the server resolved the viewer as an active admin (`is_admin()` via
 * checkAdmin in dashboard/page.tsx); every /api/admin route re-checks with
 * requireAdminRoute, so a 401/403 here still shows "Admins only".
 */
export default function AdminClient() {
  const commit = useBuildCommit();
  const [data, setData] = useState<AdminOverview | null>(null);
  // WG-18: search and "Show more" over the loaded accounts; `pinned` keeps an
  // account another card jumps to (Agencies › Suspend owner) in the list.
  const [accountQuery, setAccountQuery] = useState("");
  const [accountsShown, setAccountsShown] = useState(ADMIN_ACCOUNTS_PAGE);
  const [pinnedAccount, setPinnedAccount] = useState<string | null>(null);
  // Agencies › "Suspend owner" jumps to that account's row once it is rendered.
  useEffect(() => {
    if (!pinnedAccount || !data) return;
    const el = document.getElementById(`admin-account-${pinnedAccount}`);
    el?.scrollIntoView({ block: "center" });
    el?.querySelector<HTMLButtonElement>("button[data-suspend]")?.focus();
  }, [pinnedAccount, data]);
  const [loading, setLoading] = useState(true);
  // "mfa": an admin whose session hasn't done two-factor (the server said
  // mfa_required); "other": not an active admin / signed out.
  const [forbidden, setForbidden] = useState<false | "mfa" | "other">(false);
  const [showInvite, setShowInvite] = useState(false);
  const [apps, setApps] = useState<PendingApp[]>([]);
  const [appsDemo, setAppsDemo] = useState(false);
  // In-flight ids so action buttons disable while their request is pending
  // (no double-submits / racing optimistic updates).
  const [busyApps, setBusyApps] = useState<Set<string>>(new Set());
  const [busyAccounts, setBusyAccounts] = useState<Set<string>>(new Set());
  const toast = useToast();

  // RD-03: a failed read (500 / 429 / network) is a failed read with Retry,
  // never "No creator accounts yet.".
  const [loadError, setLoadError] = useState<unknown>(null);
  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/admin", { cache: "no-store" });
      // 401 = session expired while the panel was open; 403 = not an active admin.
      if (res.status === 401 || res.status === 403) {
        const body = await res.json().catch(() => null);
        setForbidden(body?.error === "mfa_required" ? "mfa" : "other");
        return;
      }
      if (!res.ok) throw new LoadError(loadFailureKind(res.status), res.status);
      setData(await res.json());
      setLoadError(null);
      const ar = await fetch("/api/admin/applications", { cache: "no-store" });
      if (!ar.ok) throw new LoadError(loadFailureKind(ar.status), ar.status);
      const body = (await ar.json()) as { applications?: PendingApp[]; demo?: boolean };
      setApps(body.applications ?? []);
      setAppsDemo(body.demo === true);
    } catch (e) {
      setLoadError(e instanceof LoadError ? e : new LoadError("network"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async fetch; state changes only after the response arrives
    void refresh();
  }, [refresh]);

  // Approve (also the undo of a reject, C7) or reject with an optional reason.
  async function decideApp(profileId: string, decision: "approved" | "rejected", reason?: RejectionReason | null) {
    if (busyApps.has(profileId)) return false;
    const snapshot = apps;
    setBusyApps((s) => new Set(s).add(profileId));
    setApps((list) => list.map((a) => (a.profileId === profileId ? { ...a, status: decision } : a)));
    try {
      const res = await fetch("/api/admin/applications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profileId, decision, ...(reason ? { reason } : {}) }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(typeof body?.error === "string" ? body.error : "unknown");
      }
      toast(decision === "approved" ? "Approved. They can sign in to their dashboard now." : "Request rejected. You can still approve it under Rejected.", {
        tone: "success",
      });
      refresh();
      return true;
    } catch (error) {
      // Restore the row on a transient failure so a real pending request can't
      // silently vanish from the admin UI until a full reload.
      setApps(snapshot);
      toast(
        error instanceof Error && error.message === "already_approved"
          ? "That account is already approved. Suspend it instead if you need to stop it."
          : "Couldn't update the request — try again.",
        { tone: "error" }
      );
      return false;
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
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(typeof body?.error === "string" ? body.error : "unknown");
      }
      refresh();
    } catch (error) {
      setData(snapshot);
      toast(accountErrorMessage(error instanceof Error ? error.message : null), { tone: "error" });
    } finally {
      setBusyAccounts((s) => {
        const next = new Set(s);
        next.delete(id);
        return next;
      });
    }
  }

  // Remove every two-factor app from an account (lost phone). The server
  // re-checks admin + aal2, refuses the caller's own account, and logs it.
  async function resetTwoFactor(id: string) {
    const res = await fetch("/api/admin/account/mfa-reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    if (res.ok) {
      const d = await res.json().catch(() => ({}));
      toast(
        d.removed ? "Two-factor reset. They'll set it up again at next sign-in." : "No two-factor apps to remove.",
        { tone: "success" }
      );
      return true;
    }
    const err = (await res.json().catch(() => null))?.error as string | undefined;
    toast(mfaResetErrorMessage(err), { tone: "error" });
    return false;
  }

  // Irreversible hard-delete. The server re-verifies admin, the typed email,
  // self-delete and last-admin guards; we only echo the email it confirmed.
  async function deleteAccount(id: string, email: string) {
    const res = await fetch("/api/admin/account/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, email }),
    });
    const d = await res.json().catch(() => ({}));
    const state = deletionResponseState(res.status, d);
    if (state === "pending") {
      toast(ACCOUNT_CLEANUP_PENDING_MESSAGE, { tone: "error" });
      void refresh();
      return false;
    }
    if (state === "complete") {
      setData((d) =>
        d ? { ...d, accounts: d.accounts.filter((a) => a.id !== id) } : d
      );
      toast("Account permanently deleted", { tone: "success" });
      return true;
    }
    const err = d.error as string | undefined;
    toast(deleteErrorMessage(err), { tone: "error" });
    return false;
  }

  if (forbidden === "mfa") {
    return (
      <div className={`mx-auto max-w-md rounded-2xl px-6 py-8 text-center ${raised}`} role="alert">
        <span className="mx-auto grid h-12 w-12 place-items-center rounded-[13px] bg-[#f59e0b]/15 text-[#fcd34d]">
          <Glyph d={P.shield} size={22} />
        </span>
        <h2 className="mt-4 text-xl font-bold tracking-[-0.02em] text-ink">Two-factor needed</h2>
        <p className="mt-2 text-[13.5px] text-muted">
          Admin tools need a two-factor sign-in. Set it up, or enter your code, to continue.
        </p>
        <a
          href={"/mfa?reason=admin&next=" + encodeURIComponent("/dashboard?section=admin")}
          className="btn-brand mt-5 inline-flex min-h-10 items-center justify-center rounded-[10px] px-[18px] text-sm font-bold"
        >
          Continue to two-factor
        </a>
      </div>
    );
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
  const rejected = apps.filter((a) => a.status === "rejected");
  const accounts = data?.accounts ?? [];
  const matchingAccounts = filterAccounts(accounts, accountQuery);
  const pinned = pinnedAccount ? accounts.find((a) => a.id === pinnedAccount) : undefined;
  const pageOfAccounts = matchingAccounts.slice(0, accountsShown);
  const visibleAccounts = pinned && !pageOfAccounts.includes(pinned) ? [pinned, ...pageOfAccounts] : pageOfAccounts;

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
                {loading || (loadError != null && !data) ? <span className="text-muted">—</span> : t.value.toLocaleString()}
              </dd>
              <dt className="mt-1.5 text-[11px] uppercase tracking-[0.04em] text-muted">{t.label}</dt>
            </div>
          ))}
        </dl>

        {appsDemo && (
          <p data-testid="admin-requests-demo" className="text-[13px] text-muted">
            Demo only: access requests come from real sign-ups on a connected database, so the demo has none to review.
          </p>
        )}

        {(pending.length > 0 || rejected.length > 0) && (
          <AccessRequests
            pending={pending}
            rejected={rejected}
            busyApps={busyApps}
            onDecide={decideApp}
          />
        )}

        <AdminReports />

        <section aria-labelledby="admin-accounts" className={`lift-in overflow-hidden rounded-2xl ${raised}`}>
          <SectionTitle
            id="admin-accounts"
            extra={
              <span className="flex items-center gap-3">
                {!loading && loadError == null && (
                  <span className="tnum text-xs text-muted" data-testid="admin-accounts-count">
                    {accountQuery.trim() ? `${matchingAccounts.length} of ${accounts.length}` : `${accounts.length} total`}
                  </span>
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
          ) : loadError != null ? (
            <div className="px-[18px] py-6">
              <LoadFailed error={loadError} what="the creator accounts" onRetry={refresh} testId="admin-load-failed" />
            </div>
          ) : accounts.length === 0 ? (
            <p className="px-[18px] py-8 text-center text-[13.5px] text-muted">No creator accounts yet.</p>
          ) : (
            <>
              <div className="border-b border-[#1f1b27] px-[18px] py-3">
                <label className="block text-xs text-muted">
                  Search accounts
                  <input
                    type="search"
                    value={accountQuery}
                    onChange={(e) => { setAccountQuery(e.target.value); setAccountsShown(ADMIN_ACCOUNTS_PAGE); }}
                    placeholder="Name or e-mail"
                    data-testid="admin-accounts-search"
                    className="ff-input mt-1 w-full sm:max-w-sm"
                  />
                </label>
              </div>
              {matchingAccounts.length === 0 && !pinned ? (
                <p className="px-[18px] py-8 text-center text-[13.5px] text-muted" data-testid="admin-accounts-none">No account matches that search.</p>
              ) : (
                <ul>
                  {visibleAccounts.map((a) => (
                    <AccountRow
                      key={a.id}
                      account={a}
                      onPatch={patchAccount}
                      onDelete={deleteAccount}
                      onResetTwoFactor={resetTwoFactor}
                      busy={busyAccounts.has(a.id)}
                    />
                  ))}
                </ul>
              )}
              {matchingAccounts.length > accountsShown && (
                <div className="flex items-center justify-center gap-3 border-t border-[#1f1b27] px-[18px] py-3">
                  <span className="tnum text-xs text-muted">Showing {Math.min(accountsShown, matchingAccounts.length)} of {matchingAccounts.length}</span>
                  <button type="button" data-testid="admin-accounts-more" onClick={() => setAccountsShown((n) => n + ADMIN_ACCOUNTS_PAGE)} className={`${btnGhost} min-h-9 px-3 text-[13px]`}>
                    Show {Math.min(ADMIN_ACCOUNTS_PAGE, matchingAccounts.length - accountsShown)} more
                  </button>
                </div>
              )}
            </>
          )}
        </section>

        <AdminAgencies onSuspendOwner={(id) => setPinnedAccount(id)} />
        <SystemHealthCard commit={commit} />
        <AdminLookup />
        <StuckDeletions />
        <AdminErrors />
        <AdminActivity />
      </div>

      {showInvite && (
        <InviteModal
          onClose={() => setShowInvite(false)}
          onCreated={(email) => {
            setShowInvite(false);
            toast(`Invite sent to ${email}. They'll set their own password from the e-mail.`, { tone: "success" });
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
  onResetTwoFactor,
  busy,
}: {
  account: AdminAccount;
  onPatch: (
    id: string,
    patch: Partial<Pick<AdminAccount, "role" | "isActive" | "features">>
  ) => void;
  onDelete: (id: string, email: string) => Promise<boolean>;
  onResetTwoFactor: (id: string) => Promise<boolean>;
  busy: boolean;
}) {
  const [confirmingReset, setConfirmingReset] = useState(false);
  // C11: suspending and making someone an admin each ask first.
  const [confirming, setConfirming] = useState<null | "suspend" | "admin" | "reactivate" | "demote">(null);
  const confirmId = useId();
  const [resetting, setResetting] = useState(false);
  const [open, setOpen] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // WG-04: what deleting an agency owner ends (read when the confirm opens).
  const [agencyImpact, setAgencyImpact] = useState<{ name: string; seats: number; creators: number } | null>(null);
  useEffect(() => {
    if (!confirmingDelete) return;
    let live = true;
    fetch("/api/admin/agencies", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { agencies?: { name: string; owner: { id: string } | null; seats: unknown[]; creators: unknown[] }[] } | null) => {
        if (!live) return;
        const own = d?.agencies?.find((a) => a.owner?.id === account.id) ?? null;
        setAgencyImpact(own ? { name: own.name, seats: own.seats.length, creators: own.creators.length } : null);
      })
      .catch(() => {});
    return () => { live = false; };
  }, [confirmingDelete, account.id]);
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

  // T4: how long the oldest owed prize has waited (blank until hydrated).
  const now = useNow(60_000);
  const pendingAge = account.pending > 0 ? pendingAgeLabel(account.oldestPendingAt, now) : null;
  const pendingOverdue = account.pending > 0 && pendingAgeOverdue(account.oldestPendingAt, now);
  const stats: [string, string, string, number][] = [
    [P.wheel, "wheel", "wheels", account.wheels],
    [P.users, "fan", "fans", account.fans],
    [P.target, "spin", "spins", account.spins],
    [P.gift, "pending", "pending", account.pending],
  ];

  return (
    <li
      id={`admin-account-${account.id}`}
      className={`border-b border-[#1f1b27] last:border-b-0 ${
        account.isActive ? "" : "bg-[color-mix(in_oklab,#ef4444_4%,transparent)]"
      }`}
    >
      <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2.5 px-4 py-3.5 sm:px-[18px]">
        <span className="grid h-[38px] w-[38px] shrink-0 place-items-center rounded-full bg-[color-mix(in_oklab,var(--brand)_16%,transparent)] text-[13px] font-bold text-ink">
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
            {pendingAge && (
              <span
                data-testid="admin-oldest-pending"
                title="Age of this creator's oldest prize still waiting for delivery"
                className={`tnum inline-flex items-center text-xs ${pendingOverdue ? "font-semibold text-[#fcd34d]" : "text-muted"}`}
              >
                oldest {pendingAge}
              </span>
            )}
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
            onClick={() => setConfirming(account.isActive ? "suspend" : "reactivate")}
            data-suspend=""
            disabled={busy}
            aria-controls={confirmId}
            aria-expanded={confirming === "suspend" || confirming === "reactivate"}
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
            className="grid h-8 w-8 place-items-center rounded-lg border border-line text-muted transition-colors hover:text-ink max-sm:h-11 max-sm:w-11"
          >
            <Glyph d={P.chevron} size={16} className={`transition-transform ${open ? "rotate-180" : ""}`} />
          </button>
        </div>
      </div>

      {confirming && (
        <div id={confirmId} role="group" aria-label={confirming === "suspend" ? `Confirm suspending ${account.displayName}` : confirming === "reactivate" ? `Confirm reactivating ${account.displayName}` : confirming === "demote" ? `Confirm removing admin from ${account.displayName}` : `Confirm making ${account.displayName} an admin`} className="px-4 pb-3.5 sm:px-[18px]">
          <div className="rounded-[11px] border border-[#f59e0b]/35 bg-[#f59e0b]/10 p-3.5 text-xs leading-relaxed text-[#fde68a]">
            {confirming === "suspend" ? (
              <p>
                Suspend <strong className="text-ink">{account.displayName}</strong>? Their games and fan links stop working
                for fans, and they can&rsquo;t change anything, until you reactivate them. They&rsquo;ll see a notice with the
                support address when they sign in. If they run an agency, every seat in it is paused too.
              </p>
            ) : confirming === "reactivate" ? (
              <p>
                Reactivate <strong className="text-ink">{account.displayName}</strong>? Their games and fan links work again
                right away, and any agency seats they hold or own resume.
              </p>
            ) : confirming === "demote" ? (
              <p>
                Remove admin from <strong className="text-ink">{account.displayName}</strong>? They keep their creator
                account but can no longer see or change other accounts, approve requests or read the activity log.
              </p>
            ) : (
              <p>
                Make <strong className="text-ink">{account.displayName}</strong> an admin? Admins see and change every
                account, approve requests and delete accounts. Only do this for someone who runs FanFunnel with you.
              </p>
            )}
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  onPatch(account.id, confirming === "suspend" ? { isActive: false } : confirming === "reactivate" ? { isActive: true } : confirming === "demote" ? { role: "creator" } : { role: "admin" });
                  setConfirming(null);
                }}
                className={confirming === "reactivate" ? `${btnGhost} border-[#10b981]/40 text-[#6ee7b7]` : btnDanger}
              >
                {confirming === "suspend" ? "Yes, suspend" : confirming === "reactivate" ? "Yes, reactivate" : confirming === "demote" ? "Yes, remove admin" : "Yes, make admin"}
              </button>
              <button type="button" onClick={() => setConfirming(null)} className={btnGhost}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

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
                onChange={(e) => {
                  const role = e.target.value as AppRole;
                  // WG-12: both directions change power; both ask first.
                  setConfirming(role === "admin" ? "admin" : "demote");
                }}
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

          <RemoveCreatorPhotosButton accountId={account.id} displayName={account.displayName || account.email} />

          {/* Two-factor reset for a lost authenticator (no recovery codes exist). */}
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
            <span>Lost their authenticator app?</span>
            {confirmingReset ? (
              <>
                <button
                  type="button"
                  disabled={resetting}
                  onClick={async () => {
                    setResetting(true);
                    try {
                      if (await onResetTwoFactor(account.id)) setConfirmingReset(false);
                    } finally {
                      setResetting(false);
                    }
                  }}
                  className={btnDanger}
                  aria-label={`Confirm two-factor reset for ${account.displayName}`}
                >
                  {resetting ? "Resetting…" : "Yes, remove their two-factor"}
                </button>
                <button type="button" disabled={resetting} onClick={() => setConfirmingReset(false)} className={btnGhost}>
                  Cancel
                </button>
              </>
            ) : (
              <button
                type="button"
                disabled={busy}
                onClick={() => setConfirmingReset(true)}
                className={btnGhost}
                aria-label={`Reset two-factor for ${account.displayName}`}
              >
                Reset two-factor
              </button>
            )}
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
                <strong className="text-ink">cannot be undone</strong>.
                {agencyImpact && (
                  <>
                    {" "}They own the agency <strong className="text-ink">{agencyImpact.name}</strong>: deleting them dissolves it, ending{" "}
                    {agencyImpact.seats} {agencyImpact.seats === 1 ? "seat" : "seats"} and the management of {agencyImpact.creators}{" "}
                    {agencyImpact.creators === 1 ? "creator" : "creators"} (they&rsquo;ll be told).
                  </>
                )}{" "}
                Type <strong className="break-all text-ink">{account.email}</strong> to confirm:
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
  onCreated: (email: string) => void;
}) {
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
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
        body: JSON.stringify({ email, displayName }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok) onCreated(email.trim());
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
          We&rsquo;ll e-mail them an invite. They set their own password from the link, and the account is approved
          straight away.
        </p>
        <div className="mt-4 flex flex-col gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-[0.05em] text-muted">Display name (optional)</span>
            <input
              className="ff-input w-full"
              placeholder="How fans know them"
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
            {busy ? "Sending…" : "Send invite"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Access requests (C7): Waiting / Rejected, a confirm with an optional
 *  reason before a reject, and Approve on a rejected request as the undo. */
function AccessRequests({
  pending,
  rejected,
  busyApps,
  onDecide,
}: {
  pending: PendingApp[];
  rejected: PendingApp[];
  busyApps: Set<string>;
  onDecide: (profileId: string, decision: "approved" | "rejected", reason?: RejectionReason | null) => Promise<boolean>;
}) {
  const [view, setView] = useState<"pending" | "rejected">("pending");
  const [rejecting, setRejecting] = useState<string | null>(null);
  // WG-12: approving opens an account for fans; it asks first.
  const [approving, setApproving] = useState<string | null>(null);
  const [reason, setReason] = useState<RejectionReason | "">("");
  const now = useNow(60_000);
  const list = view === "pending" ? pending : rejected;
  const tab = (v: "pending" | "rejected", label: string, n: number) => (
    <button
      type="button"
      onClick={() => setView(v)}
      aria-pressed={view === v}
      className={`inline-flex min-h-8 items-center gap-1.5 rounded-full px-3 text-xs font-semibold transition-colors ${
        view === v
          ? "bg-[color-mix(in_oklab,var(--brand)_18%,transparent)] text-ink ring-1 ring-[color-mix(in_oklab,var(--brand)_40%,transparent)]"
          : "text-muted hover:text-ink"
      }`}
    >
      {label} <span className="tnum">{n}</span>
    </button>
  );

  return (
    <section aria-labelledby="admin-requests" className={`lift-in overflow-hidden rounded-2xl ${raised}`}>
      <SectionTitle
        id="admin-requests"
        extra={
          <span className="flex items-center gap-1" role="group" aria-label="Show requests">
            {tab("pending", "Waiting", pending.length)}
            {tab("rejected", "Rejected", rejected.length)}
          </span>
        }
      >
        Access requests
        {pending.length > 0 && (
          <span className="tnum grid h-[19px] min-w-[19px] place-items-center rounded-full bg-[var(--brand)] px-[5px] text-[11px] font-bold text-[var(--brand-ink)]">
            {pending.length}
          </span>
        )}
      </SectionTitle>
      {list.length === 0 ? (
        <p className="px-[18px] py-6 text-center text-[13px] text-muted">
          {view === "pending" ? "No requests waiting." : "No rejected requests."}
        </p>
      ) : (
        <ul className="flex flex-col gap-2.5 p-3 sm:p-4">
          {list.map((a) => {
            const busy = busyApps.has(a.profileId);
            const name = a.displayName ?? a.email ?? "Creator";
            const confirmingReject = rejecting === a.profileId;
            return (
              <li key={a.id} className={`flex flex-col gap-3 rounded-[13px] px-4 py-3.5 ${recessed}`}>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="flex min-w-0 flex-1 items-start gap-3">
                    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[color-mix(in_oklab,var(--brand)_16%,transparent)] text-xs font-bold text-ink">
                      {initialsOf(a.displayName ?? "", a.email ?? "")}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[14px] font-semibold text-ink">{name}</p>
                      {a.email && <p className="truncate text-[12.5px] text-muted">{a.email}</p>}
                      <p className="mt-1 text-xs text-muted" data-testid="request-age" data-overdue={view === "pending" && requestOverdue(a.createdAt, now) ? "true" : "false"}>
                        Asked {new Date(a.createdAt).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}
                        {requestAgeLabel(a.createdAt, now) && <> · {requestAgeLabel(a.createdAt, now)}</>}
                        {view === "pending" && requestOverdue(a.createdAt, now) && <span className="ml-1.5 rounded-full border border-amber-300/40 px-1.5 py-[1px] font-semibold text-amber-200">Waiting over a week</span>}
                      </p>
                      {a.audienceSize && <p className="mt-1 text-xs text-muted">Audience: {a.audienceSize}</p>}
                      {a.socials && <p className="mt-1 break-words text-xs text-muted">Links: {a.socials}</p>}
                      {a.note && <p className="mt-1 whitespace-pre-line text-xs text-[#8b8494]">“{a.note}”</p>}
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-2 pl-12 sm:pl-0">
                    <button
                      type="button"
                      onClick={() => { setApproving(a.profileId); setRejecting(null); }}
                      disabled={busy}
                      aria-expanded={approving === a.profileId}
                      className="btn-brand inline-flex min-h-9 items-center gap-1.5 rounded-lg px-3 text-xs font-bold"
                    >
                      <Glyph d={P.check} size={14} />
                      {view === "rejected" ? "Approve instead" : "Approve"}
                    </button>
                    {view === "pending" && (
                      <button
                        type="button"
                        onClick={() => {
                          setRejecting(a.profileId);
                          setReason("");
                        }}
                        disabled={busy}
                        aria-expanded={confirmingReject}
                        className={btnGhost}
                      >
                        <Glyph d={P.x} size={14} />
                        Reject
                      </button>
                    )}
                  </div>
                </div>
                {approving === a.profileId && (
                  <div data-testid="confirm-approve" className="rounded-[11px] border border-[#10b981]/35 bg-[#10b981]/10 p-3.5" role="group" aria-label={`Confirm approving ${name}`}>
                    <p className="text-xs leading-relaxed text-[#a7f3d0]">
                      Approve <strong className="text-ink">{name}</strong>? Their dashboard opens, they can create games and mint fan
                      links right away, and they get an approval notice{a.email ? " and e-mail" : ""}.
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={async () => {
                          if (await onDecide(a.profileId, "approved")) setApproving(null);
                        }}
                        className="btn-brand inline-flex min-h-9 items-center gap-1.5 rounded-lg px-3 text-xs font-bold"
                      >
                        Yes, approve
                      </button>
                      <button type="button" onClick={() => setApproving(null)} className={btnGhost}>
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
                {confirmingReject && (
                  <div className="rounded-[11px] border border-[#ef4444]/35 bg-[#ef4444]/10 p-3.5" role="group" aria-label={`Confirm rejecting ${name}`}>
                    <p className="text-xs leading-relaxed text-[#fecaca]">
                      Reject <strong className="text-ink">{name}</strong>? They&rsquo;ll see &ldquo;not approved&rdquo; when
                      they sign in, with the reason below if you pick one. You can still approve them later under Rejected.
                    </p>
                    <label className="mt-3 flex flex-col gap-1.5">
                      <span className="text-[10px] font-semibold uppercase tracking-[0.05em] text-muted">Reason (optional, shown to them)</span>
                      <select
                        className="ff-input w-full text-xs"
                        value={reason}
                        onChange={(e) => setReason(e.target.value as RejectionReason | "")}
                      >
                        <option value="">No reason</option>
                        {(Object.keys(REJECTION_REASONS) as RejectionReason[]).map((k) => (
                          <option key={k} value={k}>
                            {REJECTION_REASONS[k].label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={async () => {
                          if (await onDecide(a.profileId, "rejected", reason || null)) setRejecting(null);
                        }}
                        className={btnDanger}
                      >
                        Reject request
                      </button>
                      <button type="button" onClick={() => setRejecting(null)} className={btnGhost}>
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
