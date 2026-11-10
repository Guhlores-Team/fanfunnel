import { signedInLinkNotice, switchedAccountNotice } from "@/lib/auth/authCopy";
import { LINK_REASONS, OTP_TYPES, type SessionNoticeParams } from "@/lib/auth/linkNotice";

/**
 * Fixed-text notices for a signed-in visitor, rendered on the server above the
 * dashboard ("bar") or the request page ("card"):
 *   ?switched=1                  an e-mail link just switched this browser to
 *                                another account (review A4): names the account
 *                                from the session (`email`), never from the URL
 *   ?auth_link=<reason>&type=…   an e-mail link failed while they were signed in
 *                                (review A6): says why nothing changed
 * The flags only switch sentences on; unknown values show nothing.
 */
export default function SessionNotices({
  email,
  params,
  variant,
  dismissHref,
}: {
  email: string | null;
  params: SessionNoticeParams;
  variant: "bar" | "card";
  /** Where "Dismiss" goes (the same page without the flags). */
  dismissHref: string;
}) {
  const switched = params.switched === "1" && email ? switchedAccountNotice(email) : null;
  const reason = typeof params.auth_link === "string" && LINK_REASONS.has(params.auth_link) ? params.auth_link : null;
  const failed = reason ? signedInLinkNotice(typeof params.type === "string" && OTP_TYPES.has(params.type) ? params.type : null, reason) : null;
  if (!switched && !failed) return null;

  const box =
    variant === "bar"
      ? "border-b border-[#f59e0b]/40 bg-[#f59e0b]/10 px-4 py-2.5 text-center text-[13px] text-[#fde68a]"
      : "mb-4 rounded-2xl border border-amber-300/30 bg-amber-300/10 p-4 text-sm text-amber-100";
  const dismiss = (
    <a href={dismissHref} className="ml-2 inline-flex min-h-11 items-center font-semibold text-ink underline underline-offset-4">
      Dismiss
    </a>
  );
  return (
    <>
      {switched && (
        <div role="status" data-testid="account-switched" className={box}>
          <span className="font-bold text-ink">{switched.title}.</span> <span>{switched.body}</span>
          {dismiss}
        </div>
      )}
      {failed && (
        <div role="status" data-testid="signed-in-link-notice" data-link-reason={reason ?? ""} className={box}>
          <span className="font-bold text-ink">{failed.title}.</span> <span>{failed.body}</span>
          {email && <span> You&rsquo;re signed in as {email}.</span>}
          {dismiss}
        </div>
      )}
    </>
  );
}
