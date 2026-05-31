import { redirect } from "next/navigation";
import AdminClient from "@/components/admin/AdminClient";
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
    if (profile?.role !== "admin") redirect("/dashboard");
  }

  return (
    <main className="min-h-screen bg-gradient-to-b from-zinc-950 via-zinc-900 to-black">
      <AdminClient />
    </main>
  );
}
