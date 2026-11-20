import type { Metadata } from "next";
import NotFoundView from "@/components/NotFoundView";
import LinkDataRescue from "@/components/fan/LinkDataRescue";
import VerifyNotFound from "@/components/fan/VerifyNotFound";
import LinkAttemptsBlocked from "@/components/fan/LinkAttemptsBlocked";
import NotFoundKinds from "@/components/fan/NotFoundKinds";

// The branded 404. Dead fan links (spin/[token]), share cards, verify links
// and creator pages are sent here through an unmatched path (WA-02,
// src/lib/fan/linkNotFound.ts), which is the one render that gives both a
// 404 status and server-rendered markup. This page is STATIC on purpose: Next
// serialises it into every page as its not-found boundary, so a request API
// here would turn the cached creator page into a runtime error. All three
// explanations are in the markup; the URL fragment shows the right one
// without script (globals.css, .nf-kind) and the path does after hydration.
// Any unmatched route lands here too. Never indexed, never installable
// (WA-06/WA-11), and never the creator-marketing description (WA-07).
export const metadata: Metadata = {
  title: "Link not found · FanFunnel",
  description: "This link isn't active. It may be switched off or mistyped.",
  robots: { index: false, follow: false },
  manifest: null,
};

export default function NotFound() {
  return (
    <NotFoundKinds>
      {/* A fan link that doesn't open (paused, blocked, switched off or
          unknown), a share card or a creator page: the branded 404, plus the
          fan's "Download / Delete my data" controls (LinkDataRescue reads the
          token from the address and renders nothing for any other path). */}
      <section id="nf-link" className="nf-kind nf-default">
        <NotFoundView>
          <LinkDataRescue />
        </NotFoundView>
      </section>
      <section id="nf-verify" className="nf-kind">
        <VerifyNotFound />
      </section>
      <section id="nf-busy" className="nf-kind">
        <LinkAttemptsBlocked />
      </section>
    </NotFoundKinds>
  );
}
