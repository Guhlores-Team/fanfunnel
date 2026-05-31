"use client";

import { useState } from "react";

/**
 * Shown to signed-in creators who aren't approved yet. Pending users can submit
 * (or update) their creator details for vetting; rejected users see a notice.
 */
export default function PendingClient({
  status,
  email,
}: {
  status: "pending" | "rejected";
  email: string;
}) {
  const [displayName, setDisplayName] = useState("");
  const [platform, setPlatform] = useState("");
  const [socials, setSocials] = useState("");
  const [audienceSize, setAudienceSize] = useState("");
  const [country, setCountry] = useState("");
  const [referral, setReferral] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Require the fields we actually vet on.
  const ready =
    displayName.trim().length > 1 &&
    socials.trim().length > 3 &&
    platform.trim().length > 0 &&
    audienceSize.trim().length > 0;

  const submit = async () => {
    if (!ready) {
      setError("Please fill in your name, main platform, links, and audience size.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // Fold the extra vetting fields into the note so no migration is needed.
      const composedNote = [
        platform && `Main platform: ${platform}`,
        country && `Based in: ${country}`,
        referral && `Heard about us: ${referral}`,
        note && `Notes: ${note}`,
      ]
        .filter(Boolean)
        .join("\n");
      const res = await fetch("/api/creator-application", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName, socials, audienceSize, note: composedNote }),
      });
      if (!res.ok) throw new Error();
      setSent(true);
    } catch {
      setError("Couldn't submit. Try again.");
    } finally {
      setBusy(false);
    }
  };

  if (status === "rejected") {
    return (
      <div className="card rounded-2xl p-7 text-center">
        <div className="text-4xl">🚫</div>
        <h1 className="mt-3 font-[family-name:var(--font-display)] text-xl font-extrabold text-ink">
          Application not approved
        </h1>
        <p className="mt-2 text-sm text-muted text-pretty">
          Your request for a FanFunnel creator account wasn&rsquo;t approved. If you
          think this is a mistake, reach out to support.
        </p>
        <form action="/auth/signout" method="post" className="mt-6">
          <button className="rounded-lg border border-line px-4 py-2 text-sm font-semibold text-muted transition hover:text-ink">
            Sign out
          </button>
        </form>
      </div>
    );
  }

  if (sent) {
    return (
      <div className="card rounded-2xl p-7 text-center">
        <div className="text-4xl">✅</div>
        <h1 className="mt-3 font-[family-name:var(--font-display)] text-xl font-extrabold text-ink">
          Request submitted
        </h1>
        <p className="mt-2 text-sm text-muted text-pretty">
          Thanks! We&rsquo;ll review your details and email{" "}
          <span className="text-ink">{email}</span> when your account is approved.
        </p>
        <form action="/auth/signout" method="post" className="mt-6">
          <button className="rounded-lg border border-line px-4 py-2 text-sm font-semibold text-muted transition hover:text-ink">
            Sign out
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="card rounded-2xl p-7">
      <div className="text-center">
        <div className="text-4xl">⏳</div>
        <h1 className="mt-3 font-[family-name:var(--font-display)] text-xl font-extrabold text-ink">
          Request creator access
        </h1>
        <p className="mt-2 text-sm text-muted text-pretty">
          FanFunnel creator accounts are approved by hand. Tell us about you and
          we&rsquo;ll review it shortly.
        </p>
      </div>

      <div className="mt-6 space-y-3">
        <Field label="Creator / display name *">
          <input
            className="ff-input w-full"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="How fans know you"
          />
        </Field>
        <Field label="Main platform *">
          <input
            className="ff-input w-full"
            value={platform}
            onChange={(e) => setPlatform(e.target.value)}
            placeholder="OnlyFans / Fansly / Fanvue / etc."
          />
        </Field>
        <Field label="Your links / handles *">
          <textarea
            className="ff-input w-full"
            rows={2}
            value={socials}
            onChange={(e) => setSocials(e.target.value)}
            placeholder="Profile URL + Instagram / X handles (so we can verify it's you)"
          />
        </Field>
        <Field label="Audience size *">
          <input
            className="ff-input w-full"
            value={audienceSize}
            onChange={(e) => setAudienceSize(e.target.value)}
            placeholder="e.g. ~5k subscribers / 30k followers"
          />
        </Field>
        <Field label="Based in (country)">
          <input
            className="ff-input w-full"
            value={country}
            onChange={(e) => setCountry(e.target.value)}
            placeholder="For payouts & compliance"
          />
        </Field>
        <Field label="How did you hear about us?">
          <input
            className="ff-input w-full"
            value={referral}
            onChange={(e) => setReferral(e.target.value)}
            placeholder="Agency, a friend, X, etc."
          />
        </Field>
        <Field label="Anything else (optional)">
          <textarea
            className="ff-input w-full"
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Tell us why FanFunnel's a fit"
          />
        </Field>
        <p className="text-[11px] text-muted">* required</p>
      </div>

      {error && <p className="mt-3 text-center text-sm text-amber-300">{error}</p>}

      <button
        onClick={submit}
        disabled={busy || !ready}
        className="btn-brand mt-5 w-full rounded-2xl py-3 font-bold disabled:opacity-50"
      >
        {busy ? "Submitting…" : "Submit request"}
      </button>

      <form action="/auth/signout" method="post" className="mt-3 text-center">
        <button className="text-xs font-semibold text-muted transition hover:text-ink">
          Sign out
        </button>
      </form>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted">
        {label}
      </span>
      {children}
    </label>
  );
}
