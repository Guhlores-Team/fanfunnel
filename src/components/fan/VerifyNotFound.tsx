import LegalLinks from "@/components/LegalLinks";
import { brandVars } from "@/lib/theme";

// /verify/<id> with nothing to verify answers 404 (batch 6 N2), with the same
// explanation the page used to show at 200. Rendered by the root not-found
// (WA-02: a dead verify link is sent to /not-found/verify/<id>).
export default function VerifyNotFound() {
  return (
    <main
      className="grain brand-glow relative flex min-h-[100dvh] flex-col items-center justify-center px-5 py-10"
      style={brandVars("#6366f1")}
    >
      <div className="relative z-[1] w-full max-w-md">
        <div className="card rounded-[1.75rem] p-8 text-center">
          <div className="text-5xl">🔍</div>
          <h1 className="mt-4 font-[family-name:var(--font-display)] text-xl font-extrabold text-ink">
            Nothing to verify
          </h1>
          <p className="mt-3 text-sm text-muted text-pretty">
            We couldn&rsquo;t find a verifiable spin for this link. It may be an
            older spin recorded before fairness commitments, or the link is
            invalid.
          </p>
        </div>
      </div>
      <footer className="relative z-[1] mt-8 text-xs tracking-wide text-muted">
        Powered by FanFunnel · provably-fair spins
      </footer>
      <LegalLinks className="relative z-[1] mt-2" />
    </main>
  );
}
