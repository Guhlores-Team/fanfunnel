import { ImageResponse } from "next/og";
import { headers } from "next/headers";
import { getShareCard } from "@/lib/data";
import { publicGameCopy } from "@/lib/games/publicCopy";
import { clientIpFromHeaders } from "@/lib/api/clientIp";
import { ROUTE_TIERS } from "@/lib/api/routeTiers";
import { rateLimitShared } from "@/lib/rateLimit";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const dynamic = "force-dynamic";

const RARITY_LABEL: Record<string, string> = {
  common: "Common",
  uncommon: "Uncommon",
  rare: "Rare",
  epic: "Epic",
  legendary: "Legendary",
};

export default async function Image({
  params,
}: {
  params: Promise<{ shareId: string }>;
}) {
  const { shareId } = await params;
  // WA-04: rendering a 1200×630 PNG is costly work, capped per address like
  // the other costly routes (the image route gets no Request, hence headers()).
  const { limit, windowMs } = ROUTE_TIERS.costly;
  const gate = await rateLimitShared(`route:share-og:GET:${clientIpFromHeaders(await headers())}`, limit, windowMs);
  if (!gate.ok) {
    return new Response(null, { status: 429, headers: { "Retry-After": String(Math.ceil(gate.retryAfter / 1000)), "Cache-Control": "no-store" } });
  }
  const card = await getShareCard(shareId);
  // WA-04: a dead share link unfurls as nothing, not as a placeholder prize card.
  if (!card) return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
  const color = card.color;
  const label = card.prizeLabel;
  const rarity = RARITY_LABEL[card.rarity] ?? card.rarity;
  const creator = card.creatorTitle;

  return new ImageResponse(
    (
      <div
        style={{
          height: "100%",
          width: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          background: "#0c0a0e",
          color: "#f4f1f6",
          fontFamily: "sans-serif",
        }}
      >
        <div
          style={{
            position: "absolute",
            width: 700,
            height: 700,
            borderRadius: 9999,
            background: color,
            opacity: 0.28,
            filter: "blur(120px)",
          }}
        />
        <div style={{ display: "flex", fontSize: 26, letterSpacing: 4, opacity: 0.7, textTransform: "uppercase" }}>
          {creator}
        </div>
        <div
          style={{
            display: "flex",
            marginTop: 28,
            padding: "10px 28px",
            borderRadius: 9999,
            background: color,
            color: "#fff",
            fontSize: 28,
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: 3,
          }}
        >
          {rarity}
        </div>
        <div style={{ display: "flex", marginTop: 40, fontSize: 88, fontWeight: 800, maxWidth: 1000, textAlign: "center" }}>
          {label}
        </div>
        <div style={{ display: "flex", marginTop: 36, fontSize: 30, opacity: 0.6 }}>
          {publicGameCopy(card.gameKind).ogFooter}
        </div>
      </div>
    ),
    size
  );
}
