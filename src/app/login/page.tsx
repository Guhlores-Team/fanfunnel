import type { Metadata } from "next";
import Link from "next/link";
import LoginForm from "@/components/LoginForm";
import AuthShell from "@/components/auth/AuthShell";
import AuthLinkNotice from "@/components/auth/AuthLinkNotice";
import LoginNotices, { readLoginParams } from "@/components/auth/LoginNotices";
import { isSupabaseConfigured } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type Search = Promise<Record<string, string | string[] | undefined>>;

// WU-13 / WA-07: a title of its own per mode, so tabs and screen readers can
// tell the auth pages apart.
export async function generateMetadata({ searchParams }: { searchParams: Search }): Promise<Metadata> {
  const params = readLoginParams(await searchParams);
  return { title: params.mode === "signup" ? "Create your login · FanFunnel" : "Sign in · FanFunnel", robots: { index: false, follow: false } };
}

export default async function LoginPage({ searchParams }: { searchParams: Search }) {
  const params = readLoginParams(await searchParams);
  const configured = isSupabaseConfigured();

  return (
    <AuthShell>
      {configured ? (
        <LoginForm params={params} />
      ) : (
        <div className="rounded-2xl border border-white/10 bg-white/5 p-6 text-center text-white">
          <h1 className="font-bold">Demo mode</h1>
          <p className="mt-2 text-sm text-white/60">
            No Supabase configured, so there&apos;s no sign-in needed. Open the dashboard directly.
          </p>
          <div className="text-left">
            <LoginNotices params={params} />
            {params.error === "auth_link" && <AuthLinkNotice type={params.type ?? null} reason={params.reason ?? null} email="" canResend={false} />}
          </div>
          <Link
            href="/dashboard"
            className="mt-4 inline-flex min-h-11 items-center rounded-xl btn-brand px-5 py-2.5 font-bold"
          >
            Open dashboard →
          </Link>
        </div>
      )}
    </AuthShell>
  );
}
