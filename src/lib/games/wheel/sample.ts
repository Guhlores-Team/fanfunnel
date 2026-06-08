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

/**
 * True when a wheel is still the untouched starter (ignoring ids).
 *
 * New creators are bootstrapped with a *copy* of SAMPLE_WHEEL that gets a fresh
 * wheel id and fresh prize ids, so the starter can't be recognised by id — the
 * old `id === "demo-wheel"` check only ever held in the in-memory mock. Compare
 * the meaningful content instead, so the "Build your prize wheel" onboarding
 * step stays incomplete until the creator actually customizes it.
 */
export function isStarterWheel(wheel: WheelConfig): boolean {
  if (wheel.title !== SAMPLE_WHEEL.title) return false;
  if ((wheel.subtitle ?? "") !== (SAMPLE_WHEEL.subtitle ?? "")) return false;
  if ((wheel.brandColor ?? "") !== (SAMPLE_WHEEL.brandColor ?? "")) return false;
  if (wheel.prizes.length !== SAMPLE_WHEEL.prizes.length) return false;
  return wheel.prizes.every((p, i) => {
    const s = SAMPLE_WHEEL.prizes[i];
    return (
      p.label === s.label &&
      p.rarity === s.rarity &&
      p.weight === s.weight &&
      (p.emoji ?? "") === (s.emoji ?? "") &&
      (p.stock ?? null) === (s.stock ?? null) &&
      (p.color ?? "") === (s.color ?? "")
    );
  });
}
