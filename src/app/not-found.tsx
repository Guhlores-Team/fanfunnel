import type { Metadata } from "next";
import { headers } from "next/headers";
import NotFoundView from "@/components/NotFoundView";
import LinkDataRescue from "@/components/fan/LinkDataRescue";
import VerifyNotFound from "@/components/fan/VerifyNotFound";
import LinkAttemptsBlocked from "@/components/fan/LinkAttemptsBlocked";
import { isNotFoundKind, NOT_FOUND_KIND_HEADER, NOT_FOUND_RETRY_HEADER } from "@/lib/fan/linkNotFound";

// The branded 404. Dead fan links (spin/[token]), share cards, verify links
// and creator pages are sent here through an unmatched path (WA-02,
// src/lib/fan/linkNotFound.ts), which is the one render that gives both a
// 404 status and server-rendered markup; the proxy says which kind it was.
// Any unmatched route lands here too. Never indexed, never installable
// (WA-06/WA-11), and never the creator-marketing description (WA-07).
export const metadata: Metadata = {
  title: "Link not found · FanFunnel",
  description: "This link isn't active. It may be switched off or mistyped.",
  robots: { index: false, follow: false },
  manifest: null,
};

export default async function NotFound() {
  const h = await headers();
  const raw = h.get(NOT_FOUND_KIND_HEADER);
  const kind = isNotFoundKind(raw) ? raw : null;
  if (kind === "verify") return <VerifyNotFound />;
  if (kind === "busy") return <LinkAttemptsBlocked retrySeconds={Number(h.get(NOT_FOUND_RETRY_HEADER) ?? "") || null} />;
  // A fan link that doesn't open (paused, blocked, switched off or unknown):
  // the same branded 404, plus the fan's "Download / Delete my data" controls
  // (LinkDataRescue reads the token from the address and renders nothing
  // for any other path).
  return (
    <NotFoundView>
      <LinkDataRescue />
    </NotFoundView>
  );
}
