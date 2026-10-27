import Link from "next/link";
import type { ReactNode } from "react";
import { brandVars, DEFAULT_BRAND } from "@/lib/theme";

// Shared shell for /terms and /privacy. Both are PLACEHOLDER drafts until the
// owner supplies reviewed legal text; the banner says so on every render.
export default function LegalPage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="grain relative min-h-[100dvh] px-5 py-10" style={brandVars(DEFAULT_BRAND)}>
      <article className="relative z-[1] mx-auto w-full max-w-2xl">
        <p
          role="note"
          className="mb-6 rounded-xl border border-[#f59e0b]/40 bg-[#f59e0b]/10 px-4 py-3 text-sm text-ink"
        >
          <strong>Draft placeholder.</strong> This page is not final legal text and will be replaced
          before FanFunnel launches publicly.
        </p>
        <h1 className="font-[family-name:var(--font-display)] text-3xl font-extrabold tracking-tight text-ink">
          {title}
        </h1>
        <div className="mt-6 space-y-5 text-[15px] leading-relaxed text-muted [&_h2]:mt-8 [&_h2]:text-lg [&_h2]:font-bold [&_h2]:text-ink [&_li]:ml-5 [&_li]:list-disc">
          {children}
        </div>
        <nav aria-label="Legal" className="mt-10 flex gap-5 border-t border-line pt-5 text-sm">
          <Link href="/terms" className="text-ink underline underline-offset-4">
            Terms of Service
          </Link>
          <Link href="/privacy" className="text-ink underline underline-offset-4">
            Privacy Policy
          </Link>
          <Link href="/" className="text-muted underline underline-offset-4">
            FanFunnel home
          </Link>
        </nav>
      </article>
    </main>
  );
}
