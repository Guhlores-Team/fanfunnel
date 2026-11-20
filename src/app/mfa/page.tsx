import { redirect } from "next/navigation";
import { isSupabaseConfigured, createClient } from "@/lib/supabase/server";
import { getSessionAssurance } from "@/lib/auth/assurance";
import { safeNext } from "@/lib/auth/safeNext";
import { brandVars } from "@/lib/theme";
import MfaClient from "@/components/auth/MfaClient";

export const dynamic = "force-dynamic";
export const metadata = { title: "Two-factor sign-in · FanFunnel", robots: { index: false } };

// The two-factor step. The proxy sends a user here when their account has a
// verified authenticator but this session hasn't used it (aal1); the admin
// gate sends an admin here to set one up. Demo mode has no accounts or MFA.
export default async function MfaPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[]; reason?: string | string[] }>;
}) {
  if (!isSupabaseConfigured()) redirect("/dashboard");

  const params = await searchParams;
  const next = safeNext(Array.isArray(params.next) ? params.next[0] : params.next);
  const reason = params.reason === "admin" ? "admin" : null;

  const sb = await createClient();
  const { userId, email, assurance } = await getSessionAssurance(sb);
  if (!userId) redirect("/login?next=" + encodeURIComponent("/mfa?next=" + next));
  if (assurance.aal === "aal2") redirect(next);

  return (
    <main
      className="grain brand-glow relative flex min-h-[100dvh] flex-col items-center justify-center overflow-x-clip px-4 py-10"
      style={brandVars("#ec4899")}
    >
      <div className="relative z-[1] w-full max-w-md">
        <MfaClient
          mode={assurance.hasVerifiedFactor ? "challenge" : "enrol"}
          next={next}
          reason={reason}
          email={email}
        />
      </div>
    </main>
  );
}
