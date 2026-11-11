"use client";
import { creatorMfaRecoveryHref } from "@/lib/auth/creatorMfaRecovery";
/** A separate tab keeps unresolved operations/drafts in the original tab.
 * Shared auth cookies are upgraded; no form contents are stored or retried. */
export default function CreatorMfaRecovery({required,destination}:{required:boolean;destination:"settings"|"reset"|"admin"}) {
  if (!required) return null;
  return <div role="alert" className="mt-3 rounded-xl border border-line bg-surface p-3 text-sm text-ink">
    <p>Verify in a new tab, then return here and submit this change again.</p>
    <a className="mt-2 inline-flex min-h-11 items-center font-semibold underline underline-offset-4" href={creatorMfaRecoveryHref(destination)} target="_blank" rel="noopener noreferrer">Verify with your authenticator (new tab)</a>
  </div>;
}
