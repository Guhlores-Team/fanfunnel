import { Suspense } from "react";
import Link from "next/link";
import LoginForm from "@/components/LoginForm";
import { isSupabaseConfigured } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default function LoginPage() {
  const configured = isSupabaseConfigured();

  return (
    <main className="flex min-h-screen items-center justify-center bg-gradient-to-b from-zinc-950 via-zinc-900 to-black px-4">
      <div className="w-full max-w-sm">
        <Link
          href="/"
          className="mb-6 block text-center text-2xl font-extrabold text-white"
        >
          🎡 FanFunnel
        </Link>

        {configured ? (
          <Suspense>
            <LoginForm />
          </Suspense>
        ) : (
          <div className="rounded-2xl border border-white/10 bg-white/5 p-6 text-center text-white">
            <p className="font-bold">Demo mode</p>
            <p className="mt-2 text-sm text-white/60">
              No Supabase configured, so there&apos;s no sign-in needed. Open the
              dashboard directly.
            </p>
            <Link
              href="/dashboard"
              className="mt-4 inline-block rounded-xl bg-pink-600 px-5 py-2.5 font-bold text-white hover:bg-pink-500"
            >
              Open dashboard →
            </Link>
          </div>
        )}
      </div>
    </main>
  );
}
