"use client";

import { useCallback, useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { brandVars } from "@/lib/theme";
import { useToast } from "@/components/ui/Toast";
import { Field } from "./ui";

/**
 * Settings (Phase 9 #6). Two groups:
 *   • Account — change password + email (Supabase Auth via server routes),
 *     display name, and notification preferences (persisted per account).
 *   • Public profile (SFW link-in-bio) — the editor MOVED out of Boosts, now
 *     with a LIVE PREVIEW of the public /c/[slug] page that updates as fields
 *     change (avatar, slug, tagline, note, tip URL, brand color).
 *
 * `onBrandColorChange` lets the dashboard re-tint live (brandVars) the instant a
 * new brand color is picked here — no refresh (#9).
 */
export default function SettingsPanel({
  onBrandColorChange,
}: {
  onBrandColorChange?: (color: string) => void;
}) {
  return (
    <div className="space-y-12">
      <AccountSection />
      <PublicProfileSection onBrandColorChange={onBrandColorChange} />
    </div>
  );
}

function GroupHeader({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="mb-4">
      <h2 className="text-lg font-bold text-ink">{title}</h2>
      {hint && <p className="mt-0.5 text-sm text-muted">{hint}</p>}
    </div>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return <div className="card space-y-4 rounded-xl p-5">{children}</div>;
}

// ---------------------------------------------------------------------------
// Account: display name, email, password, notification prefs.
// ---------------------------------------------------------------------------
interface NotificationPrefs {
  newSpin: boolean;
  lowBalance: boolean;
  messages: boolean;
}

function AccountSection() {
  const [email, setEmail] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [savedName, setSavedName] = useState("");
  const [notif, setNotif] = useState<NotificationPrefs>({
    newSpin: true,
    lowBalance: true,
    messages: true,
  });
  const [savedNotif, setSavedNotif] = useState<NotificationPrefs>({
    newSpin: true,
    lowBalance: true,
    messages: true,
  });
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let live = true;
    fetch("/api/account", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!live || !d) return;
        setEmail(d.email ?? null);
        setDisplayName(d.displayName ?? "");
        setSavedName(d.displayName ?? "");
        if (d.notifications) {
          setNotif(d.notifications);
          setSavedNotif(d.notifications);
        }
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
    return () => {
      live = false;
    };
  }, []);

  return (
    <section>
      <GroupHeader
        title="Account"
        hint="Your sign-in details and how you want to be notified."
      />
      <div className="space-y-5">
        <Card>
          <DisplayNameRow
            value={displayName}
            saved={savedName}
            disabled={!loaded}
            onChange={setDisplayName}
            onSaved={(n) => setSavedName(n)}
          />
        </Card>

        <Card>
          <EmailRow currentEmail={email} disabled={!loaded} />
        </Card>

        <Card>
          <PasswordRow />
        </Card>

        <Card>
          <NotificationsRow
            value={notif}
            saved={savedNotif}
            disabled={!loaded}
            onChange={setNotif}
            onSaved={(n) => setSavedNotif(n)}
          />
        </Card>
      </div>
    </section>
  );
}

