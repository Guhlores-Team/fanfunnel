import { redirect } from "next/navigation";
import { isSupabaseConfigured, createClient } from "@/lib/supabase/server";
import AgencyClient from "@/components/agency/AgencyClient";
import { brandVars } from "@/lib/theme";

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
    <main className="min-h-[100dvh] overflow-x-clip bg-canvas text-ink" style={brandVars("#ec4899")}>
      <AgencyClient />
    </main>
  );
}
