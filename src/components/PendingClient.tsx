"use client";

import { useState } from "react";
import TermsCheckbox from "@/components/TermsCheckbox";
import { LEGAL } from "@/lib/legal";
import { composeApplicationNote, parseApplicationNote } from "@/lib/onboarding/applicationNote";
import PendingSelfDelete from "@/components/PendingSelfDelete";

/** The stored request, as the server read it (C21). */
export interface PendingApplication {
  displayName: string | null;
  socials: string | null;
  audienceSize: string | null;
  note: string | null;
  createdAt: string;
}

const fmtWhen = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });
};

/**
 * Shown to signed-in creators who aren't approved yet. Pending users submit
 * their creator details once, then see that request (status, when) with an
 * Edit path that updates it (C21); rejected users see a notice, with the
 * admin's reason when one was given (C7). The "we'll e-mail you" promise is
 * only made when the server can send it (`canEmail`, C5).
 */
export default function PendingClient({
  status,
  email,
  application,
  canEmail,
  rejectionReason,
  canSelfDelete = false,
  signupName = "",
}: {
  status: "pending" | "rejected";
  email: string;
  application?: PendingApplication | null;
  canEmail?: boolean;
  rejectionReason?: string | null;
  /** T7: offer "Delete my request and account" (only ever true on /pending). */
  canSelfDelete?: boolean;
  /** The display name typed at sign-up, carried into the request (b6 C9). */
  signupName?: string;
}) {
  const extras = parseApplicationNote(application?.note);
  const [stored, setStored] = useState<PendingApplication | null>(application ?? null);
  const [editing, setEditing] = useState(false);
  const [displayName, setDisplayName] = useState(application?.displayName ?? signupName);
  const [platform, setPlatform] = useState(extras.platform);
  const [socials, setSocials] = useState(application?.socials ?? "");
  const [audienceSize, setAudienceSize] = useState(application?.audienceSize ?? "");
  const [country, setCountry] = useState(extras.country);
  const [referral, setReferral] = useState(extras.referral);
  const [note, setNote] = useState(extras.note);
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [updated, setUpdated] = useState(false);

  // Require the fields we actually vet on (the Terms only on the first submit).
  const ready =
    displayName.trim().length > 1 &&
    socials.trim().length > 3 &&
    platform.trim().length > 0 &&
    audienceSize.trim().length > 0 &&
    (editing || agreed);

  const submit = async () => {
    if (!ready) {
      setError(
        agreed
          ? "Please fill in your name, main platform, links, and audience size."
          : "Please fill in the required fields and agree to the Terms of Service and Privacy Policy."
      );
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // Fold the extra vetting fields into the note so no migration is needed.
      const composedNote = composeApplicationNote({ platform, country, referral, note });
      const res = await fetch("/api/creator-application", {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          editing
            ? { displayName, socials, audienceSize, note: composedNote }
            : { displayName, socials, audienceSize, note: composedNote, acceptTerms: agreed }
        ),
      });
      if (res.status === 409) {
        // Already submitted (another tab or device): never overwrite it.
        setError("You've already sent a request. Reload this page to see and edit it.");
        return;
      }
      if (!res.ok) throw new Error();
      setStored({
        displayName,
        socials,
        audienceSize,
        note: composedNote,
        createdAt: stored?.createdAt ?? new Date().toISOString(),
      });
      setUpdated(editing);
      setEditing(false);
    } catch {
      setError(editing ? "Couldn't save your changes. Try again." : "Couldn't submit. Try again.");
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
          Your request for a FanFunnel creator account wasn&rsquo;t approved.
        </p>
        {rejectionReason && (
          <p data-testid="pending-rejection-reason" className="mt-3 rounded-xl border border-line px-4 py-3 text-sm text-ink text-pretty">
            {rejectionReason}
          </p>
        )}
        <p className="mt-3 text-sm text-muted text-pretty">
          If you think this is a mistake, email{" "}
          <a href={`mailto:${LEGAL.contactEmail}`} className="text-ink underline underline-offset-2">
            {LEGAL.contactEmail}
          </a>
          .
        </p>
        <form action="/auth/signout" method="post" className="mt-6">
          <button className="rounded-lg border border-line px-4 py-2 text-sm font-semibold text-muted transition hover:text-ink">
            Sign out
          </button>
        </form>
        {canSelfDelete && <PendingSelfDelete status="rejected" />}
      </div>
    );
  }

  if (stored && !editing) {
    const shown = parseApplicationNote(stored.note);
    const rows: [string, string][] = [
      ["Name", stored.displayName ?? ""],
      ["Main platform", shown.platform],
      ["Links", stored.socials ?? ""],
      ["Audience", stored.audienceSize ?? ""],
      ["Based in", shown.country],
      ["Heard about us", shown.referral],
      ["Anything else", shown.note],
    ];
    return (
      <div data-testid="pending-request" className="card rounded-2xl p-7">
        <div className="text-center">
          <div className="text-4xl">⏳</div>
          <h1 className="mt-3 font-[family-name:var(--font-display)] text-xl font-extrabold text-ink">
            {updated ? "Request updated" : "Request received"}
          </h1>
          <p className="mt-2 text-sm text-muted">
            <span className="font-semibold text-ink">Waiting for review</span>
            {fmtWhen(stored.createdAt) && <> · submitted {fmtWhen(stored.createdAt)}</>}
          </p>
          <p className="mt-2 text-sm text-muted text-pretty">
            {canEmail ? (
              <>
                We review requests by hand and will email <span className="text-ink">{email}</span> when your account is
                approved.
              </>
            ) : (
              <>
                We review requests by hand. Sign in here again to check: this page opens your dashboard as soon as your
                account is approved.
              </>
            )}
          </p>
          <p className="mt-2 text-xs text-muted text-pretty">
            Added to an agency as staff? Your seat starts working once you&rsquo;re approved.
          </p>
        </div>
        <dl className="mt-5 space-y-2 rounded-xl border border-line px-4 py-3 text-sm">
          {rows
            .filter(([, v]) => v.trim())
            .map(([k, v]) => (
              <div key={k} className="grid grid-cols-[7.5rem_1fr] gap-2">
                <dt className="text-xs font-semibold uppercase tracking-wider text-muted">{k}</dt>
                <dd className="min-w-0 whitespace-pre-line break-words text-ink">{v}</dd>
              </div>
            ))}
        </dl>
        <button
          type="button"
          onClick={() => {
            setEditing(true);
            setUpdated(false);
            setError(null);
          }}
          className="mt-5 w-full rounded-2xl border border-line py-3 text-sm font-bold text-ink transition hover:bg-surface-2"
        >
          Edit request
        </button>
        <form action="/auth/signout" method="post" className="mt-3 text-center">
          <button className="text-xs font-semibold text-muted transition hover:text-ink">Sign out</button>
        </form>
        {canSelfDelete && <PendingSelfDelete status="pending" />}
      </div>
    );
  }

  return (
    <div className="card rounded-2xl p-7">
      <div className="text-center">
        <div className="text-4xl">⏳</div>
        <h1 className="mt-3 font-[family-name:var(--font-display)] text-xl font-extrabold text-ink">
          {editing ? "Edit your request" : "Request creator access"}
        </h1>
        <p className="mt-2 text-sm text-muted text-pretty">
          {editing
            ? "Change anything below and save. Your place in the queue stays the same."
            : "Step 3 of 3: your login is confirmed. FanFunnel creator accounts are approved by hand, and they’re free during the pilot. Tell us about you and we’ll review it shortly."}
        </p>
        <p data-testid="pending-seat-note" className="mt-2 text-xs text-muted text-pretty">
          Joining an agency as staff (chatter, fulfiller, manager)? Request access here
          too. Your agency seat starts working once this account is approved; then
          you&rsquo;ll find it under Agency in your dashboard.
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
            placeholder="Helps us review your request"
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
        {!editing && <TermsCheckbox checked={agreed} onChange={setAgreed} disabled={busy} />}
        <p className="text-[11px] text-muted">* required</p>
      </div>

      {error && <p className="mt-3 text-center text-sm text-amber-300">{error}</p>}

      <button
        onClick={submit}
        disabled={busy || !ready}
        className="btn-brand mt-5 w-full rounded-2xl py-3 font-bold disabled:opacity-50"
      >
        {busy ? (editing ? "Saving…" : "Submitting…") : editing ? "Save changes" : "Submit request"}
      </button>
      {editing && (
        <button
          type="button"
          onClick={() => {
            // Back to the stored request, dropping unsaved changes.
            const x = parseApplicationNote(stored?.note);
            setDisplayName(stored?.displayName ?? "");
            setSocials(stored?.socials ?? "");
            setAudienceSize(stored?.audienceSize ?? "");
            setPlatform(x.platform);
            setCountry(x.country);
            setReferral(x.referral);
            setNote(x.note);
            setEditing(false);
            setError(null);
          }}
          disabled={busy}
          className="mt-2 w-full text-center text-sm font-semibold text-muted transition hover:text-ink"
        >
          Cancel
        </button>
      )}

      <form action="/auth/signout" method="post" className="mt-3 text-center">
        <button className="text-xs font-semibold text-muted transition hover:text-ink">
          Sign out
        </button>
      </form>
      {canSelfDelete && <PendingSelfDelete status="pending" />}
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
