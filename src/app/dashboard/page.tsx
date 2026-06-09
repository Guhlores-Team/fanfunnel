import type { CSSProperties } from "react";
import { redirect } from "next/navigation";
import DashboardClient from "@/components/dashboard/DashboardClient";
import { isSupabaseConfigured, createClient } from "@/lib/supabase/server";
import { getWheel, getMyApprovalStatus, getOnboardingDismissed } from "@/lib/data";
import { SAMPLE_WHEEL } from "@/lib/games/wheel/sample";

// Creator/admin dashboard. With Supabase configured the middleware guards this
// route and we resolve the signed-in user; otherwise it's an open demo.
export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  let isAdmin = false;
  let email: string | null = null;

  if (isSupabaseConfigured()) {
    const sb = await createClient();
    const {
      data: { user },
    } = await sb.auth.getUser();
    if (user) {
      email = user.email ?? null;
      const { data: profile } = await sb
        .from("profiles")
        .select("role")
        .eq("id", user.id)
        .maybeSingle();
      isAdmin = profile?.role === "admin";
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

  return (
    <main
      className="min-h-[100dvh] overflow-x-clip bg-base"
      style={{ "--brand": initialWheel.brandColor ?? "#ec4899" } as CSSProperties}
    >
      <DashboardClient
        isAdmin={isAdmin}
        email={email}
        initialWheel={initialWheel}
        initialOnboardingDismissed={onboardingDismissed}
      />
    </main>
  );
}
