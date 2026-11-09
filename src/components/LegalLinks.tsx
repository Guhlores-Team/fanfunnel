import Link from "next/link";

/**
 * T11: the Terms and Privacy links every fan-facing and public page carries.
 * Small, muted and wrapped for a phone; each link keeps a 24px tap target.
 */
export default function LegalLinks({ className = "" }: { className?: string }) {
  return (
    <nav aria-label="Legal" className={`flex flex-wrap items-center justify-center gap-x-3 text-[11px] text-muted ${className}`}>
      <Link href="/terms" className="inline-flex min-h-6 items-center underline-offset-4 hover:text-ink hover:underline">
        Terms
      </Link>
      <span aria-hidden="true">·</span>
      <Link href="/privacy" className="inline-flex min-h-6 items-center underline-offset-4 hover:text-ink hover:underline">
        Privacy
      </Link>
    </nav>
  );
}
