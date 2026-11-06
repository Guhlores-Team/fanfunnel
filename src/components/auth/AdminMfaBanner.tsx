import Link from "next/link";

/**
 * Shown above the dashboard to an admin whose session hasn't done two-factor
 * (the server decided: checkAdmin → mfa_required). The Admin section stays
 * hidden until they do; everything else works as before.
 */
export default function AdminMfaBanner() {
  return (
    <div
      role="status"
      className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b border-[#f59e0b]/40 bg-[#f59e0b]/10 px-4 py-2 text-center text-[13px] text-[#fde68a]"
    >
      <span>Admin tools need two-factor sign-in.</span>
      <Link
        href={"/mfa?reason=admin&next=" + encodeURIComponent("/dashboard?section=admin")}
        className="font-semibold text-ink underline underline-offset-4"
      >
        Set it up now
      </Link>
    </div>
  );
}
