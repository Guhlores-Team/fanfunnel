import Link from "next/link";
import type { ReactNode } from "react";
import { brandVars, DEFAULT_BRAND } from "@/lib/theme";
import { LEGAL, formatLegalDate } from "@/lib/legal";

export interface LegalSection {
  /** Anchor id; also the heading's id, so the contents list can link to it. */
  id: string;
  title: string;
  body: ReactNode;
}

/** The legal/privacy contact address as a mailto link. */
export function ContactEmail() {
  return <a href={`mailto:${LEGAL.contactEmail}`}>{LEGAL.contactEmail}</a>;
}

// Shared shell for /terms and /privacy: title, last-updated date, a plain-language
// summary, a contents list, then the numbered sections.
export default function LegalPage({
  title,
  summary,
  sections,
}: {
  title: string;
  summary: ReactNode[];
  sections: LegalSection[];
}) {
  const updated = formatLegalDate(LEGAL.effectiveDate);
  return (
    <main className="grain relative min-h-[100dvh] px-5 py-10" style={brandVars(DEFAULT_BRAND)}>
      <article className="relative z-[1] mx-auto w-full max-w-2xl [overflow-wrap:anywhere]">
        <h1 className="font-[family-name:var(--font-display)] text-3xl font-extrabold tracking-tight text-ink">
          {title}
        </h1>
        <p className="mt-2 text-sm text-muted">
          Last updated <time dateTime={LEGAL.effectiveDate}>{updated}</time>
        </p>

        <section
          aria-labelledby="legal-summary"
          className="mt-6 rounded-2xl border border-line bg-surface px-5 py-4"
        >
          <h2 id="legal-summary" className="text-base font-bold text-ink">
            The short version
          </h2>
          <ul className="mt-3 space-y-2 text-[15px] leading-relaxed text-ink [&_a]:underline [&_a]:underline-offset-4">
            {summary.map((item, i) => (
              <li key={i} className="ml-5 list-disc">
                {item}
              </li>
            ))}
          </ul>
          <p className="mt-3 text-[13px] text-muted">
            This summary is here to help you read the full text below. The full text is what applies.
          </p>
        </section>

        <nav aria-label="Contents" className="mt-6 text-sm">
          <p className="font-semibold text-ink">Contents</p>
          <ol className="mt-2 grid gap-1.5 text-muted sm:grid-cols-2">
            {sections.map((s, i) => (
              <li key={s.id}>
                <a href={`#${s.id}`} className="underline-offset-4 hover:text-ink hover:underline">
                  {i + 1}. {s.title}
                </a>
              </li>
            ))}
          </ol>
        </nav>

        <div className="mt-4 space-y-5 text-[15px] leading-relaxed text-muted [&_a]:text-ink [&_a]:underline [&_a]:underline-offset-4 [&_h2]:mt-10 [&_h2]:scroll-mt-6 [&_h2]:text-lg [&_h2]:font-bold [&_h2]:text-ink [&_h3]:mt-6 [&_h3]:font-semibold [&_h3]:text-ink [&_li]:ml-5 [&_li]:list-disc [&_li+li]:mt-1.5 [&_strong]:text-ink">
          {sections.map((s, i) => (
            <section key={s.id} aria-labelledby={s.id} className="space-y-4">
              <h2 id={s.id}>
                {i + 1}. {s.title}
              </h2>
              {s.body}
            </section>
          ))}
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
