import type { Metadata } from "next";
import Link from "next/link";
import { brandVars, DEFAULT_BRAND } from "@/lib/theme";

// Branded 404 for dead/expired fan links (spin/[token], c/[slug], share/[shareId]
// all call notFound()) and any unmatched route. Mirrors the branded empty-state
// in verify/[shareId]/page.tsx so a stale link lands somewhere on-brand instead
// of Next.js's bare white 404.
export const metadata: Metadata = { title: "Link not found · FanFunnel" };

export default function NotFound() {
  return (
    <main
      className="grain brand-glow relative flex min-h-[100dvh] flex-col items-center justify-center px-5 py-10"
      style={brandVars(DEFAULT_BRAND)}
    >
      <div className="relative z-[1] w-full max-w-md">
        <div className="card rounded-[1.75rem] p-8 text-center">
          <div className="text-5xl">🎡</div>
          <h1 className="mt-4 font-[family-name:var(--font-display)] text-xl font-extrabold text-ink">
            This link isn&rsquo;t active
          </h1>
          <p className="mt-3 text-sm text-muted text-pretty">
            The page or prize link you followed has expired or doesn&rsquo;t
            exist. Ask your creator for a fresh link &mdash; your spins are safe
            on your account.
          </p>
          <Link
            href="/"
            className="btn-brand mt-6 inline-flex items-center justify-center rounded-full px-5 py-2.5 text-sm font-semibold"
          >
            Go to FanFunnel
          </Link>
        </div>
      </div>
      <footer className="relative z-[1] mt-8 text-[11px] tracking-wide text-muted/70">
        Powered by FanFunnel
      </footer>
    </main>
  );
}
