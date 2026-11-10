import Link from "next/link";
import { redirect } from "next/navigation";
import AdminClaim from "@/components/admin/AdminClaim";
import { isSupabaseConfigured, createClient } from "@/lib/supabase/server";
import { checkAdmin } from "@/lib/auth/admin";

// Admin is a section inside the dashboard shell ("Account › Admin"). /admin
// stays as the deep link: gated here on is_admin() (role AND is_active) via
// the shared checkAdmin(), then sent into the shell's Admin section. In demo
// mode (no Supabase) the panel is open, as before.
export const dynamic = "force-dynamic";

export default async function AdminPage() {
  if (isSupabaseConfigured()) {
    const access = await checkAdmin(await createClient());
    if (access.status === "anonymous") redirect("/login?next=/admin");
    // An admin whose session hasn't done two-factor: enrol or enter a code first.
    if (access.status === "mfa_required") redirect("/mfa?reason=admin&next=/admin");
    // Not an ACTIVE admin (a suspended admin lands here too, never in the panel).
    if (access.status !== "admin") {
      // Not admin yet — offer the env-guarded one-time bootstrap instead of a
      // dead redirect, so the owner can claim admin without touching the DB.
      // WU-12: only while ADMIN_EMAILS is set (the claim route checks the
      // list); a creator who mistypes a URL gets a plain "not for you" page.
      if (!(process.env.ADMIN_EMAILS ?? "").trim()) {
        return (
          <main className="grid min-h-[100dvh] place-items-center overflow-x-clip bg-base px-4">
            <div className="w-full max-w-sm rounded-2xl border border-[var(--hair)] [background:var(--s1)] px-6 py-8 text-center text-ink shadow-[var(--lift)]">
              <h1 className="text-xl font-bold tracking-[-0.02em]">Admin only</h1>
              <p className="mt-2 text-[13.5px] text-muted">This page is for FanFunnel admins. Your dashboard is where your games live.</p>
              <Link href="/dashboard" className="btn-brand mt-5 inline-flex min-h-11 items-center justify-center rounded-[10px] px-[18px] text-sm font-bold">
                Go to my dashboard
              </Link>
            </div>
          </main>
        );
      }
      return (
        <main className="grid min-h-[100dvh] place-items-center overflow-x-clip bg-base px-4">
          <AdminClaim />
        </main>
      );
    }
  }

  redirect("/dashboard?section=admin");
}
