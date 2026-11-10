import { LEGAL } from "@/lib/legal";
import LegalLinks from "@/components/LegalLinks";

/**
 * WF-03: the address is over its link-attempt budget (someone behind the same
 * carrier, campus or event address guessed too many links). An honest page
 * with the wait, instead of telling a real fan their link is mistyped.
 */
export default function LinkAttemptsBlocked({ retrySeconds }: { retrySeconds: number | null }) {
  const wait = retrySeconds && retrySeconds > 0 ? (retrySeconds >= 90 ? `${Math.ceil(retrySeconds / 60)} minutes` : `${retrySeconds} seconds`) : "a minute";
  return (
    <main className="grain brand-glow relative flex min-h-[100dvh] flex-col items-center justify-center px-5 py-10" data-testid="link-attempts-blocked">
      <div className="card relative z-[1] w-full max-w-sm rounded-2xl p-6 text-center">
        <span aria-hidden="true" className="text-3xl">⏳</span>
        <h1 className="mt-3 text-lg font-bold text-ink">Too many link attempts from your network</h1>
        <p className="mt-2 text-sm text-muted text-pretty">
          Someone on your connection tried a lot of links that don&rsquo;t exist, so link lookups from it are paused for{" "}
          <span className="font-semibold text-ink" data-testid="link-attempts-retry">{wait}</span>. Your link is not gone: try it again after that.
        </p>
        <p className="mt-3 text-xs text-muted text-pretty">
          Still stuck? Ask your creator to send the link again, or write to{" "}
          <a href={`mailto:${LEGAL.contactEmail}`} className="text-ink underline underline-offset-2">{LEGAL.contactEmail}</a>.
        </p>
      </div>
      <LegalLinks className="relative z-[1] mt-6" />
    </main>
  );
}
