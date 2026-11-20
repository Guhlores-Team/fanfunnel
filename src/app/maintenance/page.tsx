import type { Metadata } from "next";
import { brandVars, DEFAULT_BRAND } from "@/lib/theme";
import { LEGAL } from "@/lib/legal";

// OPS-12: what fans and visitors see while FF_MAINTENANCE=1 (next.config.ts
// rewrites every public page here). Static: no database, no session.
export const metadata: Metadata = { title: "Back soon · FanFunnel", robots: { index: false, follow: false } };

export default function Maintenance() {
  return (
    <main className="grain brand-glow relative flex min-h-[100dvh] flex-col items-center justify-center px-5 py-10" style={brandVars(DEFAULT_BRAND)}>
      <div className="relative z-[1] w-full max-w-md text-center">
        <div className="card rounded-[1.75rem] p-8">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand">Short break</p>
          <h1 className="mt-2 font-[family-name:var(--font-display)] text-2xl font-extrabold text-ink">We&rsquo;ll be back soon</h1>
          <p className="mt-3 text-sm text-muted text-pretty">
            FanFunnel is paused for a few minutes of maintenance. Nothing was spent: your spins, prizes and balance are exactly as you left them.
          </p>
          <p className="mt-3 text-sm text-muted text-pretty">Try your link again in a little while.</p>
          <p className="mt-5 text-xs text-muted">
            Questions? <a className="font-semibold text-ink underline underline-offset-4" href={`mailto:${LEGAL.contactEmail}`}>{LEGAL.contactEmail}</a>
          </p>
        </div>
      </div>
    </main>
  );
}
