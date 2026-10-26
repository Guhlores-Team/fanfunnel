import { redirect } from "next/navigation";
import { brandVars } from "@/lib/theme";
import DashboardClient from "@/components/dashboard/DashboardClient";
import { resolveSection } from "@/components/dashboard/dashboardSection";
import { isSupabaseConfigured, createClient } from "@/lib/supabase/server";
import { checkAdmin } from "@/lib/auth/admin";
import { getWheel, getMyApprovalStatus, getOnboardingDismissed } from "@/lib/data";
import { SAMPLE_WHEEL } from "@/lib/games/wheel/sample";

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
  let email: string | null = null;

  if (isSupabaseConfigured()) {
    const sb = await createClient();
    const {
      data: { user },
    } = await sb.auth.getUser();
    if (user) {
      email = user.email ?? null;
      // The Admin section is server-gated on is_admin() (role AND is_active),
      // the same predicate every /api/admin route re-checks (AGENTS.md rules 1-2).
      isAdmin = (await checkAdmin(sb)).status === "admin";
    }

    // Gate: only approved creators (and admins) reach the dashboard. Pending /
    // rejected requesters are sent to the review-status page.
    const status = await getMyApprovalStatus();
    if (status !== "approved") redirect("/pending");
  }

  const [wheelResult, onboardingDismissed, params] = await Promise.all([
    getWheel(),
    getOnboardingDismissed(),
    searchParams,
  ]);
  const initialWheel = wheelResult ?? SAMPLE_WHEEL;
  // ?section= deep link (the /admin route redirects to ?section=admin).
  const initialTab = resolveSection(params.section, isAdmin);

  return (
    <main
      className="min-h-[100dvh] overflow-x-clip bg-base"
      style={brandVars(initialWheel.brandColor)}
    >
      <DashboardClient
        isAdmin={isAdmin}
        email={email}
        initialWheel={initialWheel}
        initialOnboardingDismissed={onboardingDismissed}
        initialTab={initialTab}
      />
    </main>
  );
}