function DisplayNameRow({
  value,
  saved,
  disabled,
  onChange,
  onSaved,
}: {
  value: string;
  saved: string;
  disabled: boolean;
  onChange: (v: string) => void;
  onSaved: (v: string) => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const dirty = value.trim() !== saved.trim();

  async function save() {
    const name = value.trim();
    if (!name) {
      toast("Enter a display name.", { tone: "error" });
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/account/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: name }),
      });
      if (!res.ok) throw new Error();
      onSaved(name);
      toast("Display name saved", { tone: "success" });
    } catch {
      toast("Couldn't save your name.", { tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h3 className="text-sm font-bold text-ink">Display name</h3>
      <p className="mt-0.5 text-xs text-muted">
        Shown to fans on your public page and spin links.
      </p>
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <Field label="Name">
          <input
            className="ff-input w-64 max-w-full"
            value={value}
            maxLength={80}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
            placeholder="Your creator name"
          />
        </Field>
        <button
          type="button"
          onClick={save}
          disabled={busy || disabled || !dirty}
          className="btn-brand rounded-lg px-4 py-2 text-sm font-bold disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}

function EmailRow({
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
    <div>
      <h3 className="text-sm font-bold text-ink">Email</h3>
      <p className="mt-0.5 text-xs text-muted">
        Current: <span className="font-semibold text-ink">{currentEmail ?? "—"}</span>.
        Changing it sends a confirmation link to the new address; it applies once
        you confirm.
      </p>
      {pending && (
        <p className="mt-2 rounded-lg border border-[var(--brand)]/40 bg-[color-mix(in_oklab,var(--brand)_10%,transparent)] px-3 py-2 text-xs text-ink">
          Pending confirmation: <span className="font-semibold">{pending}</span>
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <Field label="New email">
          <input
            type="email"
            className="ff-input w-72 max-w-full"
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
            className="ff-input w-56 max-w-full"
            value={current}
            disabled={disabled}
            onChange={(e) => setCurrent(e.target.value)}
            placeholder="Confirm it's you"
          />
        </Field>
        <button
          type="button"
          onClick={save}
          disabled={busy || disabled || !email.trim() || !current}
          className="btn-brand rounded-lg px-4 py-2 text-sm font-bold disabled:opacity-50"
        >
          {busy ? "Sending…" : "Change email"}
        </button>
      </div>
    </div>
  );
}

function PasswordRow() {
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
    <div>
      <h3 className="text-sm font-bold text-ink">Password</h3>
      <p className="mt-0.5 text-xs text-muted">
        You&rsquo;ll re-enter your current password to confirm it&rsquo;s you.
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <Field label="Current password">
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
        className="btn-brand mt-3 rounded-lg px-4 py-2 text-sm font-bold disabled:opacity-50"
      >
        {busy ? "Updating…" : "Update password"}
      </button>
    </div>
  );
}

const NOTIF_LABELS: { key: keyof NotificationPrefs; label: string; hint: string }[] = [
  { key: "newSpin", label: "New spins & wins", hint: "When a fan spins and wins a prize to fulfil." },
  { key: "lowBalance", label: "Low fan balance", hint: "When a fan is about to run out of spins." },
  { key: "messages", label: "New messages", hint: "When a fan replies in the inbox." },
];

function NotificationsRow({
  value,
  saved,
  disabled,
  onChange,
  onSaved,
}: {
  value: NotificationPrefs;
  saved: NotificationPrefs;
  disabled: boolean;
  onChange: (v: NotificationPrefs) => void;
  onSaved: (v: NotificationPrefs) => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
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
      onSaved(value);
      toast("Notification preferences saved", { tone: "success" });
    } catch {
      toast("Couldn't save preferences.", { tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h3 className="text-sm font-bold text-ink">Notifications</h3>
      <p className="mt-0.5 text-xs text-muted">Choose what you want to hear about.</p>
      <div className="mt-3 space-y-2">
        {NOTIF_LABELS.map((n) => {
          const on = value[n.key];
          return (
            <button
              key={n.key}
              type="button"
              disabled={disabled}
              onClick={() => onChange({ ...value, [n.key]: !on })}
              aria-pressed={on}
              className="flex w-full items-center gap-3 rounded-xl border border-line px-3 py-2.5 text-left transition hover:border-[var(--brand)]/50 disabled:opacity-50"
            >
              <span
                className={`relative h-6 w-11 shrink-0 rounded-full transition ${on ? "bg-[var(--brand)]" : "bg-line"}`}
              >
                <span
                  className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${on ? "left-[1.375rem]" : "left-0.5"}`}
                />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-ink">{n.label}</span>
                <span className="block text-xs text-muted">{n.hint}</span>
              </span>
            </button>
          );
        })}
      </div>
      <button
        type="button"
        onClick={save}
        disabled={busy || disabled || !dirty}
        className="btn-brand mt-3 rounded-lg px-4 py-2 text-sm font-bold disabled:opacity-50"
      >
        {busy ? "Saving…" : "Save preferences"}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Public profile (SFW link-in-bio) — MOVED from BoostsPanel, now with a live
// preview of the public /c/[slug] page.
// ---------------------------------------------------------------------------
function PublicProfileSection({
  onBrandColorChange,
}: {
  onBrandColorChange?: (color: string) => void;
}) {
  const toast = useToast();
  const [slug, setSlug] = useState("");
  const [tipUrl, setTipUrl] = useState("");
  const [tagline, setTagline] = useState("");
  const [note, setNote] = useState("");
  const [avatarUrl, setAvatarUrl] = useState("");
  const [displayName, setDisplayName] = useState("Creator");
  // Brand color drives the live preview (and the dashboard re-tint). Seeded from
  // the active wheel; saved to that wheel since /c/[slug] reads it from there.
  const [brandColor, setBrandColor] = useState("#ec4899");
  const [savedBrand, setSavedBrand] = useState("#ec4899");
  const [busy, setBusy] = useState(false);
  const [savingBrand, setSavingBrand] = useState(false);
  const [copied, setCopied] = useState(false);
  const origin = typeof window !== "undefined" ? window.location.origin : "";

  const reload = useCallback(async () => {
    const [profile, account, wheel] = await Promise.all([
      fetch("/api/public-profile", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)),
      fetch("/api/account", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)),
      fetch("/api/wheel", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)),
    ]);
    if (profile) {
      setSlug(profile.slug ?? "");
      setTipUrl(profile.tipUrl ?? "");
      setTagline(profile.tagline ?? "");
      setNote(profile.note ?? "");
      setAvatarUrl(profile.avatarUrl ?? "");
    }
    if (account?.displayName) setDisplayName(account.displayName);
    const wb = wheel?.wheel?.brandColor;
    if (wb) {
      setBrandColor(wb);
      setSavedBrand(wb);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async fetch-on-mount
    void reload();
  }, [reload]);

  const save = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/public-profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, tipUrl, tagline, note, avatarUrl }),
      });
      if (!res.ok) throw new Error();
      toast("Link-in-bio saved", { tone: "success" });
      // Reflect any server-side slug normalization.
      const fresh = await fetch("/api/public-profile", { cache: "no-store" }).then((r) => r.json());
      setSlug(fresh.slug ?? "");
    } catch {
      toast("Couldn't save — that slug may be taken.", { tone: "error" });
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
  const copy = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked */
    }
  };

  return (
    <section>
      <GroupHeader
        title="Public profile"
        hint="A clean, safe-for-work link-in-bio you can post in your Instagram/TikTok bio — your wheel teaser plus a way in. No explicit content."
      />
      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        {/* Editor */}
        <div className="space-y-4">
          <Card>
            <label className="block text-xs text-muted">
              Your public link
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="shrink-0 break-all text-sm text-muted">{origin}/c/</span>
                <input
                  value={slug}
                  onChange={(e) => setSlug(e.target.value)}
                  className="ff-input min-w-0 flex-1"
                  placeholder="your-name"
                />
              </div>
            </label>
            <label className="block text-xs text-muted">
              Tagline
              <input
                value={tagline}
                onChange={(e) => setTagline(e.target.value)}
                className="ff-input mt-1 w-full"
                placeholder="Spin my wheel — every spin wins 🎡"
              />
            </label>
            <label className="block text-xs text-muted">
              Tip / buy-spins link (where fans go to pay)
              <input
                value={tipUrl}
                onChange={(e) => setTipUrl(e.target.value)}
                className="ff-input mt-1 w-full"
                placeholder="https://onlyfans.com/you  or your tip link"
              />
            </label>
            <label className="block text-xs text-muted">
              Personal note to fans (shown atop their spin page)
              <input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                className="ff-input mt-1 w-full"
                placeholder="Hey you 😘 spin away — every spin wins!"
              />
            </label>
            <label className="block text-xs text-muted">
              Avatar (optional)
              <div className="mt-1 flex items-center gap-3">
                {avatarUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={avatarUrl} alt="" className="h-12 w-12 shrink-0 rounded-full object-cover ring-1 ring-line" />
                ) : (
                  <span className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-white/5 text-lg">📷</span>
                )}
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <input
                    value={avatarUrl}
                    onChange={(e) => setAvatarUrl(e.target.value)}
                    className="ff-input w-full"
                    placeholder="Paste an image URL, or upload →"
                  />
                  <AvatarUpload onUploaded={setAvatarUrl} />
                </div>
              </div>
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={save}
                disabled={busy}
                className="btn-brand rounded-lg px-4 py-2 text-sm font-bold disabled:opacity-50"
              >
                Save
              </button>
              {url && (
                <>
                  <a
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="rounded-lg border border-line px-3 py-2 text-sm font-semibold text-ink transition hover:border-[var(--brand)]"
                  >
                    Open ↗
                  </a>
                  <button
                    onClick={copy}
                    className="rounded-lg border border-line px-3 py-2 text-sm font-semibold text-ink transition hover:border-[var(--brand)]"
                  >
                    {copied ? "Copied!" : "Copy link"}
                  </button>
                </>
              )}
            </div>
          </Card>

          {/* Brand color (drives the public page + dashboard, applies live). */}
          <Card>
            <h3 className="text-sm font-bold text-ink">Brand color</h3>
            <p className="mt-0.5 text-xs text-muted">
              Tints your public page and dashboard. Applies to your active wheel.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <input
                type="color"
                className="h-9 w-12 shrink-0 rounded border border-line bg-transparent"
                value={brandColor}
                onChange={(e) => setBrandColor(e.target.value)}
                aria-label="Brand color"
              />
              <input
                className="ff-input w-32"
                value={brandColor}
                onChange={(e) => setBrandColor(e.target.value)}
                aria-label="Brand color hex"
              />
              <button
                type="button"
                onClick={saveBrand}
                disabled={savingBrand || brandColor === savedBrand}
                className="btn-brand rounded-lg px-4 py-2 text-sm font-bold disabled:opacity-50"
              >
                {savingBrand ? "Saving…" : "Save color"}
              </button>
            </div>
          </Card>
        </div>

        {/* Live preview of the public /c/[slug] page. */}
        <div className="lg:sticky lg:top-4 lg:self-start">
          <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted">
            Live preview
          </p>
          <ProfilePreview
            brandColor={brandColor}
            avatarUrl={avatarUrl}
            displayName={displayName}
            tagline={tagline}
            hasTipUrl={!!tipUrl.trim()}
          />
        </div>
      </div>
    </section>
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
      className="overflow-hidden rounded-2xl border border-line"
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
          <h1 className="text-2xl font-extrabold text-ink">
            {displayName || "Creator"}
          </h1>
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
        toast("Photo uploaded — Save to apply.", { tone: "success" });
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
    <label className="inline-flex w-fit cursor-pointer items-center rounded-lg border border-line px-3 py-1.5 text-xs font-semibold text-ink transition hover:bg-white/5">
      {busy ? "Uploading…" : "⬆ Upload photo"}
      <input type="file" accept="image/*" onChange={pick} disabled={busy} className="hidden" />
    </label>
  );
}
