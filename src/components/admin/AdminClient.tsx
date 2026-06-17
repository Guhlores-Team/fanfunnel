"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { FEATURES } from "@/lib/features";
import { ToastProvider, useToast } from "@/components/ui/Toast";
import type { AdminAccount, AdminOverview, AppRole } from "@/lib/data/types";

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

// The /admin route renders this directly (no app-wide ToastProvider), so we
// supply one here for the inner panel's success/error toasts.
export default function AdminClient() {
  return (
    <ToastProvider>
      <AdminPanel />
    </ToastProvider>
  );
}

function AdminPanel() {
  const toast = useToast();
  const [data, setData] = useState<AdminOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [showInvite, setShowInvite] = useState(false);
  const [apps, setApps] = useState<PendingApp[]>([]);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/admin", { cache: "no-store" });
      if (res.status === 403) {
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
    const removed = apps.find((a) => a.profileId === profileId);
    setApps((list) => list.filter((a) => a.profileId !== profileId));
    try {
      const res = await fetch("/api/admin/applications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profileId, decision }),
      });
      if (!res.ok) throw new Error("request_failed");
      refresh();
    } catch {
      // Restore the row on a transient failure so a real pending request can't
      // silently vanish from the admin UI until a full reload.
      if (removed) setApps((list) => [removed, ...list]);
    }
  }

  // Optimistically patch one account in place, then persist.
  async function patchAccount(
    id: string,
    patch: Partial<Pick<AdminAccount, "role" | "isActive" | "features">>
  ) {
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
    await fetch("/api/admin/account", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, ...patch }),
    });
    refresh();
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
    const message =
      err === "cannot_delete_self"
        ? "You can't delete your own admin account."
        : err === "last_admin"
          ? "Can't delete the last remaining admin."
          : err === "email_mismatch"
            ? "Email didn't match — deletion cancelled."
            : err === "unauthorized"
              ? "Admins only."
              : "Couldn't delete account. Try again.";
    toast(message, { tone: "error" });
    return false;
  }

  if (forbidden) {
    return (
      <div className="mx-auto max-w-md px-5 py-24 text-center text-white">
        <p className="text-5xl">🔒</p>
        <h1 className="mt-4 text-xl font-bold">Admins only</h1>
        <p className="mt-2 text-sm text-white/50">
          This area is restricted to admin accounts.
        </p>
        <Link
          href="/dashboard"
          className="mt-6 inline-block rounded-xl bg-pink-500 px-5 py-2.5 font-bold"
        >
          Back to dashboard
        </Link>
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

  return (
    <div className="mx-auto max-w-6xl px-5 py-8 text-white">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-extrabold">
            Admin Panel{" "}
            <span className="rounded-full bg-amber-400/15 px-2 py-0.5 align-middle text-xs font-bold text-amber-300">
              cross-account
            </span>
          </h1>
          <p className="text-sm text-white/50">
            Manage every creator account, features and access.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/dashboard"
            className="rounded-lg border border-white/15 px-3 py-1.5 text-xs font-semibold text-white/70 hover:bg-white/5"
          >
            ← My dashboard
          </Link>
          <button
            onClick={() => setShowInvite(true)}
            className="rounded-lg bg-pink-500 px-4 py-1.5 text-xs font-bold hover:bg-pink-400"
          >
            + New creator
          </button>
        </div>
      </header>

      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {tiles.map((t) => (
          <div
            key={t.label}
            className="rounded-2xl border border-white/10 bg-white/5 p-5"
          >
            <p className="text-3xl font-extrabold text-pink-300">
              {loading ? "—" : t.value}
            </p>
            <p className="mt-1 text-sm text-white/50">{t.label}</p>
          </div>
        ))}
      </div>

      {(() => {
        const pending = apps.filter((a) => a.status === "pending");
        if (pending.length === 0) return null;
        return (
          <section className="mt-8">
            <h2 className="flex items-center gap-2 text-lg font-bold">
              Access requests
              <span className="rounded-full bg-pink-500 px-2 py-0.5 text-xs font-bold">
                {pending.length}
              </span>
            </h2>
            <div className="mt-3 space-y-3">
              {pending.map((a) => (
                <div
                  key={a.id}
                  className="rounded-2xl border border-pink-400/30 bg-pink-500/5 p-4"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-bold">{a.displayName ?? a.email ?? "Creator"}</p>
                      <p className="text-xs text-white/50">{a.email}</p>
                      {a.audienceSize && (
                        <p className="mt-1 text-xs text-white/60">
                          Audience: {a.audienceSize}
                        </p>
                      )}
                      {a.socials && (
                        <p className="mt-1 break-words text-xs text-white/60">
                          Links: {a.socials}
                        </p>
                      )}
                      {a.note && (
                        <p className="mt-1 text-xs text-white/50">“{a.note}”</p>
                      )}
                    </div>
                    <div className="flex shrink-0 gap-2">
                      <button
                        onClick={() => decideApp(a.profileId, "approved")}
                        className="rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-bold hover:bg-emerald-400"
                      >
                        Approve
                      </button>
                      <button
                        onClick={() => decideApp(a.profileId, "rejected")}
                        className="rounded-lg border border-white/15 px-3 py-1.5 text-xs font-semibold text-white/70 hover:bg-white/5"
                      >
                        Reject
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </section>
        );
      })()}

      <div className="mt-8 space-y-3">
        {loading && <p className="text-sm text-white/40">Loading…</p>}
        {!loading &&
          (data?.accounts ?? []).map((a) => (
            <AccountRow
              key={a.id}
              account={a}
              onPatch={patchAccount}
              onDelete={deleteAccount}
            />
          ))}
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
}: {
  account: AdminAccount;
  onPatch: (
    id: string,
    patch: Partial<Pick<AdminAccount, "role" | "isActive" | "features">>
  ) => void;
  onDelete: (id: string, email: string) => Promise<boolean>;
}) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [typedEmail, setTypedEmail] = useState("");
  const [deleting, setDeleting] = useState(false);

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

  return (
    <div
      className={`rounded-2xl border p-4 transition ${
        account.isActive
          ? "border-white/10 bg-white/5"
          : "border-red-500/20 bg-red-500/5"
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-bold">
            {account.displayName}
            {account.role === "admin" && (
              <span className="ml-2 rounded-full bg-amber-400/15 px-2 py-0.5 text-[10px] font-bold text-amber-300">
                ADMIN
              </span>
            )}
            {!account.isActive && (
              <span className="ml-2 rounded-full bg-red-500/20 px-2 py-0.5 text-[10px] font-bold text-red-300">
                SUSPENDED
              </span>
            )}
          </p>
          <p className="text-xs text-white/40">{account.email}</p>
        </div>
        <div className="flex items-center gap-2">
          <select
            className="ff-input text-xs"
            value={account.role}
            onChange={(e) =>
              onPatch(account.id, { role: e.target.value as AppRole })
            }
          >
            <option value="creator">Creator</option>
            <option value="admin">Admin</option>
          </select>
          <button
            onClick={() => onPatch(account.id, { isActive: !account.isActive })}
            className={`rounded-lg px-3 py-1.5 text-xs font-bold ${
              account.isActive
                ? "border border-white/15 text-white/70 hover:bg-white/5"
                : "bg-green-500/90 text-white hover:bg-green-400"
            }`}
          >
            {account.isActive ? "Suspend" : "Reactivate"}
          </button>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-4 text-xs text-white/50">
        <span>🎡 {account.wheels} wheels</span>
        <span>👥 {account.fans} fans</span>
        <span>🎯 {account.spins} spins</span>
        <span>🎁 {account.pending} pending</span>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {FEATURES.map((f) => {
          const on = f.base || account.features[f.key];
          return (
            <button
              key={f.key}
              disabled={f.base}
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
              className={`rounded-full px-3 py-1 text-xs font-semibold transition ${
                on
                  ? "bg-pink-500/20 text-pink-200 ring-1 ring-pink-500/40"
                  : "bg-white/5 text-white/40 hover:bg-white/10"
              } ${f.base ? "cursor-default" : ""}`}
            >
              {f.emoji} {f.label}
              {f.comingSoon && !on ? " (soon)" : ""}
              {on ? " ✓" : ""}
            </button>
          );
        })}
      </div>

      {/* Danger zone — irreversible hard-delete, kept distinct from Suspend. */}
      <div className="mt-4 border-t border-red-500/20 pt-3">
        {!confirmingDelete ? (
          <button
            type="button"
            onClick={() => setConfirmingDelete(true)}
            className="rounded-lg border border-red-500/50 px-3 py-1.5 text-xs font-semibold text-red-300 transition hover:bg-red-500/10"
          >
            Delete permanently…
          </button>
        ) : (
          <div className="space-y-2">
            <p className="text-xs text-red-200">
              This permanently deletes <strong>{account.displayName}</strong> and
              all of their wheels, fans, spins, grants, campaigns and messages.
              This <strong>cannot be undone</strong>. Type{" "}
              <strong className="break-all">{account.email}</strong> to confirm:
            </p>
            <input
              value={typedEmail}
              onChange={(e) => setTypedEmail(e.target.value)}
              placeholder={account.email}
              autoComplete="off"
              className="ff-input w-full text-xs"
            />
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={runDelete}
                disabled={!emailMatches || deleting}
                className="rounded-lg bg-red-500 px-3 py-1.5 text-xs font-bold text-white transition hover:bg-red-400 disabled:opacity-40"
              >
                {deleting ? "Deleting…" : "Permanently delete this account"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirmingDelete(false);
                  setTypedEmail("");
                }}
                disabled={deleting}
                className="rounded-lg border border-white/15 px-3 py-1.5 text-xs font-semibold text-white/70 transition hover:bg-white/5 disabled:opacity-40"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
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
      const data = await res.json();
      if (res.ok) onCreated();
      else setError(data.error ?? "Couldn't create account.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
        className="w-full max-w-sm rounded-2xl border border-white/10 bg-zinc-900 p-6 text-white"
      >
        <h2 className="text-lg font-bold">Create a creator account</h2>
        <p className="mt-1 text-sm text-white/50">
          You set their login. Share the credentials with the creator.
        </p>
        <div className="mt-4 space-y-3">
          <input
            className="ff-input w-full"
            placeholder="Display name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
          <input
            type="email"
            required
            className="ff-input w-full"
            placeholder="creator@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <input
            type="password"
            autoComplete="new-password"
            required
            minLength={6}
            className="ff-input w-full"
            placeholder="Temporary password (6+ chars)"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        {error && <p className="mt-3 text-sm text-amber-300">{error}</p>}
        <div className="mt-5 flex gap-2">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded-xl border border-white/15 py-2.5 text-sm font-semibold text-white/70 hover:bg-white/5"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy}
            className="flex-1 rounded-xl bg-pink-500 py-2.5 text-sm font-bold hover:bg-pink-400 disabled:opacity-50"
          >
            {busy ? "Creating…" : "Create"}
          </button>
        </div>
      </form>
    </div>
  );
}
