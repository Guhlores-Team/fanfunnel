import type { Metadata } from "next";
import Link from "next/link";
import { brandVars, DEFAULT_BRAND } from "@/lib/theme";

// Branded 404 for dead/expired fan links (spin/[token], c/[slug], share/[shareId]
// all call notFound()) and any unmatched route. Leads with a decorative,
// slowly-spinning prize wheel so a stale link still feels on-brand and alive
// rather than dropping the fan on Next.js's bare white 404.
export const metadata: Metadata = { title: "Link not found · FanFunnel" };

// Six brand-leaning slices as a conic gradient — reads as a prize wheel without
// the canvas. Pure CSS so it renders instantly on the error page.
const WHEEL_GRADIENT =
  "conic-gradient(#ec4899 0 60deg,#8b5cf6 60deg 120deg,#3b82f6 120deg 180deg," +
  "#10b981 180deg 240deg,#f59e0b 240deg 300deg,#f43f5e 300deg 360deg)";

export default function NotFound() {
  return (
    <main
      className="grain brand-glow relative flex min-h-[100dvh] flex-col items-center justify-center px-5 py-10"
      style={brandVars(DEFAULT_BRAND)}
    >
      <div className="relative z-[1] w-full max-w-md text-center">
        {/* Decorative spinning wheel */}
        <div className="relative mx-auto mb-9 h-40 w-40" aria-hidden>
          <div
            className="absolute left-1/2 top-[-6px] z-10 -translate-x-1/2"
            style={{
              width: 0,
              height: 0,
              borderLeft: "9px solid transparent",
              borderRight: "9px solid transparent",
              borderTop: "15px solid #fff",
              filter: "drop-shadow(0 1px 2px rgba(0,0,0,0.4))",
            }}
          />
          <div
            className="absolute inset-0 rounded-full motion-safe:animate-[spin_9s_linear_infinite]"
            style={{
              background: WHEEL_GRADIENT,
              boxShadow:
                "0 24px 60px -20px rgba(236,72,153,0.5), inset 0 0 0 4px rgba(255,255,255,0.12)",
            }}
          />
          <div className="absolute inset-[40%] grid place-items-center rounded-full bg-base text-base ring-4 ring-white/15">
            <span className="text-lg">🎡</span>
          </div>
        </div>

        <div className="card rounded-[1.75rem] p-8">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand">
            Error 404
          </p>
          <h1 className="mt-2 font-[family-name:var(--font-display)] text-2xl font-extrabold text-ink">
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
