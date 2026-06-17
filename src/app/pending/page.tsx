import { redirect } from "next/navigation";
import { isSupabaseConfigured, createClient } from "@/lib/supabase/server";
import { getMyApprovalStatus } from "@/lib/data";
import { brandVars } from "@/lib/theme";
import PendingClient from "@/components/PendingClient";

export const dynamic = "force-dynamic";

// Where signed-in-but-not-approved creators land. Approved users are bounced to
// the dashboard; signed-out users to login.
export default async function PendingPage() {
  if (!isSupabaseConfigured()) redirect("/dashboard"); // demo has no gate

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) redirect("/login?next=/pending");

  const status = await getMyApprovalStatus();
  if (status === "approved") redirect("/dashboard");

  return (
    <main
      className="grain brand-glow relative flex min-h-[100dvh] flex-col items-center justify-center px-5 py-10"
      style={brandVars("#ec4899")}
    >
      <div className="relative z-[1] w-full max-w-md">
        <PendingClient
          status={status === "rejected" ? "rejected" : "pending"}
          email={user.email ?? ""}
        />
      </div>
    </main>
  );
}
