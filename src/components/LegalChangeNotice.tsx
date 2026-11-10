import { LEGAL, activeLegalChangeNotice, formatLegalDate } from "@/lib/legal";

/**
 * TS-06: the notice the Terms and Privacy Policy promise before a material
 * change. Renders nothing unless LEGAL.upcoming announces a later version
 * whose effective date is still ahead; then one short line with the date and
 * a link to the current text, on every fan-facing page (through LegalLinks)
 * and in the dashboard. Plain component with no hooks, so it works in server
 * and client trees alike.
 */
export default function LegalChangeNotice({ className = "" }: { className?: string }) {
  const notice = activeLegalChangeNotice();
  if (!notice) return null;
  return (
    <p
      role="status"
      data-testid="legal-change-notice"
      className={`rounded-xl border border-line bg-surface px-3 py-2 text-center text-[12px] leading-relaxed text-muted ${className}`}
    >
      <strong className="text-ink">Our Terms and Privacy Policy change on {formatLegalDate(notice.effectiveDate)}.</strong>{" "}
      {notice.summary} The current text is at{" "}
      <a href="/terms" className="underline underline-offset-4 hover:text-ink">
        /terms
      </a>{" "}
      and{" "}
      <a href="/privacy" className="underline underline-offset-4 hover:text-ink">
        /privacy
      </a>
      ; {LEGAL.operator} will ask you to agree to the new version when it takes effect.
    </p>
  );
}
