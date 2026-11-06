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
      return (
        <main className="grid min-h-[100dvh] place-items-center overflow-x-clip bg-base px-4">
          <AdminClaim />
        </main>
      );
    }
  }

  redirect("/dashboard?section=admin");
}
