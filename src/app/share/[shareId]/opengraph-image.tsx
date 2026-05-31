import { ImageResponse } from "next/og";
import { getShareCard } from "@/lib/data";

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
  const card = await getShareCard(shareId);
  const color = card?.color ?? "#ec4899";
  const label = card?.prizeLabel ?? "A prize";
  const rarity = card ? RARITY_LABEL[card.rarity] ?? card.rarity : "";
  const creator = card?.creatorTitle ?? "FanFunnel";

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
          🎉 I just won this — every spin wins
        </div>
      </div>
    ),
    size
  );
}
