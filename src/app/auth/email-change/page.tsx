import type { Metadata } from "next";
import Link from "next/link";
import AuthShell from "@/components/auth/AuthShell";

export const metadata: Metadata = { title: "One more step · FanFunnel", robots: { index: false, follow: false } };

/**
 * WU-04: with Supabase's "Secure email change" on, BOTH the current and the
 * new address get a link and both must be opened. After the first one the
 * verify answers with no session, so the change is not done yet; this page
 * says so instead of landing on the dashboard as if it were.
 */
export default function EmailChangeHalfPage() {
  return (
    <AuthShell>
      <div className="rounded-2xl border border-white/10 bg-white/5 p-6 text-white" data-testid="email-change-half">
        <p className="text-xs font-semibold uppercase tracking-wider text-pink-300">Step 1 of 2 done</p>
        <h1 className="mt-1 text-lg font-bold">Now open the link in your other inbox</h1>
        <p className="mt-2 text-sm text-white/60">
          Changing the e-mail on a FanFunnel account takes two confirmations: one from the address you had, one from the new
          one. This link is confirmed; the change applies as soon as you open the link we sent to your other address. Until then
          you keep signing in with your current e-mail.
        </p>
        <p className="mt-3 text-sm text-white/60">
          Didn&rsquo;t ask to change your e-mail? Don&rsquo;t open the other link; sign in and change your password from Settings
          › Security.
        </p>
        <Link
          href="/dashboard?section=settings"
          className="mt-5 inline-flex min-h-11 items-center justify-center rounded-xl btn-brand px-5 py-2.5 font-bold"
        >
          Back to my dashboard
        </Link>
      </div>
    </AuthShell>
  );
}
