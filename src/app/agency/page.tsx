import { redirect } from "next/navigation";
import { isSupabaseConfigured, createClient } from "@/lib/supabase/server";
import AgencyClient from "@/components/agency/AgencyClient";

export const dynamic = "force-dynamic";

// Agency console: cross-creator roll-up + seats. Visible to org owners/members.
export default async function AgencyPage() {
  if (isSupabaseConfigured()) {
    const sb = await createClient();
    const {
      data: { user },
    } = await sb.auth.getUser();
    if (!user) redirect("/login?next=/agency");
  }
  return (
    <main className="min-h-screen bg-gradient-to-b from-zinc-950 via-zinc-900 to-black">
      <AgencyClient />
    </main>
  );
}
