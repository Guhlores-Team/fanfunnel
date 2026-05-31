import type { WheelConfig } from "./types";

/** The default starter wheel — used by the demo pass and the dashboard editor. */
export const SAMPLE_WHEEL: WheelConfig = {
  id: "demo-wheel",
  title: "Spin to Win 💖",
  subtitle: "Every spin wins something — chase the rare drops!",
  brandColor: "#ec4899",
  prizes: [
    { id: "p1", label: "Exclusive Selfie", rarity: "common", weight: 40, emoji: "🤳" },
    { id: "p2", label: "Custom Voice Note", rarity: "uncommon", weight: 22, emoji: "🎙️" },
    { id: "p3", label: "Personal Shoutout", rarity: "uncommon", weight: 18, emoji: "📣" },
    { id: "p4", label: "Behind-the-Scenes Set", rarity: "rare", weight: 10, emoji: "🎬" },
    { id: "p5", label: "10-min Video Call", rarity: "rare", weight: 6, emoji: "📞" },
    { id: "p6", label: "Signed Polaroid", rarity: "epic", weight: 3, emoji: "📸", stock: 5 },
    { id: "p7", label: "VIP Month Free", rarity: "legendary", weight: 1, emoji: "👑", stock: 1 },
  ],
};
