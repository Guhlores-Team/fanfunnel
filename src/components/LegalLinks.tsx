import Link from "next/link";

/**
 * T11: the Terms and Privacy links every fan-facing and public page carries.
 * Small, muted and wrapped for a phone; each link keeps a 44px tap target
 * (WF-08). `landmark={false}` renders a plain group for a second copy inside a
 * dialog, so a page never has two "Legal" navigation landmarks (PA-12).
 */
export default function LegalLinks({ className = "", landmark = true }: { className?: string; landmark?: boolean }) {
  const links = (
    <>
      <Link href="/terms" className="inline-flex min-h-11 items-center px-1 underline-offset-4 hover:text-ink hover:underline">
        Terms
      </Link>
      <span aria-hidden="true">·</span>
      <Link href="/privacy" className="inline-flex min-h-11 items-center px-1 underline-offset-4 hover:text-ink hover:underline">
        Privacy
      </Link>
    </>
  );
  const classes = `flex flex-wrap items-center justify-center gap-x-2 text-xs text-muted ${className}`;
  return landmark ? <nav aria-label="Legal" className={classes}>{links}</nav> : <div className={classes}>{links}</div>;
}
