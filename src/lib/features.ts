// The catalog of games/features the admin can grant per creator account.
// "wheel" is the base product (always on); others unlock as we build them.
export interface FeatureDef {
  key: string;
  label: string;
  emoji: string;
  base: boolean; // base features are always enabled and can't be toggled off
  comingSoon?: boolean;
}

export const FEATURES: FeatureDef[] = [
  { key: "wheel", label: "Prize Wheel", emoji: "🎡", base: true },
  { key: "scratch", label: "Scratch Tickets", emoji: "🎫", base: false, comingSoon: true },
  { key: "bingo", label: "Bingo", emoji: "🔢", base: false, comingSoon: true },
];

/** Default feature set granted to a new creator. */
export function defaultFeatures(): Record<string, boolean> {
  const f: Record<string, boolean> = {};
  for (const def of FEATURES) f[def.key] = def.base;
  return f;
}
