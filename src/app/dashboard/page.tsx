import DashboardClient from "@/components/dashboard/DashboardClient";
import { isSupabaseConfigured, createClient } from "@/lib/supabase/server";
import { getWheel } from "@/lib/data";
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
  }

  const initialWheel = (await getWheel()) ?? SAMPLE_WHEEL;

  return (
    <main className="min-h-screen bg-gradient-to-b from-zinc-950 via-zinc-900 to-black">
      <DashboardClient
        isAdmin={isAdmin}
        email={email}
        initialWheel={initialWheel}
      />
    </main>
  );
}
