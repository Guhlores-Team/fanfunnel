import type { Metadata } from "next";
import NotFoundView from "@/components/NotFoundView";

// Branded 404 for dead/expired fan links (spin/[token], c/[slug], share/[shareId]
// all call notFound()) and any unmatched route.
export const metadata: Metadata = { title: "Link not found · FanFunnel" };

export default function NotFound() {
  return <NotFoundView />;
}
