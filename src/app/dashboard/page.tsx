import DashboardClient from "@/components/dashboard/DashboardClient";
import { isSupabaseConfigured, createClient } from "@/lib/supabase/server";

// Creator/admin dashboard. When Supabase is configured this resolves the
// signed-in user's role; otherwise it runs as a local demo workspace.
export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  let isAdmin = false;

  if (isSupabaseConfigured()) {
    const sb = await createClient();
    const {
      data: { user },
    } = await sb.auth.getUser();
    if (user) {
      const { data: profile } = await sb
        .from("profiles")
        .select("role")
        .eq("id", user.id)
        .maybeSingle();
      isAdmin = profile?.role === "admin";
    }
  }

  return (
    <main className="min-h-screen bg-gradient-to-b from-zinc-950 via-zinc-900 to-black">
      <DashboardClient isAdmin={isAdmin} />
    </main>
  );
}
