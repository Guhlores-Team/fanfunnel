"use client";

import { useCallback, useEffect, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { brandVars } from "@/lib/theme";
import { useToast } from "@/components/ui/Toast";
import { useClipboard } from "@/lib/hooks/useClipboard";
import { Field } from "./ui";
import HomeScreenIconCard from "./HomeScreenIconCard";
import PushNotificationsCard from "./PushNotificationsCard";

/**
 * Settings (Command Center). Two groups:
 *   • Account — profile (avatar, display name, handle, email), password and
 *     notification preferences (Supabase Auth via server routes; prefs are
 *     persisted per account).
 *   • Public page (SFW link-in-bio) — slug / tagline / tip link / note, the brand
 *     color, and a LIVE PREVIEW of the public /c/[slug] page that updates as
 *     fields change. The avatar is edited in Profile but stored on the same
 *     public profile, so the preview reflects it live too.
 *
 * `onBrandColorChange` lets the dashboard re-tint live (brandVars) the instant a
 * new brand color is saved here — no refresh (#9). `onDisplayNameChange` does
 * the same for the sidebar's workspace name (behavior spec #3).
 */
export default function SettingsPanel({
  onBrandColorChange,
  onDisplayNameChange,
  pushFocus = 0,
}: {
  onBrandColorChange?: (color: string) => void;
  onDisplayNameChange?: (name: string) => void;
  /** Bumped to scroll to (and focus) the push card: bell footer / Inbox. */
  pushFocus?: number;
}) {
  const [account, setAccount] = useState<AccountState>(INITIAL_ACCOUNT);
  const [profile, setProfile] = useState<ProfileFields>(EMPTY_PROFILE);
  // Last server-confirmed profile; "dirty" and per-card saves compare against it.
  const [savedProfile, setSavedProfile] = useState<ProfileFields>(EMPTY_PROFILE);

  useEffect(() => {
    let live = true;
    fetch("/api/account", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!live) return;
        setAccount((a) => ({
          ...a,
          loaded: true,
          ...(d
            ? {
                email: d.email ?? null,
                displayName: d.displayName ?? "",
                savedName: d.displayName ?? "",
                ...(d.notifications
                  ? { notif: d.notifications, savedNotif: d.notifications }
                  : {}),
              }
            : {}),
        }));
      })
      .catch(() => {
        if (live) setAccount((a) => ({ ...a, loaded: true }));
      });
    fetch("/api/public-profile", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((p) => {
        if (!live || !p) return;
        const next: ProfileFields = {
          slug: p.slug ?? "",
          tipUrl: p.tipUrl ?? "",
          tagline: p.tagline ?? "",
          note: p.note ?? "",
          avatarUrl: p.avatarUrl ?? "",
        };
        setProfile(next);
        setSavedProfile(next);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  const patchAccount = useCallback(
    (p: Partial<AccountState>) => setAccount((a) => ({ ...a, ...p })),
    []
  );
  const patchProfile = useCallback(
    (p: Partial<ProfileFields>) => setProfile((x) => ({ ...x, ...p })),
    []
  );
  const markSaved = useCallback(
    (p: Partial<ProfileFields>) => setSavedProfile((x) => ({ ...x, ...p })),
    []
  );

  return (
    <div className="max-w-5xl space-y-11">
      <section aria-labelledby="settings-account">
        <GroupHeader
          id="settings-account"
          title="Account"
          hint="Your profile, sign-in details and how you want to be notified."
        />
        <div className="max-w-[680px] space-y-[18px]">
          <ProfileCard
            account={account}
            patchAccount={patchAccount}
            profile={profile}
            savedAvatar={savedProfile.avatarUrl}
            patchProfile={patchProfile}
            markSaved={markSaved}
            onDisplayNameChange={onDisplayNameChange}
          />
          <SecurityCard />
          <NotificationsCard account={account} patchAccount={patchAccount} />
          <PushNotificationsCard focusNonce={pushFocus} />
        </div>
      </section>

      <section aria-labelledby="settings-public">
        <GroupHeader
          id="settings-public"
          title="Public page"
          hint="A clean, safe-for-work link-in-bio you can post in your Instagram/TikTok bio — your wheel teaser plus a way in. No explicit content."
        />
        <PublicPageSection
          profile={profile}
          savedProfile={savedProfile}
          displayName={account.displayName}
          patchProfile={patchProfile}
          markSaved={markSaved}
          onBrandColorChange={onBrandColorChange}
        />
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared bits: icons, headers, cards, buttons.
// ---------------------------------------------------------------------------
const P = {
  user: "M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z",
  lock: "M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4",
  bell: "M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0",
  link: "M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7",
  palette:
    "M12 22a10 10 0 1 1 10-10c0 3-2 4-4 4h-2a2 2 0 0 0-1.5 3.3c.6.7.2 2.7-2.5 2.7ZM7.5 11.5h.01M10.5 7.5h.01M15.5 8.5h.01",
  upload: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12",
  external: "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14 21 3",
  copy: "M9 9h11v11H9zM5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1",
  mail: "M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2ZM22 6l-10 7L2 6",
};

function Glyph({ d, size = 17 }: { d: string; size?: number }) {
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
      className="shrink-0"
    >
      <path d={d} />
    </svg>
  );
}

const raised = "border border-[var(--hair)] [background:var(--s1)] shadow-[var(--lift)]";
const recessed = "border border-[var(--hair)] [background:var(--s2)]";
const primaryBtn =
  "btn-brand inline-flex min-h-10 items-center justify-center gap-1.5 rounded-[10px] px-[18px] text-sm font-bold disabled:opacity-50";
const secondaryBtn =
  "inline-flex min-h-10 items-center justify-center gap-1.5 rounded-[10px] border border-line px-4 text-sm font-semibold text-ink transition-colors hover:border-[var(--brand)]/60 hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-50";

function GroupHeader({ id, title, hint }: { id: string; title: string; hint?: string }) {
  return (
    <div className="mb-3.5">
      <h2
        id={id}
        className="flex items-center gap-[9px] text-base font-bold tracking-[-0.01em] text-ink"
      >
        <span aria-hidden="true" className="h-4 w-[3px] rounded-sm bg-[var(--brand)]" />
        {title}
      </h2>
      {hint && <p className="mt-1 max-w-2xl text-[13px] text-muted">{hint}</p>}
    </div>
  );
}

function Card({ children }: { children: ReactNode }) {
  return <div className={`min-w-0 space-y-4 rounded-2xl p-5 ${raised}`}>{children}</div>;
}

function CardTitle({ icon, title, hint }: { icon: string; title: string; hint?: ReactNode }) {
  return (
    <div>
      <h3 className="flex items-center gap-2 text-[15px] font-bold text-ink">
        <span className="text-brand">
          <Glyph d={icon} />
        </span>
        {title}
      </h3>
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </div>
  );
}

function Unsaved() {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#fcd34d]" role="status">
      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-[#f59e0b]" />
      Unsaved changes
    </span>
  );
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

// ---------------------------------------------------------------------------
// Account state shared by the Profile and Notifications cards.
// ---------------------------------------------------------------------------
interface NotificationPrefs {
  newSpin: boolean;
  lowBalance: boolean;
  messages: boolean;
}

interface AccountState {
  email: string | null;
  displayName: string;
  savedName: string;
  notif: NotificationPrefs;
  savedNotif: NotificationPrefs;
  loaded: boolean;
}

const DEFAULT_NOTIF: NotificationPrefs = { newSpin: true, lowBalance: true, messages: true };
const INITIAL_ACCOUNT: AccountState = {
  email: null,
  displayName: "",
  savedName: "",
  notif: DEFAULT_NOTIF,
  savedNotif: DEFAULT_NOTIF,
  loaded: false,
};

interface ProfileFields {
  slug: string;
  tipUrl: string;
  tagline: string;
  note: string;
  avatarUrl: string;
}
const EMPTY_PROFILE: ProfileFields = { slug: "", tipUrl: "", tagline: "", note: "", avatarUrl: "" };

// ---------------------------------------------------------------------------
// Profile: avatar, display name, handle (read-only), email change.
// ---------------------------------------------------------------------------
function ProfileCard({
  account,
  patchAccount,
  profile,
  savedAvatar,
  patchProfile,
  markSaved,
  onDisplayNameChange,
}: {
  account: AccountState;
  patchAccount: (p: Partial<AccountState>) => void;
  profile: ProfileFields;
  savedAvatar: string;
  patchProfile: (p: Partial<ProfileFields>) => void;
  markSaved: (p: Partial<ProfileFields>) => void;
  onDisplayNameChange?: (name: string) => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const { displayName, savedName, loaded } = account;
  const nameDirty = displayName.trim() !== savedName.trim();
  const avatarDirty = profile.avatarUrl !== savedAvatar;
  const dirty = nameDirty || avatarDirty;

  // One "Save profile": the name goes to /api/account/profile, the avatar lives
  // on the public profile so it goes to /api/public-profile (avatarUrl only —
  // the route updates just the fields it is sent).
  async function save() {
    const name = displayName.trim();
    if (nameDirty && !name) {
      toast("Enter a display name.", { tone: "error" });
      return;
    }
    setBusy(true);
    let ok = true;
    try {
      if (nameDirty) {
        try {
          const res = await fetch("/api/account/profile", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ displayName: name }),
          });
          if (!res.ok) throw new Error();
          patchAccount({ savedName: name });
          onDisplayNameChange?.(name);
        } catch {
          ok = false;
          toast("Couldn't save your name.", { tone: "error" });
        }
      }
      if (avatarDirty) {
        try {
          const res = await fetch("/api/public-profile", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ avatarUrl: profile.avatarUrl }),
          });
          if (!res.ok) {
            const d = await res.json().catch(() => ({}));
            throw new Error(d.error === "invalid_avatar_url" ? "invalid_avatar_url" : "");
          }
          markSaved({ avatarUrl: profile.avatarUrl });
        } catch (e) {
          ok = false;
          toast(
            e instanceof Error && e.message === "invalid_avatar_url"
              ? "That photo URL isn't allowed. Upload the image instead."
              : "Couldn't save your photo.",
            { tone: "error" }
          );
        }
      }
      if (ok) toast("Profile saved", { tone: "success" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardTitle icon={P.user} title="Profile" hint="Shown to fans on your public page and spin links." />

      <div className="flex flex-wrap items-center gap-3.5">
        <Avatar url={profile.avatarUrl} name={displayName} size={56} />
        <AvatarUpload onUploaded={(url) => patchProfile({ avatarUrl: url })} />
      </div>

      <div className="grid gap-3.5 sm:grid-cols-2">
        <Field label="Display name">
          <input
            className="ff-input w-full"
            value={displayName}
            maxLength={80}
            disabled={!loaded}
            onChange={(e) => patchAccount({ displayName: e.target.value })}
            placeholder="Your creator name"
          />
        </Field>
        <Field label="Handle">
          <input
            className="ff-input w-full opacity-80"
            value={profile.slug ? `@${profile.slug}` : ""}
            readOnly
            aria-describedby="handle-hint"
            placeholder="Not set yet"
          />
        </Field>
        <p id="handle-hint" className="-mt-1.5 text-xs text-muted sm:col-span-2">
          Your handle is your public link name. Change it under Public page.
        </p>
        <Field label="Avatar URL" full>
          <input
            className="ff-input w-full"
            value={profile.avatarUrl}
            onChange={(e) => patchProfile({ avatarUrl: e.target.value })}
            placeholder="Paste an image URL, or use Change avatar"
          />
        </Field>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={busy || !loaded || !dirty}
          className={primaryBtn}
        >
          {busy ? "Saving…" : "Save profile"}
        </button>
        {dirty && <Unsaved />}
      </div>

      <EmailBlock currentEmail={account.email} disabled={!loaded} />
    </Card>
  );
}

function Avatar({ url, name, size }: { url: string; name: string; size: number }) {
  const style = { width: size, height: size } as CSSProperties;
  return url ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={url} alt="" style={style} className="shrink-0 rounded-full object-cover ring-1 ring-line" />
  ) : (
    <span
      aria-hidden="true"
      style={style}
      className="text-brand grid shrink-0 place-items-center rounded-full bg-[color-mix(in_oklab,var(--brand)_18%,transparent)] text-lg font-bold"
    >
      {initialsOf(name)}
    </span>
  );
}

function EmailBlock({
  currentEmail,
  disabled,
}: {
  currentEmail: string | null;
  disabled: boolean;
}) {
  const toast = useToast();
  const [email, setEmail] = useState("");
  const [current, setCurrent] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<string | null>(null);

  async function save() {
    const next = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(next)) {
      toast("Enter a valid email address.", { tone: "error" });
      return;
    }
    if (!current) {
      toast("Enter your current password to confirm.", { tone: "error" });
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/account/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: next, currentPassword: current }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast(
          d.error === "wrong_password"
            ? "Your current password is incorrect."
            : d.error === "same_email"
              ? "That's already your email."
              : d.error === "demo_mode"
                ? "Email changes need Supabase configured (demo mode)."
                : "Couldn't start the email change.",
          { tone: "error" }
        );
        return;
      }
      setPending(next);
      setEmail("");
      setCurrent("");
      toast("Check your inbox to confirm the new email.", { tone: "success" });
    } catch {
      toast("Couldn't start the email change.", { tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`space-y-3 rounded-xl p-4 ${recessed}`}>
      <div>
        <h4 className="flex items-center gap-2 text-sm font-bold text-ink">
          <span className="text-muted">
            <Glyph d={P.mail} size={15} />
          </span>
          Email
        </h4>
        <p className="mt-1 text-xs text-muted">
          Current: <span className="break-all font-semibold text-ink">{currentEmail ?? "—"}</span>.
          Changing it sends a confirmation link to the new address; it applies once you confirm.
        </p>
      </div>
      {pending && (
        <p
          role="status"
          className="rounded-lg border border-[var(--brand)]/40 bg-[color-mix(in_oklab,var(--brand)_10%,transparent)] px-3 py-2 text-xs text-ink"
        >
          Pending confirmation: <span className="break-all font-semibold">{pending}</span>
        </p>
      )}
      <div className="grid gap-3.5 sm:grid-cols-2">
        <Field label="New email">
          <input
            type="email"
            autoComplete="email"
            className="ff-input w-full"
            value={email}
            disabled={disabled}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
          />
        </Field>
        <Field label="Current password">
          <input
            type="password"
            autoComplete="current-password"
            className="ff-input w-full"
            value={current}
            disabled={disabled}
            onChange={(e) => setCurrent(e.target.value)}
            placeholder="Confirm it's you"
          />
        </Field>
      </div>
      <button
        type="button"
        onClick={save}
        disabled={busy || disabled || !email.trim() || !current}
        className={secondaryBtn}
      >
        {busy ? "Sending…" : "Change email"}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Security: change password.
// ---------------------------------------------------------------------------
function SecurityCard() {
  const toast = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  async function save() {
    if (next.length < 8) {
      toast("New password must be at least 8 characters.", { tone: "error" });
      return;
    }
    if (next !== confirm) {
      toast("New passwords don't match.", { tone: "error" });
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/account/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast(
          d.error === "wrong_password"
            ? "Your current password is incorrect."
            : d.error === "weak_password"
              ? "New password must be at least 8 characters."
              : d.error === "demo_mode"
                ? "Password changes need Supabase configured (demo mode)."
                : "Couldn't change your password.",
          { tone: "error" }
        );
        return;
      }
      setCurrent("");
      setNext("");
      setConfirm("");
      toast("Password updated", { tone: "success" });
    } catch {
      toast("Couldn't change your password.", { tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardTitle
        icon={P.lock}
        title="Security"
        hint="You’ll re-enter your current password to confirm it’s you. Use at least 8 characters."
      />
      <div className="grid gap-3.5 sm:grid-cols-2">
        <Field label="Current password" full>
          <input
            type="password"
            autoComplete="current-password"
            className="ff-input w-full"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          />
        </Field>
        <Field label="New password">
          <input
            type="password"
            autoComplete="new-password"
            className="ff-input w-full"
            value={next}
            onChange={(e) => setNext(e.target.value)}
          />
        </Field>
        <Field label="Confirm new">
          <input
            type="password"
            autoComplete="new-password"
            className="ff-input w-full"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </Field>
      </div>
      <button
        type="button"
        onClick={save}
        disabled={busy || !current || !next || !confirm}
        className={secondaryBtn}
      >
        {busy ? "Updating…" : "Update password"}
      </button>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Notifications: toggles + explicit Save.
// ---------------------------------------------------------------------------
const NOTIF_LABELS: { key: keyof NotificationPrefs; label: string; hint: string }[] = [
  { key: "newSpin", label: "New spins & wins", hint: "When a fan spins and wins a prize to fulfil." },
  { key: "lowBalance", label: "Low fan balance", hint: "When a fan is about to run out of spins." },
  { key: "messages", label: "New messages", hint: "When a fan replies in the inbox." },
];

function NotificationsCard({
  account,
  patchAccount,
}: {
  account: AccountState;
  patchAccount: (p: Partial<AccountState>) => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const { notif: value, savedNotif: saved, loaded } = account;
  const dirty =
    value.newSpin !== saved.newSpin ||
    value.lowBalance !== saved.lowBalance ||
    value.messages !== saved.messages;

  async function save() {
    setBusy(true);
    try {
      const res = await fetch("/api/account/notifications", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(value),
      });
      if (!res.ok) throw new Error();
      patchAccount({ savedNotif: value });
      toast("Notification preferences saved", { tone: "success" });
    } catch {
      toast("Couldn't save preferences.", { tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardTitle icon={P.bell} title="Notifications" hint="Choose what you want to hear about." />
      <div className="flex flex-col">
        {NOTIF_LABELS.map((n, i) => {
          const on = value[n.key];
          return (
            <button
              key={n.key}
              type="button"
              disabled={!loaded}
              onClick={() => patchAccount({ notif: { ...value, [n.key]: !on } })}
              aria-pressed={on}
              className={`flex w-full items-center justify-between gap-4 py-3 text-left transition-colors hover:bg-white/[0.02] disabled:opacity-50 ${
                i < NOTIF_LABELS.length - 1 ? "border-b border-[var(--hair)]" : ""
              }`}
            >
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-ink">{n.label}</span>
                <span className="block text-xs text-muted">{n.hint}</span>
              </span>
              <span
                aria-hidden="true"
                className={`relative h-[26px] w-[46px] shrink-0 rounded-full transition-colors ${on ? "bg-[var(--brand)]" : "bg-line"}`}
              >
                <span
                  className={`absolute top-[3px] h-5 w-5 rounded-full transition-all ${
                    on ? "left-[23px] bg-[var(--brand-ink)]" : "left-[3px] bg-white"
                  }`}
                />
              </span>
            </button>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={busy || !loaded || !dirty}
          className={primaryBtn}
        >
          {busy ? "Saving…" : "Save preferences"}
        </button>
        {dirty && <Unsaved />}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Public page (SFW link-in-bio) — slug / tagline / tip / note + brand color,
// with a live preview of the public /c/[slug] page.
// ---------------------------------------------------------------------------
function PublicPageSection({
  profile,
  savedProfile,
  displayName,
  patchProfile,
  markSaved,
  onBrandColorChange,
}: {
  profile: ProfileFields;
  savedProfile: ProfileFields;
  displayName: string;
  patchProfile: (p: Partial<ProfileFields>) => void;
  markSaved: (p: Partial<ProfileFields>) => void;
  onBrandColorChange?: (color: string) => void;
}) {
  const toast = useToast();
  const { copy, copied } = useClipboard();
  // Brand color drives the live preview (and the dashboard re-tint). Seeded from
  // the active wheel; saved to that wheel since /c/[slug] reads it from there.
  const [brandColor, setBrandColor] = useState("#ec4899");
  const [savedBrand, setSavedBrand] = useState("#ec4899");
  const [busy, setBusy] = useState(false);
  const [savingBrand, setSavingBrand] = useState(false);
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const { slug, tipUrl, tagline, note, avatarUrl } = profile;
  const linkDirty =
    slug !== savedProfile.slug ||
    tipUrl !== savedProfile.tipUrl ||
    tagline !== savedProfile.tagline ||
    note !== savedProfile.note;

  useEffect(() => {
    let live = true;
    fetch("/api/wheel", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((w) => {
        const wb = w?.wheel?.brandColor;
        if (live && wb) {
          setBrandColor(wb);
          setSavedBrand(wb);
        }
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  // Saves the link-in-bio fields. The avatar is saved from the Profile card.
  const save = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/public-profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, tipUrl, tagline, note }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(typeof d.error === "string" ? d.error : "");
      }
      toast("Link-in-bio saved", { tone: "success" });
      // Reflect any server-side slug normalization.
      const fresh = await fetch("/api/public-profile", { cache: "no-store" }).then((r) => r.json());
      const normalized = fresh.slug ?? "";
      patchProfile({ slug: normalized });
      markSaved({ slug: normalized, tipUrl, tagline, note });
    } catch (e) {
      const code = e instanceof Error ? e.message : "";
      toast(
        code === "invalid_slug"
          ? "Use letters, numbers, spaces, dashes or underscores in your link name."
          : code === "invalid_tip_url"
            ? "That tip link doesn't look like a web address."
            : "Couldn't save — that slug may be taken.",
        { tone: "error" }
      );
    } finally {
      setBusy(false);
    }
  };

  // Persist the brand color to the active wheel; re-tint the dashboard live.
  const saveBrand = async () => {
    setSavingBrand(true);
    try {
      const res = await fetch("/api/account/brand-color", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ color: brandColor }),
      });
      if (!res.ok) throw new Error();
      setSavedBrand(brandColor);
      onBrandColorChange?.(brandColor);
      toast("Brand color saved", { tone: "success" });
    } catch {
      toast("Couldn't save brand color.", { tone: "error" });
    } finally {
      setSavingBrand(false);
    }
  };

  const url = slug ? `${origin}/c/${slug}` : "";
  const onCopy = async () => {
    if (!url) return;
    if (!(await copy(url))) toast("Couldn't copy — select the link and copy it.", { tone: "error" });
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
      {/* Editor */}
      <div className="min-w-0 space-y-[18px]">
        <Card>
          <CardTitle icon={P.link} title="Link-in-bio" />
          <Field label="Your public link">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="tnum shrink-0 break-all text-sm text-muted">{origin}/c/</span>
              <input
                value={slug}
                onChange={(e) => patchProfile({ slug: e.target.value })}
                className="ff-input min-w-0 flex-1 basis-40"
                placeholder="your-name"
              />
            </div>
          </Field>
          <Field label="Tagline">
            <input
              value={tagline}
              onChange={(e) => patchProfile({ tagline: e.target.value })}
              className="ff-input w-full"
              placeholder="Spin my wheel — every spin wins 🎡"
            />
          </Field>
          <Field label="Tip / buy-spins link (where fans go to pay)">
            <input
              value={tipUrl}
              onChange={(e) => patchProfile({ tipUrl: e.target.value })}
              className="ff-input w-full"
              placeholder="https://onlyfans.com/you  or your tip link"
            />
          </Field>
          <Field label="Personal note to fans (shown atop their spin page)">
            <input
              value={note}
              onChange={(e) => patchProfile({ note: e.target.value })}
              className="ff-input w-full"
              placeholder="Hey you 😘 spin away — every spin wins!"
            />
          </Field>
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={save} disabled={busy} className={primaryBtn}>
              {busy ? "Saving…" : "Save"}
            </button>
            {url && (
              <>
                <a href={url} target="_blank" rel="noopener noreferrer" className={secondaryBtn}>
                  Open
                  <Glyph d={P.external} size={14} />
                  <span className="sr-only">(opens in a new tab)</span>
                </a>
                <button onClick={onCopy} className={secondaryBtn}>
                  <Glyph d={P.copy} size={14} />
                  {copied ? "Copied!" : "Copy link"}
                </button>
              </>
            )}
            {linkDirty && <Unsaved />}
          </div>
        </Card>

        {/* Brand color (drives the public page + dashboard, applies live). */}
        <Card>
          <CardTitle
            icon={P.palette}
            title="Brand color"
            hint="Tints your public page and dashboard. Applies to your active wheel."
          />
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="color"
              className="h-10 w-12 shrink-0 cursor-pointer rounded-[10px] border border-line bg-transparent p-0.5"
              value={brandColor}
              onChange={(e) => setBrandColor(e.target.value)}
              aria-label="Brand color"
            />
            <input
              className="ff-input tnum w-32"
              value={brandColor}
              onChange={(e) => setBrandColor(e.target.value)}
              aria-label="Brand color hex"
            />
            <button
              type="button"
              onClick={saveBrand}
              disabled={savingBrand || brandColor === savedBrand}
              className={primaryBtn}
            >
              {savingBrand ? "Saving…" : "Save color"}
            </button>
            {brandColor !== savedBrand && <Unsaved />}
          </div>
        </Card>
        <HomeScreenIconCard brandColor={savedBrand} avatarUrl={savedProfile.avatarUrl} displayName={displayName} />
      </div>

      {/* Live preview of the public /c/[slug] page. */}
      <div className="min-w-0 lg:sticky lg:top-4 lg:self-start">
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-[.05em] text-muted">
          Live preview
        </p>
        <ProfilePreview
          brandColor={brandColor}
          avatarUrl={avatarUrl}
          displayName={displayName || "Creator"}
          tagline={tagline}
          hasTipUrl={!!tipUrl.trim()}
        />
      </div>
    </div>
  );
}

/**
 * A faithful, self-contained preview of the public /c/[slug] page. Mirrors that
 * page's structure (avatar/🎡 hero, title, tagline, CTA) and re-tints instantly
 * via brandVars as the creator edits — so they see the result before saving.
 */
function ProfilePreview({
  brandColor,
  avatarUrl,
  displayName,
  tagline,
  hasTipUrl,
}: {
  brandColor: string;
  avatarUrl: string;
  displayName: string;
  tagline: string;
  hasTipUrl: boolean;
}) {
  return (
    <div
      className="overflow-hidden rounded-2xl border border-[var(--hair)] shadow-[var(--lift)]"
      style={brandVars(brandColor)}
    >
      <div
        className="flex min-h-[420px] flex-col items-center justify-center px-6 py-10"
        style={
          {
            background:
              "radial-gradient(120% 80% at 50% 0%, color-mix(in oklab, var(--brand) 22%, transparent), transparent 60%), var(--color-base, #0c0a0e)",
          } as CSSProperties
        }
      >
        <div className="w-full max-w-xs text-center">
          {avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={avatarUrl}
              alt=""
              className="mx-auto mb-5 h-20 w-20 rounded-full object-cover ring-2 ring-[var(--brand)]"
            />
          ) : (
            <div
              aria-hidden
              className="mx-auto mb-5 grid h-20 w-20 place-items-center rounded-full text-4xl"
              style={{
                background:
                  "radial-gradient(circle, color-mix(in oklab, var(--brand) 40%, transparent), transparent 70%)",
              }}
            >
              🎡
            </div>
          )}
          <p className="break-words text-2xl font-extrabold text-ink">{displayName || "Creator"}</p>
          <p className="mx-auto mt-2 max-w-xs text-sm text-muted text-pretty">
            {tagline || "Spin my wheel — every spin wins a prize. 🎁"}
          </p>
          {hasTipUrl ? (
            <span className="btn-brand mt-7 inline-block w-full rounded-2xl py-3.5 text-base font-extrabold">
              Get your spins →
            </span>
          ) : (
            <p className="mt-7 text-sm text-muted">
              DM {displayName || "the creator"} to get your personal spin link.
            </p>
          )}
          <p className="mt-3 text-xs text-muted/70">
            Every spin wins · rare drops keep it exciting
          </p>
        </div>
      </div>
    </div>
  );
}

/** A file picker that uploads an avatar to Storage and returns its public URL. */
function AvatarUpload({ onUploaded }: { onUploaded: (url: string) => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  async function pick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      toast("Please choose an image file.", { tone: "error" });
      return;
    }
    setBusy(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/account/avatar", { method: "POST", body: form });
      const d = await res.json().catch(() => ({}));
      if (res.ok && d.url) {
        onUploaded(d.url);
        toast("Photo uploaded — Save profile to apply.", { tone: "success" });
      } else {
        toast(
          d.error === "too_large"
            ? "Image too large (max 5 MB)."
            : d.error === "demo_mode"
              ? "Upload needs Supabase configured (demo mode)."
              : "Upload failed.",
          { tone: "error" }
        );
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <label className="relative inline-flex cursor-pointer items-center gap-1.5 rounded-[10px] border border-line px-3.5 text-sm font-semibold text-ink transition-colors focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[var(--brand)] hover:border-[var(--brand)]/60 hover:bg-white/5 min-h-9 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60">
      <Glyph d={P.upload} size={15} />
      {busy ? "Uploading…" : "Change avatar"}
      <input
        type="file"
        accept="image/*"
        onChange={pick}
        disabled={busy}
        className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
        aria-label="Change avatar — choose an image file"
      />
    </label>
  );
}
