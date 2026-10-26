import { redirect } from "next/navigation";
import AdminClient from "@/components/admin/AdminClient";
import AdminClaim from "@/components/admin/AdminClaim";
import { isSupabaseConfigured, createClient } from "@/lib/supabase/server";
import { checkAdmin } from "@/lib/auth/admin";

// Admin-only, cross-account control panel. Open in demo mode; gated in
// production on is_admin() (role AND is_active) via the shared checkAdmin().
export const dynamic = "force-dynamic";

export default async function AdminPage() {
  if (isSupabaseConfigured()) {
    const access = await checkAdmin(await createClient());
    if (access.status === "anonymous") redirect("/login?next=/admin");
    // Not an ACTIVE admin (a suspended admin lands here too, never in the panel).
    if (access.status !== "admin") {
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
