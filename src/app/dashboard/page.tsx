import { redirect } from "next/navigation";
import { brandVars } from "@/lib/theme";
import DashboardClient from "@/components/dashboard/DashboardClient";
import AppServiceWorker from "@/components/pwa/AppServiceWorker";
import { resolveSection } from "@/components/dashboard/dashboardSection";
import { isSupabaseConfigured, createClient } from "@/lib/supabase/server";
import { checkAdmin } from "@/lib/auth/admin";
import { getWheel, getMyApprovalStatus, getOnboardingDismissed } from "@/lib/data";
import { SAMPLE_WHEEL } from "@/lib/games/wheel/sample";
import AdminMfaBanner from "@/components/auth/AdminMfaBanner";

// Creator/admin dashboard. With Supabase configured the middleware guards this
// route and we resolve the signed-in user; otherwise it's an open demo.
export const dynamic = "force-dynamic";

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ section?: string | string[] }>;
}) {
  // The shell's Admin section is decided here, on the server, and nowhere else:
  // an ACTIVE admin per is_admin() (via checkAdmin), or demo mode (no Supabase,
  // no accounts; the admin APIs serve the mock there too).
  let isAdmin = !isSupabaseConfigured();
  let adminNeedsMfa = false;
  let email: string | null = null;
  const params = await searchParams;

  if (isSupabaseConfigured()) {
    const sb = await createClient();
    const {
      data: { user },
    } = await sb.auth.getUser();
    if (user) {
      email = user.email ?? null;
      // The Admin section is server-gated on is_admin() (role AND is_active),
      // the same predicate every /api/admin route re-checks (AGENTS.md rules 1-2),
      // on a two-factor (aal2) session.
      const access = await checkAdmin(sb);
      isAdmin = access.status === "admin";
      adminNeedsMfa = access.status === "mfa_required";
      // An admin heading for the Admin section without two-factor is sent to
      // set it up (or enter a code) first; the rest of the dashboard stays open.
      if (adminNeedsMfa && params.section === "admin") {
        redirect("/mfa?reason=admin&next=" + encodeURIComponent("/dashboard?section=admin"));
      }
    }

    // Gate: only approved creators (and admins) reach the dashboard. Pending /
    // rejected requesters are sent to the review-status page.
    const status = await getMyApprovalStatus();
    if (status !== "approved") redirect("/pending");
  }

  const [wheelResult, onboardingDismissed] = await Promise.all([
    getWheel(),
    getOnboardingDismissed(),
  ]);
  const initialWheel = wheelResult ?? SAMPLE_WHEEL;
  // ?section= deep link (the /admin route redirects to ?section=admin).
  const initialTab = resolveSection(params.section, isAdmin);

  return (
    <main
      className="min-h-[100dvh] overflow-x-clip bg-base"
      style={brandVars(initialWheel.brandColor)}
    >
      {adminNeedsMfa && <AdminMfaBanner />}
      <DashboardClient
        isAdmin={isAdmin}
        email={email}
        initialWheel={initialWheel}
        initialOnboardingDismissed={onboardingDismissed}
        initialTab={initialTab}
      />
      <AppServiceWorker />
    </main>
  );
}
