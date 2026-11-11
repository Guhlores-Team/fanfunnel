import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { isSupabaseConfigured, createClient } from "@/lib/supabase/server";
import { getMyApprovalStatus, getMyCreatorApplication, getMyRejectionReason } from "@/lib/data";
import { canSendAccountEmail } from "@/lib/account/accountMail";
import { rejectionReasonText } from "@/lib/onboarding/rejectionReasons";
import { brandVars } from "@/lib/theme";
import PendingClient from "@/components/PendingClient";
import { pendingSelfDeleteAllowed } from "@/lib/account/pendingSelfDelete";
import SessionNotices from "@/components/auth/SessionNotices";
import { sessionNoticeQuery, type SessionNoticeParams } from "@/lib/auth/linkNotice";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Your creator request · FanFunnel", robots: { index: false, follow: false } };

// b6 C9 / WC-07: the name typed at sign-up (profiles.display_name, set by the
// sign-up trigger; the own row is readable under RLS) pre-fills the request.
// Older rows hold the e-mail instead of a name; the page treats that as blank.
async function readSignupName(sb: Awaited<ReturnType<typeof createClient>>, userId: string): Promise<string | null> {
  try {
    const { data } = await sb.from("profiles").select("display_name").eq("id", userId).maybeSingle();
    const name = (data as { display_name?: string | null } | null)?.display_name;
    return typeof name === "string" ? name.trim() : null;
  } catch {
    return null;
  }
}

// Where signed-in-but-not-approved creators land. Approved users are bounced to
// the dashboard; signed-out users to login.
export default async function PendingPage({
  searchParams,
}: {
  searchParams: Promise<{ [K in keyof SessionNoticeParams]?: string | string[] }>;
}) {
  if (!isSupabaseConfigured()) redirect("/dashboard"); // demo has no gate
  // A4 / A6: the fixed-text notice flags (see SessionNotices); they follow an
  // approved account on to the dashboard.
  const raw = await searchParams;
  const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);
  const notices: SessionNoticeParams = { switched: one(raw.switched), auth_link: one(raw.auth_link), type: one(raw.type) };

  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) redirect("/login?next=/pending");

  const status = await getMyApprovalStatus();
  if (status === "approved") redirect("/dashboard" + sessionNoticeQuery(notices));
  const rejected = status === "rejected";
  const [application, reasonCode, profile] = await Promise.all([
    rejected ? null : getMyCreatorApplication(),
    rejected ? getMyRejectionReason() : null,
    rejected ? null : readSignupName(sb, user.id),
  ]);
  const signupName = profile && profile !== user.email && !profile.includes("@") ? profile : "";

  return (
    <main
      className="grain brand-glow relative flex min-h-[100dvh] flex-col items-center justify-center px-5 py-10"
      style={brandVars("#ec4899")}
    >
      <div className="relative z-[1] w-full max-w-md">
        <SessionNotices email={user.email ?? null} params={notices} variant="card" dismissHref="/pending" />
        <PendingClient
          status={rejected ? "rejected" : "pending"}
          email={user.email ?? ""}
          application={
            application && application.status === "pending"
              ? {
                  displayName: application.displayName,
                  socials: application.socials,
                  audienceSize: application.audienceSize,
                  note: application.note,
                  createdAt: application.createdAt,
                }
              : null
          }
          canEmail={canSendAccountEmail()}
          rejectionReason={rejectionReasonText(reasonCode)}
          canSelfDelete={pendingSelfDeleteAllowed(status)}
          signupName={signupName}
        />
      </div>
    </main>
  );
}
