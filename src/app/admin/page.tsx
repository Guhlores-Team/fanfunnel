import { redirect } from "next/navigation";
import AdminClient from "@/components/admin/AdminClient";
import AdminClaim from "@/components/admin/AdminClaim";
import { isSupabaseConfigured, createClient } from "@/lib/supabase/server";

// Admin-only, cross-account control panel. Open in demo mode; role-gated in
// production (middleware ensures a session; this checks the admin role).
export const dynamic = "force-dynamic";

export default async function AdminPage() {
  if (isSupabaseConfigured()) {
    const sb = await createClient();
    const {
      data: { user },
    } = await sb.auth.getUser();
    if (!user) redirect("/login?next=/admin");
    const { data: profile } = await sb
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .maybeSingle();
    if (profile?.role !== "admin") {
      // Not admin yet — offer the env-guarded one-time bootstrap instead of a
      // dead redirect, so the owner can claim admin without touching the DB.
      return (
        <main className="grid min-h-screen place-items-center bg-gradient-to-b from-zinc-950 via-zinc-900 to-black px-5">
          <AdminClaim />
        </main>
      );
    }
  }

  return (
    <main className="min-h-screen bg-gradient-to-b from-zinc-950 via-zinc-900 to-black">
      <AdminClient />
    </main>
  );
}
