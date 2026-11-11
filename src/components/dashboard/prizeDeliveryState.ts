import type { WheelConfig } from "@/lib/games/wheel/types";
import type { PrizeDeliveryView } from "@/lib/rewards/config";

/** Only public editor metadata enters the wheel; never reward values or codes. */
export function applyPrizeDelivery(config: WheelConfig, view: PrizeDeliveryView): WheelConfig {
  if (!config.prizes.some((p) => p.id === view.prizeId)) return config;
  return {
    ...config,
    prizes: config.prizes.map((p) => p.id === view.prizeId ? {
      ...p,
      delivery: view.delivery,
      ...(view.delivery === "codes" ? { stock: view.codesLeft } : {}),
    } : p),
  };
}
