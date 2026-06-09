import Link from "next/link";
import type { CSSProperties } from "react";
import { isSupabaseConfigured } from "@/lib/supabase/server";
import { SAMPLE_WHEEL } from "@/lib/games/wheel/sample";
import Wheel from "@/components/Wheel";

// Landing sells FanFunnel to creators (fans never see this; they get direct
// links). Brand register: expressive, display type, brand glow.
export default function Home() {
  const live = isSupabaseConfigured();
  const brand = SAMPLE_WHEEL.brandColor ?? "#ec4899";

  return (
    <main
      className="grain brand-glow relative flex min-h-[100dvh] flex-col"
      style={{ "--brand": brand } as CSSProperties}
    >
      <nav className="relative z-[1] mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-6">
        <span className="font-[family-name:var(--font-display)] text-lg font-extrabold tracking-tight text-ink">
          FanFunnel
        </span>
        <Link
          href="/login"
          className="rounded-lg border border-line px-3.5 py-1.5 text-sm font-medium text-muted transition hover:text-ink"
        >
          Creator sign in
        </Link>
      </nav>

      <section className="relative z-[1] mx-auto grid w-full max-w-6xl flex-1 items-center gap-12 px-6 pb-16 pt-6 lg:grid-cols-[1.1fr_0.9fr]">
        <div>
          <p className="reveal text-sm font-medium text-[var(--brand)]" style={{ animationDelay: "0.05s" }}>
            Personalized prize games for creators
          </p>
          <h1 className="reveal mt-4 font-[family-name:var(--font-display)] text-[clamp(2.6rem,7vw,4.5rem)] font-extrabold leading-[0.98] tracking-[-0.03em] text-ink text-balance" style={{ animationDelay: "0.12s" }}>
            Every fan gets their own wheel.
          </h1>
          <p className="reveal mt-5 max-w-md text-lg leading-relaxed text-muted text-pretty" style={{ animationDelay: "0.2s" }}>
            Fans tip you on the platform you already use. You grant spins and send
            a private link. Every spin wins something, and the rare drops are what
            pull them back.
          </p>

          <div className="reveal mt-9 flex flex-wrap items-center gap-3" style={{ animationDelay: "0.28s" }}>
            <Link
              href="/dashboard"
              className="btn-brand rounded-xl px-6 py-3 text-base font-bold"
            >
              {live ? "Open your dashboard" : "Open the dashboard"}
            </Link>
            {!live && (
              <Link
                href="/spin/demo"
                className="rounded-xl border border-line px-6 py-3 text-base font-semibold text-ink transition hover:bg-surface"
              >
                Try a live wheel
              </Link>
            )}
          </div>

          {/* Value props: editorial row with hairlines, not identical cards. */}
          <dl className="reveal mt-14 grid gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-3" style={{ animationDelay: "0.36s" }}>
            {[
              ["Private fan links", "Each fan has their own link and their own spin balance."],
              ["You set the odds", "Tune rarity and limited stock so the best prizes feel rare."],
              ["No gambling, no fees", "Tips happen on-platform; every spin yields a guaranteed reward."],
            ].map(([t, d]) => (
              <div key={t} className="bg-base p-5">
                <dt className="text-sm font-semibold text-ink">{t}</dt>
                <dd className="mt-1.5 text-sm leading-relaxed text-muted">{d}</dd>
              </div>
            ))}
          </dl>
        </div>

        {/* Live product as the hero visual — shown on mobile too (smaller) so
            phone visitors actually see what the product is. */}
        <div className="reveal-scale relative mt-10 flex items-center justify-center lg:mt-0" style={{ animationDelay: "0.3s" }}>
          <div
            aria-hidden
            className="ambient-glow pointer-events-none absolute h-[90%] w-[90%] rounded-full blur-3xl"
            style={{
              background:
                "radial-gradient(circle, color-mix(in oklab, var(--brand) 32%, transparent), transparent 65%)",
            }}
          />
          <div className="ambient-float relative">
            <div className="lg:hidden">
              <Wheel prizes={SAMPLE_WHEEL.prizes} brandColor={brand} result={null} size={260} />
            </div>
            <div className="hidden lg:block">
              <Wheel prizes={SAMPLE_WHEEL.prizes} brandColor={brand} result={null} size={360} />
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
