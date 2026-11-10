import type { Metadata } from "next";
import { redirect } from "next/navigation";
import Link from "next/link";
import AuthShell from "@/components/auth/AuthShell";
import { authLinkFailurePath, parseTokenLink } from "@/lib/auth/authLink";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Continue to FanFunnel", robots: { index: false, follow: false } };

const HEADLINE: Record<string, { title: string; body: string; cta: string }> = {
  recovery: { title: "Reset your password", body: "Tap Continue to choose a new password for your FanFunnel account.", cta: "Continue to reset my password" },
  invite: { title: "Accept your invitation", body: "Tap Continue to set a password and open your new FanFunnel account.", cta: "Continue and set my password" },
  email_change: { title: "Confirm your e-mail change", body: "Tap Continue to confirm this address for your FanFunnel account.", cta: "Continue and confirm" },
  magiclink: { title: "Sign in to FanFunnel", body: "Tap Continue to sign in. No password needed.", cta: "Continue and sign in" },
  email: { title: "Confirm your e-mail", body: "Tap Continue to confirm your e-mail address and carry on with your creator request.", cta: "Continue and confirm" },
  signup: { title: "Confirm your e-mail", body: "Tap Continue to confirm your e-mail address and carry on with your creator request.", cta: "Continue and confirm" },
};

/**
 * Target of every e-mail template link: {{ .SiteURL }}/auth/confirm with
 * `token_hash` + `type` + a fixed `next` (never built from .RedirectTo; see
 * supabase/templates/README.md). This page spends nothing: it shows a button
 * whose form POSTs the token to /auth/confirm/verify, so a mail scanner or
 * link preview that fetches the URL cannot consume the one-time link
 * (WU-02 / WA-05). No script auto-submits it: sandboxes run scripts too.
 */
export default async function ConfirmLandingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(raw)) if (typeof v === "string") params.set(k, v);
  // A legacy PKCE link that was pointed here: the callback route exchanges it.
  if (params.get("code") && !params.has("token_hash")) {
    const cb = new URLSearchParams({ code: params.get("code")! });
    if (params.get("next")) cb.set("next", params.get("next")!);
    if (params.get("type")) cb.set("type", params.get("type")!);
    redirect(`/auth/callback?${cb}`);
  }
  const link = parseTokenLink(params);
  if (!link) redirect(authLinkFailurePath(params.get("type"), "malformed"));
  const copy = HEADLINE[link.type] ?? HEADLINE.email;

  return (
    <AuthShell>
      <form method="post" action="/auth/confirm/verify" className="rounded-2xl border border-white/10 bg-white/5 p-6 text-white" data-testid="auth-continue">
        <h1 className="text-lg font-bold">{copy.title}</h1>
        <p className="mt-2 text-sm text-white/60">{copy.body}</p>
        <input type="hidden" name="token_hash" value={link.tokenHash} />
        <input type="hidden" name="type" value={link.type} />
        <input type="hidden" name="next" value={link.next} />
        <button
          type="submit"
          className="mt-5 inline-flex min-h-11 w-full items-center justify-center rounded-xl bg-pink-600 px-4 py-2.5 font-bold text-white hover:bg-pink-500"
        >
          {copy.cta} →
        </button>
        <p className="mt-4 text-xs text-white/50">
          This link works once, on any device, and expires 1 hour after it was sent. Nothing happens until you tap the button, so a
          mail app that opened it for you first did no harm.
        </p>
        <p className="mt-3 text-xs text-white/50">
          Didn&rsquo;t ask for this?{" "}
          <Link href="/login" className="font-semibold text-white underline underline-offset-4">
            Go to sign in
          </Link>{" "}
          instead.
        </p>
      </form>
    </AuthShell>
  );
}
